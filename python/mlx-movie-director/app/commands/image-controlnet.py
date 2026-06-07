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
import sys
import time
from datetime import datetime, timezone

import mlx.core as mx
import mlx.nn as nn
import numpy as np

from app import config as cfg
from app.controlnet import load_controlnet, patchify_latent

_DEFAULT_REF_IMAGE = os.path.join(
    cfg.OUTPUT_DIR, "Z-image+Controlnet+V2.1-ref-image.png"
)
_DEFAULT_PROMPT = "背面拍摄，高清摄影。一个coser少女，她cos的是雷姆。"

# Union type index per preprocessor (4-dim indicator)
_UNION_TYPE = {
    "pose":     0,
    "depth":    1,
    "canny":    2,
    "hed":      3,
    "scribble": 4,
}


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
        choices=list(_UNION_TYPE.keys()),
        default="canny",
        help="ControlNet preprocessor: canny (built-in) or pose/depth/hed/scribble "
             "(use --skip-preprocess for external tools; default: canny)",
    )
    parser.add_argument(
        "--controlnet-strength", type=float, default=0.9, dest="controlnet_strength",
        help="ControlNet conditioning strength 0.0–1.0 (default: 0.9)",
    )
    parser.add_argument(
        "--skip-preprocess", action="store_true", default=False,
        help="Skip preprocessing — pass the reference image directly as control signal",
    )
    parser.add_argument(
        "--scale", type=int, default=None,
        help="Scale longest side of generated image to this resolution "
             "(default: match reference image size)",
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
    strength = getattr(args, "controlnet_strength", 0.9)
    skip_preprocess = getattr(args, "skip_preprocess", False)
    scale = getattr(args, "scale", None)
    steps = getattr(args, "steps", None) or 9
    seed = getattr(args, "seed", 42)

    if not os.path.exists(ref_image_path):
        print(f"ERROR: Reference image not found: {ref_image_path}", file=sys.stderr)
        print("  Pass --input-image PATH to specify a reference image.", file=sys.stderr)
        sys.exit(1)

    # ── Determine output dimensions ──────────────────────────────────────────
    with Image.open(ref_image_path) as img:
        src_w, src_h = img.size
    if scale is not None:
        if src_w >= src_h:
            out_w = scale
            out_h = max(8, round(src_h * scale / src_w / 8) * 8)
        else:
            out_h = scale
            out_w = max(8, round(src_w * scale / src_h / 8) * 8)
    else:
        out_w = (src_w // 8) * 8
        out_h = (src_h // 8) * 8

    print(f"  Ref image : {ref_image_path} ({src_w}×{src_h})")
    print(f"  Output    : {out_w}×{out_h}")
    print(f"  Prompt    : {prompt}")
    print(f"  ControlNet: {ctrl_type} (strength={strength})")
    print(f"  Steps/seed: {steps} / {seed}")

    # ── Preprocess reference image ───────────────────────────────────────────
    ctrl_pil = _load_and_preprocess(ref_image_path, ctrl_type, out_w, out_h, skip_preprocess)

    union_type = _UNION_TYPE.get(ctrl_type, 2)  # default to canny=2

    # ── VAE encode control image ─────────────────────────────────────────────
    print("[ControlNet] VAE encoding control image...", end=" ", flush=True)
    vae = _load_vae()
    ctrl_latent = _vae_encode(vae, ctrl_pil)   # [1, 16, H_lat, W_lat]
    del vae
    _gc()
    print(f"Done → {list(ctrl_latent.shape)}")

    # Patchify control latent once (static across all denoising steps)
    ctrl_patches = patchify_latent(ctrl_latent)   # [1, N, 64]

    # ── Generate with ControlNet ─────────────────────────────────────────────
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = f"controlnet_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}.png")

    pil_image = _generate(
        prompt=prompt,
        out_w=out_w,
        out_h=out_h,
        steps=steps,
        seed=seed,
        ctrl_patches=ctrl_patches,
        union_type=union_type,
        strength=strength,
    )

    pil_image.save(out_path)
    print(f"Saved: {out_path}")
    return [out_path]


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------

def _load_and_preprocess(path: str, ctrl_type: str, out_w: int, out_h: int,
                          skip: bool) -> "Image.Image":
    """Load and preprocess reference image. Returns PIL Image resized to (out_w, out_h)."""
    from PIL import Image
    img = Image.open(path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    if skip:
        print(f"[ControlNet] Preprocessing skipped — using raw image as control.")
        return img
    if ctrl_type == "canny":
        return _apply_canny(img)
    # For pose/depth/hed/scribble, instruct user to use --skip-preprocess
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
    import numpy as np
    img_np = np.array(pil_img.convert("RGB")).astype(np.float32) / 127.5 - 1.0
    img_mx = mx.array(img_np.transpose(2, 0, 1)[None]).astype(mx.bfloat16)  # [1, 3, H, W]
    encoded = vae.encode(img_mx)   # [1, 16, 1, H_lat, W_lat]
    if encoded.ndim == 5:
        encoded = encoded[:, :, 0, :, :]   # squeeze temporal → [1, 16, H_lat, W_lat]
    mx.eval(encoded)
    return encoded.astype(mx.bfloat16)


# ---------------------------------------------------------------------------
# Denoising loop with ControlNet injection
# ---------------------------------------------------------------------------

def _generate(prompt, out_w, out_h, steps, seed, ctrl_patches, union_type, strength) -> "Image.Image":
    """Run full denoising loop with ControlNet injection. Returns PIL Image."""
    from PIL import Image
    from transformers import AutoTokenizer
    from app.pipeline import (
        ZImageTransformerMLX,
        MLXFlowMatchEulerScheduler, create_coordinate_grid,
        calculate_shift, load_sharded_weights, _load_mlx_vae,
    )
    from app.text_encoder import TextEncoderMLX

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

    # ── Phase 3: Denoising with ControlNet ───────────────────────────────
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

    N_img = H_tok * W_tok
    # Slice image-token rope embeddings for ControlNet (same positions as noise tokens)
    cos_img = cos_cached[:, :N_img]   # [1, N_img, 1, 64]
    sin_img = sin_cached[:, :N_img]   # [1, N_img, 1, 64]

    for i in range(steps):
        step_start = time.time()
        t_curr = scheduler.timesteps[i]
        t_input = (1.0 - t_curr)[None].astype(mx.bfloat16)

        # Patchify current noise latent → raw patches
        x_patches = patchify_latent(latents)   # [1, N_img, 64]

        # Compute time embedding (matches what the transformer computes internally)
        temb = model.t_embedder(t_input * model.t_scale)   # [1, 256]

        # Run ControlNet → 15 residuals [1, N_img, 3840]
        ctrl_samples = controlnet(
            x_raw=x_patches,
            ctrl_raw=ctrl_patches,
            union_type=union_type,
            temb=temb,
            cos=cos_img,
            sin=sin_img,
            strength=strength,
        )
        mx.eval(ctrl_samples)

        # Run main transformer with controlnet injection
        B, C, H, W = latents.shape
        x_reshaped = latents.reshape(C, 1, 1, H_tok, 2, W_tok, 2).transpose(1, 2, 3, 5, 4, 6, 0).reshape(1, -1, C * 4)
        out = model(x_reshaped, t_input, cap_feats_mx, img_pos, cap_pos,
                    cos_cached, sin_cached, cap_mask=None,
                    controlnet_samples=ctrl_samples)
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
