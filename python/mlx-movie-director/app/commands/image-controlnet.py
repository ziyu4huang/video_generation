"""image-controlnet — Z-Image ControlNet generation (native MLX, no ComfyUI required).

Source: https://civitai.com/models/2192289/zimageturbo-controlnet-6g-vram-can-run-it?modelVersionId=2509261

Preprocessors supported:
  canny   — cv2.Canny edge detection (built-in, no extra model)
  raw     — pass control image directly without preprocessing (--skip-preprocess)

Preprocessors requiring external models (deferred):
  pose, depth, hed, scribble — use --skip-preprocess and run preprocessing externally

Public API:
  add_controlnet_args(parser)  — register ControlNet-specific CLI arguments
  run_controlnet(args)         — execute native MLX ControlNet generation
"""

import argparse
import gc
import json
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

import mlx.core as mx
import mlx.nn as nn
import numpy as np

from app import config as cfg
from app.controlnet import load_controlnet, build_control_input_33ch, _FLUX_SHIFT_FACTOR, _FLUX_SCALE_FACTOR

_DEFAULT_REF_IMAGE = os.path.join(
    cfg.OUTPUT_DIR, "Z-image+Controlnet+V2.1-ref-image.png"
)
_DEFAULT_PROMPT = "背面拍摄，高清摄影。一个coser少女，她cos的是雷姆。"

# A/B test variations: (label, strength, blur_sigma)
_AB_VARIATIONS = [
    ("A-str10",          1.0, None),
    ("B-str10-blur10",   1.0, 10.0),
    ("C-str06",          0.6, None),
    ("D-str06-blur10",   0.6, 10.0),
]


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

def add_controlnet_args(parser):
    """Register ControlNet-specific arguments (prompt/steps/seed come from common args)."""
    parser.add_argument(
        "--input-image", type=str, default=None, metavar="PATH",
        help=(
            "Reference image for ControlNet conditioning "
            "(default: output/Z-image+Controlnet+V2.1-ref-image.png)"
        ),
    )
    parser.add_argument(
        "--controlnet-type",
        choices=["canny"],
        default="canny",
        help="ControlNet preprocessor: canny (built-in, default: canny)",
    )
    parser.add_argument(
        "--controlnet-strength", type=float, default=1.0, dest="controlnet_strength",
        help="ControlNet conditioning strength (default: 1.0)",
    )
    parser.add_argument(
        "--skip-preprocess", action="store_true", default=False,
        help="Skip preprocessing — pass the reference image directly as control signal",
    )
    parser.add_argument(
        "--blur-ref", type=float, default=None, metavar="SIGMA",
        dest="blur_ref",
        help=(
            "Apply Gaussian blur (sigma) to the reference image before VAE encoding. "
            "Softens thick outlines (苗框線) into gradients that still convey pose "
            "but won't produce sharp line artifacts. Try values 5–20. "
            "Default (when flag omitted): no blur."
        ),
    )
    parser.add_argument(
        "--scale", type=int, default=None,
        help="Scale longest side of generated image to this resolution "
             "(default: match reference image size)",
    )
    parser.add_argument(
        "--controlnet-ab-test", action="store_true", default=False,
        dest="controlnet_ab_test",
        help=(
            "Run A/B test with 4 variations: strength 0.6/1.0 × blur-ref off/on(10). "
            "Opens manifest review HTML after completion."
        ),
    )
    # --server argument kept for backward compat but ignored (no ComfyUI needed)
    parser.add_argument(
        "--server", type=str, default=None,
        help=argparse.SUPPRESS,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_controlnet(args):
    """Execute native MLX ControlNet generation. Called by image.py dispatcher."""
    from PIL import Image

    prompt = getattr(args, "prompt", None) or _DEFAULT_PROMPT
    ref_image_path = getattr(args, "input_image", None) or _DEFAULT_REF_IMAGE
    ctrl_type = getattr(args, "controlnet_type", "canny")
    strength = getattr(args, "controlnet_strength", 1.0)
    skip_preprocess = getattr(args, "skip_preprocess", False)
    blur_ref = getattr(args, "blur_ref", None)
    scale = getattr(args, "scale", None)
    steps = getattr(args, "steps", None) or 9
    seed = getattr(args, "seed", 42)
    do_ab = getattr(args, "controlnet_ab_test", False)

    if not os.path.exists(ref_image_path):
        print(f"ERROR: Reference image not found: {ref_image_path}", file=sys.stderr)
        print("  Pass --input-image PATH to specify a reference image.", file=sys.stderr)
        sys.exit(1)

    # ── Determine output dimensions ──────────────────────────────────────────
    with Image.open(ref_image_path) as img:
        src_w, src_h = img.size
    # Dimensions must be divisible by 16: VAE divides by 8, then patchify divides by 2
    if scale is not None:
        if src_w >= src_h:
            out_w = (scale // 16) * 16
            out_h = max(16, (round(src_h * scale / src_w) // 16) * 16)
        else:
            out_h = (scale // 16) * 16
            out_w = max(16, (round(src_w * scale / src_h) // 16) * 16)
    else:
        out_w = (src_w // 16) * 16
        out_h = (src_h // 16) * 16

    if do_ab:
        _run_ab_test(
            prompt=prompt,
            ref_image_path=ref_image_path,
            ctrl_type=ctrl_type,
            skip_preprocess=skip_preprocess,
            out_w=out_w,
            out_h=out_h,
            steps=steps,
            seed=seed,
        )
        return

    # ── Single run ───────────────────────────────────────────────────────────
    run_file, manifest_file, out_path = _make_output_paths("controlnet")
    run_meta = _build_run_meta(
        prompt=prompt,
        ref_image_path=ref_image_path,
        ctrl_type=ctrl_type,
        strength=strength,
        skip_preprocess=skip_preprocess,
        blur_ref=blur_ref,
        steps=steps,
        seed=seed,
        out_w=out_w,
        out_h=out_h,
        scale=scale,
    )
    _write_json(run_file, run_meta)

    print(f"  Ref image : {ref_image_path} ({src_w}×{src_h})")
    print(f"  Output    : {out_w}×{out_h}")
    print(f"  Prompt    : {prompt}")
    print(f"  ControlNet: {ctrl_type} (strength={strength})")
    print(f"  Steps/seed: {steps} / {seed}")
    print(f"Run config : {run_file}")

    start_time = datetime.now(timezone.utc).isoformat()
    last_timings = {}

    try:
        pil_image = _execute_generation(
            prompt=prompt,
            ref_image_path=ref_image_path,
            ctrl_type=ctrl_type,
            strength=strength,
            skip_preprocess=skip_preprocess,
            blur_ref=blur_ref,
            out_w=out_w,
            out_h=out_h,
            steps=steps,
            seed=seed,
        )

        pil_image.save(out_path)
        print(f"Saved: {out_path}")

        end_time = datetime.now(timezone.utc).isoformat()
        output_files = [{
            "path": out_path,
            "seed": seed,
            "size_bytes": os.path.getsize(out_path),
            "width": pil_image.width,
            "height": pil_image.height,
        }]

        from app.manifest import Manifest, collect_model_fingerprint_controlnet
        models = collect_model_fingerprint_controlnet()
        manifest = Manifest.from_success(
            run_file, start_time, end_time, last_timings, output_files, models
        )
        manifest.to_json(manifest_file)
        print(f"Manifest:   {manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        from app.manifest import Manifest
        manifest = Manifest.from_error(run_file, start_time, end_time, last_timings, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)

    return [out_path]


# ---------------------------------------------------------------------------
# A/B test runner
# ---------------------------------------------------------------------------

def _run_ab_test(prompt, ref_image_path, ctrl_type, skip_preprocess,
                 out_w, out_h, steps, seed):
    """Run 4 ControlNet variations and open manifest review HTML."""
    from app.manifest import Manifest, collect_model_fingerprint_controlnet

    manifest_files = []

    for label, strength, blur_ref in _AB_VARIATIONS:
        print(f"\n{'=' * 60}")
        blur_desc = f"blur_ref={blur_ref}" if blur_ref else "no blur"
        print(f"A/B Test — {label}  (strength={strength}, {blur_desc})")
        print(f"{'=' * 60}")

        run_file, manifest_file, out_path = _make_output_paths(
            f"controlnet_{label}"
        )
        run_meta = _build_run_meta(
            prompt=prompt,
            ref_image_path=ref_image_path,
            ctrl_type=ctrl_type,
            strength=strength,
            skip_preprocess=skip_preprocess,
            blur_ref=blur_ref,
            steps=steps,
            seed=seed,
            out_w=out_w,
            out_h=out_h,
        )
        _write_json(run_file, run_meta)
        print(f"Run config : {run_file}")

        start_time = datetime.now(timezone.utc).isoformat()
        last_timings = {}

        try:
            pil_image = _execute_generation(
                prompt=prompt,
                ref_image_path=ref_image_path,
                ctrl_type=ctrl_type,
                strength=strength,
                skip_preprocess=skip_preprocess,
                blur_ref=blur_ref,
                out_w=out_w,
                out_h=out_h,
                steps=steps,
                seed=seed,
            )

            pil_image.save(out_path)
            print(f"Saved: {out_path}")

            end_time = datetime.now(timezone.utc).isoformat()
            output_files = [{
                "path": out_path,
                "seed": seed,
                "size_bytes": os.path.getsize(out_path),
                "width": pil_image.width,
                "height": pil_image.height,
            }]

            models = collect_model_fingerprint_controlnet()
            manifest = Manifest.from_success(
                run_file, start_time, end_time, last_timings, output_files, models
            )
            manifest.to_json(manifest_file)
            print(f"Manifest:   {manifest_file}")
            manifest_files.append(manifest_file)

        except Exception as exc:
            end_time = datetime.now(timezone.utc).isoformat()
            manifest = Manifest.from_error(
                run_file, start_time, end_time, last_timings, exc, {}
            )
            manifest.to_json(manifest_file)
            print(f"ERROR in {label}: {type(exc).__name__}: {exc}", file=sys.stderr)
            traceback.print_exc()
            manifest_files.append(manifest_file)

    # Open manifest review HTML
    if manifest_files:
        import importlib
        _review_mod = importlib.import_module("app.commands.image-review")
        _open_manifest_review = _review_mod._open_manifest_review
        labels = [v[0] for v in _AB_VARIATIONS]
        _open_manifest_review(manifest_files, labels=labels)


# ---------------------------------------------------------------------------
# Core generation (shared by single run + A/B test)
# ---------------------------------------------------------------------------

def _execute_generation(prompt, ref_image_path, ctrl_type, strength,
                        skip_preprocess, blur_ref,
                        out_w, out_h, steps, seed) -> "Image.Image":
    """Run the full ControlNet pipeline. Returns PIL Image."""
    # ── Preprocess reference image ───────────────────────────────────────────
    ctrl_pil = _load_and_preprocess(
        ref_image_path, ctrl_type, out_w, out_h, skip_preprocess, blur_ref
    )

    # ── VAE encode control image ─────────────────────────────────────────────
    print("[ControlNet] VAE encoding control image...", end=" ", flush=True)
    vae = _load_vae()
    ctrl_latent = _vae_encode(vae, ctrl_pil)   # [1, 16, H_lat, W_lat]
    # Apply Flux latent format (matches ComfyUI latent_formats.Flux.process_in)
    ctrl_latent = (ctrl_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR

    # Build 33-channel input: [ctrl_latent(16), mask(1), inpaint_latent(16)]
    ctrl_33ch = build_control_input_33ch(ctrl_latent, lambda img: _vae_encode(vae, img))
    del vae
    _gc()
    print(f"Done → control input {list(ctrl_33ch.shape)}")

    # ── Generate with ControlNet ─────────────────────────────────────────────
    return _generate(
        prompt=prompt,
        out_w=out_w,
        out_h=out_h,
        steps=steps,
        seed=seed,
        ctrl_33ch=ctrl_33ch,
        strength=strength,
    )


# ---------------------------------------------------------------------------
# Output path / metadata helpers
# ---------------------------------------------------------------------------

def _make_output_paths(base_name):
    """Return (run_file, manifest_file, output_png) for a given base name."""
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    run_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.run.json")
    manifest_file = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.manifest.json")
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.png")
    return run_file, manifest_file, out_path


def _build_run_meta(prompt, ref_image_path, ctrl_type, strength,
                    skip_preprocess, blur_ref, steps, seed,
                    out_w, out_h, scale=None):
    """Build run.json metadata dict."""
    return {
        "command": "image",
        "action": "controlnet",
        "input_image": ref_image_path,
        "controlnet_type": ctrl_type,
        "controlnet_strength": strength,
        "skip_preprocess": skip_preprocess,
        "blur_ref": blur_ref,
        "prompt": prompt,
        "steps": steps,
        "seed": seed,
        "width": out_w,
        "height": out_h,
        "scale": scale,
    }


def _write_json(path, data):
    """Write JSON with trailing newline."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------

def _load_and_preprocess(path: str, ctrl_type: str, out_w: int, out_h: int,
                          skip: bool, blur_ref: float | None = None) -> "Image.Image":
    """Load and preprocess reference image. Returns PIL Image resized to (out_w, out_h)."""
    from PIL import Image
    img = Image.open(path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    if skip:
        if blur_ref is not None:
            print(f"[ControlNet] Applying Gaussian blur (sigma={blur_ref})...")
            img = _blur_ref_image(img, blur_ref)
        blur_desc = f"blur={blur_ref}" if blur_ref else "raw"
        print(f"[ControlNet] Preprocessing skipped — using {blur_desc} image as control.")
        return img
    if ctrl_type == "canny":
        return _apply_canny(img)
    print(
        f"[ControlNet] WARNING: preprocessor '{ctrl_type}' requires an external model. "
        f"Using raw image as fallback (run with --skip-preprocess to silence this warning).",
        file=sys.stderr,
    )
    return img


def _apply_canny(pil_img: "Image.Image") -> "Image.Image":
    """Apply Canny edge detection using cv2."""
    from PIL import Image
    try:
        import cv2
    except ImportError:
        print("[ControlNet] cv2 not available — using raw image instead of Canny.", file=sys.stderr)
        return pil_img
    import numpy as np
    gray = np.array(pil_img.convert("L"))
    edges = cv2.Canny(gray, threshold1=100, threshold2=200)
    # 3-channel so VAE expects RGB
    edges_rgb = np.stack([edges] * 3, axis=-1)
    return Image.fromarray(edges_rgb)


def _blur_ref_image(pil_img: "Image.Image", sigma: float) -> "Image.Image":
    """Apply Gaussian blur to soften thick outlines (苗框線) in the reference image.

    Softens the image into gradients that still convey pose/composition
    but won't produce sharp line artifacts in the ControlNet output.
    Higher sigma = more blur = less outline influence.
    """
    from PIL import ImageFilter
    # PIL GaussianBlur radius ≈ sigma * 2 for similar effect
    radius = max(1, int(sigma))
    blurred = pil_img.filter(ImageFilter.GaussianBlur(radius=radius))
    return blurred


# ---------------------------------------------------------------------------
# VAE utilities
# ---------------------------------------------------------------------------

def _load_vae():
    """Load MLX-native ZImage VAE."""
    _add_mflux_to_path()
    from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE
    vae = ZImageVAE()
    vae.load_weights(os.path.join(cfg.VAE_DIR, "model.safetensors"))
    mx.eval(vae.parameters())
    return vae


def _vae_encode(vae, pil_img: "Image.Image") -> mx.array:
    """Encode PIL image → latent [1, 16, H//8, W//8]."""
    from PIL import Image
    import numpy as np
    # Handle both PIL Image and numpy array input
    if isinstance(pil_img, Image.Image):
        img_np = np.array(pil_img.convert("RGB")).astype(np.float32) / 127.5 - 1.0
    else:
        img_np = np.array(pil_img).astype(np.float32) / 127.5 - 1.0
    # Ensure H, W are multiples of 8
    h, w = img_np.shape[:2]
    h8 = (h // 8) * 8
    w8 = (w // 8) * 8
    if h8 != h or w8 != w:
        img_np = img_np[:h8, :w8]
    img_mx = mx.array(img_np.transpose(2, 0, 1)[None]).astype(mx.bfloat16)  # [1, 3, H, W]
    encoded = vae.encode(img_mx)   # [1, 16, 1, H_lat, W_lat]
    if encoded.ndim == 5:
        encoded = encoded[:, :, 0, :, :]   # squeeze temporal → [1, 16, H_lat, W_lat]
    mx.eval(encoded)
    return encoded.astype(mx.bfloat16)


# ---------------------------------------------------------------------------
# Denoising loop with ControlNet injection (interleaved)
# ---------------------------------------------------------------------------

def _generate(prompt, out_w, out_h, steps, seed, ctrl_33ch, strength) -> "Image.Image":
    """Run full denoising loop with interleaved ControlNet. Returns PIL Image."""
    from PIL import Image
    from transformers import AutoTokenizer
    from app.pipeline import (
        ZImageTransformerMLX,
        MLXFlowMatchEulerScheduler, create_coordinate_grid,
        calculate_shift, load_sharded_weights, _load_mlx_vae,
    )
    from app.text_encoder import TextEncoderMLX
    from app.controlnet import patchify_latent

    print("[ControlNet] Loading ControlNet weights...")
    controlnet = load_controlnet(cfg.CONTROLNET_DIR)

    # ── Phase 1: Text encoding ────────────────────────────────────────────
    print("[Phase 1] Text encoding...", end=" ", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(cfg.TOKENIZER_DIR, trust_remote_code=True)
    with open(os.path.join(cfg.TEXT_ENCODER_DIR, "config.json")) as f:
        te_config = json.load(f)
    text_encoder = TextEncoderMLX(te_config)
    nn.quantize(text_encoder, bits=4, group_size=32)
    text_encoder.load_weights(os.path.join(cfg.TEXT_ENCODER_DIR, "model.safetensors"))
    mx.eval(text_encoder)

    messages = [{"role": "user", "content": prompt}]
    try:
        prompt_fmt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        prompt_fmt = prompt
    inputs = tokenizer(prompt_fmt, padding="max_length", max_length=512, truncation=True, return_tensors="np")
    prompt_embeds = text_encoder(mx.array(inputs["input_ids"]))
    mx.eval(prompt_embeds)

    cap_feats_np = np.array(prompt_embeds)
    pad = (-cap_feats_np.shape[1]) % 32
    if pad > 0:
        cap_feats_np = np.concatenate([cap_feats_np, np.repeat(cap_feats_np[:, -1:, :], pad, axis=1)], axis=1)
    cap_feats_mx = mx.array(cap_feats_np).astype(mx.bfloat16)
    del text_encoder, tokenizer
    _gc()
    print("Done")

    # ── Phase 2: Transformer loading ─────────────────────────────────────
    print("[Phase 2] Loading transformer (4-bit)...", end=" ", flush=True)
    with open(os.path.join(cfg.TRANSFORMER_DIR, "config.json")) as f:
        t_config = json.load(f)
    model = ZImageTransformerMLX(t_config)
    nn.quantize(model, bits=4, group_size=32)
    if os.path.exists(os.path.join(cfg.TRANSFORMER_DIR, "model.safetensors.index.json")):
        weights = load_sharded_weights(cfg.TRANSFORMER_DIR)
        model.load_weights(list(weights.items()))
        del weights
    else:
        model.load_weights(os.path.join(cfg.TRANSFORMER_DIR, "model.safetensors"))
    model.fuse_model()
    model.eval()
    _gc()
    print("Done")

    # ── Phase 2.5: Embed control context ─────────────────────────────────
    print("[Phase 2.5] Embedding control context...", end=" ", flush=True)
    controlnet_context = controlnet.embed_control(ctrl_33ch)  # [1, N, 3840]
    mx.eval(controlnet_context)
    print(f"Done → {list(controlnet_context.shape)}")

    # ── Phase 3: Denoising with interleaved ControlNet ────────────────────
    print("[Phase 3] Denoising with ControlNet...")
    scheduler = MLXFlowMatchEulerScheduler(shift=3.0, use_dynamic_shifting=True)
    if seed is not None:
        np.random.seed(seed)

    noise = mx.array(np.random.randn(1, 16, out_h // 8, out_w // 8)).astype(mx.bfloat16)
    _, C_lat, H_lat, W_lat = noise.shape
    H_tok, W_tok = H_lat // 2, W_lat // 2
    mu = calculate_shift(H_tok * W_tok)
    scheduler.set_timesteps(steps, mu=mu)
    latents = noise

    total_len = cap_feats_mx.shape[1]
    img_pos = mx.array(
        create_coordinate_grid((1, H_tok, W_tok), (total_len + 1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    cap_pos = mx.array(
        create_coordinate_grid((total_len, 1, 1), (1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    unified_pos_all = mx.concatenate([img_pos, cap_pos], axis=1)
    cos_cached, sin_cached = model.prepare_rope(unified_pos_all)
    cos_cached = cos_cached.astype(mx.bfloat16)
    sin_cached = sin_cached.astype(mx.bfloat16)

    for i in range(steps):
        step_start = time.time()
        t_curr = scheduler.timesteps[i]
        t_input = (1.0 - t_curr)[None].astype(mx.bfloat16)

        # Re-embed control context for each step (ControlNet needs fresh context)
        # Note: the control image doesn't change, so we reuse the embedded context
        # But the noise latent changes, so we need to re-embed for each step
        step_controlnet_context = controlnet.embed_control(ctrl_33ch)

        # Run main transformer with interleaved ControlNet
        B, C, H, W = latents.shape
        x_reshaped = latents.reshape(C, 1, 1, H_tok, 2, W_tok, 2).transpose(1, 2, 3, 5, 4, 6, 0).reshape(1, -1, C * 4)
        out = model(x_reshaped, t_input, cap_feats_mx, img_pos, cap_pos,
                    cos_cached, sin_cached, cap_mask=None,
                    controlnet_model=controlnet,
                    controlnet_context=step_controlnet_context,
                    controlnet_strength=strength)
        noise_pred = -out.reshape(1, 1, H_tok, W_tok, 2, 2, C).transpose(6, 0, 1, 2, 4, 3, 5).reshape(1, C, H, W)

        latents = scheduler.step(noise_pred, i, latents)
        mx.eval(latents)
        print(f"   Step {i + 1}/{steps}: {time.time() - step_start:.2f}s")

    # ── Phase 4: Decode ───────────────────────────────────────────────────
    print("[Phase 4] Decoding...", end=" ", flush=True)
    del model, controlnet, cos_cached, sin_cached
    _gc()

    vae_dec = _load_mlx_vae()
    decoded = vae_dec.decode(latents.astype(mx.bfloat16))
    if decoded.ndim == 5:
        decoded = decoded[:, :, 0, :, :]
    image_np = np.array(mx.clip(decoded.astype(mx.float32) / 2.0 + 0.5, 0, 1))
    image_np = np.nan_to_num(image_np, nan=0.0, posinf=1.0, neginf=0.0)
    image_np = image_np[0].transpose(1, 2, 0)
    pil_image = Image.fromarray((image_np * 255).round().astype("uint8"))
    del vae_dec, decoded
    _gc()
    print("Done")
    return pil_image


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _add_mflux_to_path():
    here = os.path.dirname(os.path.abspath(__file__))
    vendor = os.path.join(here, "..", "..", "vendor", "mflux", "src")
    if os.path.isdir(vendor) and vendor not in sys.path:
        sys.path.insert(0, vendor)


def _gc():
    if hasattr(mx, "clear_cache"):
        mx.clear_cache()
    gc.collect()
