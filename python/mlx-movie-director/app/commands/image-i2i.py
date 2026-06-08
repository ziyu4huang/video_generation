"""image-i2i — Image-to-Image with optional ControlNet (native MLX).

Supports two pipelines:
  - Z-Image Turbo: default pipeline with ControlNet support
  - Flux2 Klein: LoRA-based I2I (no ControlNet)

Modes (Z-Image only):
  1. Simple I2I: transform an input image via denoise-strength mixing
  2. I2I + ControlNet: transform input image while following a reference pose/environment

Inspired by the Moody I2I workflow (CivitAI #2444491).

Public API:
  add_i2i_args(parser)  — register I2I-specific CLI arguments
  run_i2i(args)         — execute I2I generation
"""

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
from app.commands._shared import _arg_registered, _option_registered
from app.controlnet import (
    load_controlnet, build_control_input_33ch,
    _FLUX_SHIFT_FACTOR, _FLUX_SCALE_FACTOR,
)

_DEFAULT_PROMPT = (
    "A young woman standing in a simple pose, facing the camera, wearing "
    "casual clothes, clean white background, studio lighting, high quality "
    "portrait photography."
)

# Self-test: source image — Asian woman in neutral standing pose (I-shaped).
# Deliberately different ethnicity from reference so identity transfer is testable.
_I2I_SOURCE_PROMPT = (
    "A young Asian woman with straight black hair, standing naturally facing the "
    "camera, arms relaxed at her sides, straight posture, wearing a simple white "
    "t-shirt and blue jeans, clean white background, studio lighting, full body "
    "visible, high quality portrait photography."
)

# Self-test: reference image — Caucasian woman in a DRAMATICALLY DIFFERENT pose.
# The reference must differ from the source in BOTH pose AND appearance (ethnicity,
# hair color) so ControlNet enforcement and identity bleed are clearly testable.
# Victory V-pose = arms raised high, very different from source's "arms at sides".
_I2I_REF_POSE_PROMPT = (
    "A young Caucasian woman with blonde curly hair, in a triumphant victory "
    "celebration pose, both arms raised high in a V-shape above the head, legs "
    "shoulder-width apart, energetic and joyful expression, wearing athletic "
    "clothing, clean white background, studio lighting, full body visible, "
    "high quality photography."
)

# Self-test: I2I transformation prompt — style only, NO pose description.
# Pose comes from source (simple I2I) or reference (I2I+ControlNet).
_I2I_SELF_TEST_PROMPT = (
    "A young woman, oil painting style, warm golden lighting, classical portraiture, "
    "rich brushstrokes, museum quality painting."
)

# Self-test variations:
#   (label, denoise_strength, ctrl_strength_or_None, blur_ref_or_None,
#    cnet_active_steps_or_None, steps)
_I2I_SELF_TEST_VARIATIONS = [
    # Row 1: Simple I2I — denoise_strength sweep (no ControlNet)
    ("dn02-9st",           0.2, None,  None, None, 9),   # Light polish
    ("dn04-9st",           0.4, None,  None, None, 9),   # Controlled restyle
    ("dn06-9st",           0.6, None,  None, None, 9),   # Bold reinterpretation
    ("dn08-9st",           0.8, None,  None, None, 9),   # Near-full redraw

    # Row 2: I2I + ControlNet — increasing denoise (source anchor weakens)
    ("dn04-cnet-9st",      0.4, 0.6, 5.0, None, 9),     # Source anchor strong
    ("dn06-cnet-9st",      0.6, 0.6, 5.0, None, 9),     # Source anchor moderate
    ("dn08-cnet-9st",      0.8, 0.6, 5.0, None, 9),     # Source anchor weak

    # Row 3: Full redraw + ControlNet (smoking gun — verifies ControlNet itself works)
    # denoise=1.0 = pure noise, no source influence. If V-pose appears → CN works.
    # If no V-pose → ControlNet itself is broken.
    ("dn10-cnet-15st-a5",  1.0, 0.6, 5.0, 5,   15),     # Full redraw + dual-sampler
]


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

def add_i2i_args(parser):
    """Register I2I-specific arguments."""
    # --input-image is already registered by add_controlnet_args() with dest="input_image"
    # We reuse it for I2I source image.
    parser.add_argument(
        "--reference-image", type=str, default=None, metavar="PATH",
        dest="reference_image",
        help=(
            "ControlNet reference image for pose/environment guidance. "
            "When provided, ControlNet conditioning is enabled."
        ),
    )
    # --denoise-strength may be registered by _shared.py; override default for I2I
    if not _arg_registered(parser, "denoise_strength"):
        parser.add_argument(
            "--denoise-strength", type=float, default=0.4, dest="denoise_strength",
            help="How much to change from source (0.0=keep, 1.0=redraw, default: 0.4)",
        )
    # --controlnet-strength already registered by add_controlnet_args()
    # --skip-preprocess, --blur-ref, --cnet-active-steps, --scale already registered
    # No additional args needed — i2i reuses these shared flags.


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_i2i(args):
    """Execute I2I generation. Called by image.py dispatcher."""
    # Self-test mode (Z-Image only for now)
    if getattr(args, "self_test", False):
        _run_self_test(args)
        return

    pipeline_type = getattr(args, "pipeline", "zimage")

    # --- Flux2-Klein I2I: delegate to shared execute_generation ---
    if pipeline_type == "flux2-klein":
        _run_flux2_klein_i2i(args)
        return

    # --- Z-Image I2I: native implementation with ControlNet ---
    from PIL import Image

    input_image_path = getattr(args, "input_image", None)
    ref_image_path = getattr(args, "reference_image", None)
    prompt = getattr(args, "prompt", None) or _DEFAULT_PROMPT
    denoise_strength = getattr(args, "denoise_strength", 0.4)
    ctrl_strength = getattr(args, "controlnet_strength", 0.6)
    skip_preprocess = getattr(args, "skip_preprocess", False)
    blur_ref = getattr(args, "blur_ref", None)
    scale = getattr(args, "scale", None)
    seed = getattr(args, "seed", 42)
    steps = getattr(args, "steps", 9)
    cnet_active_steps = getattr(args, "cnet_active_steps", None)

    if not input_image_path:
        print("ERROR: --input-image is required for I2I mode.", file=sys.stderr)
        print("  Usage: run.py image i2i --input-image photo.jpg --prompt '...' --denoise-strength 0.4",
              file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(input_image_path):
        print(f"ERROR: Input image not found: {input_image_path}", file=sys.stderr)
        sys.exit(1)

    # ── Determine output dimensions from source image ──────────────────────
    with Image.open(input_image_path) as img:
        src_w, src_h = img.size
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

    # ── VAE encode source image → clean_latent ────────────────────────────
    print(f"[I2I] Loading source image: {input_image_path}")
    source_img = Image.open(input_image_path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    vae = _load_vae()
    print("[I2I] VAE encoding source image...", end=" ", flush=True)
    clean_latent = _vae_encode(vae, source_img)
    # Apply Flux latent format normalization
    clean_latent = (clean_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR
    print(f"Done → latent {list(clean_latent.shape)}")

    # ── Optional: VAE encode reference for ControlNet ──────────────────────
    ctrl_33ch = None
    if ref_image_path:
        if not os.path.exists(ref_image_path):
            print(f"ERROR: Reference image not found: {ref_image_path}", file=sys.stderr)
            sys.exit(1)
        print(f"[I2I] Loading ControlNet reference: {ref_image_path}")
        ref_pil = _load_and_preprocess(
            ref_image_path, out_w, out_h, skip_preprocess,
            blur_ref=blur_ref,
        )
        print("[I2I] VAE encoding ControlNet reference...", end=" ", flush=True)
        ctrl_latent = _vae_encode(vae, ref_pil)
        ctrl_latent = (ctrl_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR
        ctrl_33ch = build_control_input_33ch(ctrl_latent, lambda img: _vae_encode(vae, img))
        print(f"Done → control input {list(ctrl_33ch.shape)}")

    del vae
    _gc()

    # ── Generate ───────────────────────────────────────────────────────────
    out_label = f"i2i_dn{denoise_strength}"
    if ctrl_33ch is not None:
        out_label += f"_cnet{ctrl_strength}"
        if blur_ref is not None:
            out_label += f"_blur{blur_ref:.0f}"
        if cnet_active_steps is not None:
            out_label += f"_act{cnet_active_steps}"
    out_label += f"_{steps}st-s{seed}"

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(cfg.OUTPUT_DIR, f"{out_label}.png")

    print(f"  Output    : {out_w}×{out_h}")
    print(f"  Denoise   : {denoise_strength}")
    print(f"  ControlNet: {'on (strength=' + str(ctrl_strength) + ')' if ctrl_33ch is not None else 'off'}")
    print(f"  Steps/seed: {steps} / {seed}")

    pil_image = _generate(
        prompt=prompt,
        out_w=out_w,
        out_h=out_h,
        steps=steps,
        seed=seed,
        clean_latent=clean_latent,
        denoise_strength=denoise_strength,
        ctrl_33ch=ctrl_33ch,
        controlnet_strength=ctrl_strength,
        cnet_active_steps=cnet_active_steps,
    )

    pil_image.save(out_path)
    print(f"Saved: {out_path}")


# ---------------------------------------------------------------------------
# Flux2-Klein I2I: delegates to shared execute_generation()
# ---------------------------------------------------------------------------

def _run_flux2_klein_i2i(args):
    """I2I via flux2-klein pipeline — delegates to shared execute_generation().

    Flux2KleinT2IPipeline already supports input_image + denoise_strength
    in its generate() method, so we reuse the standard generation path.
    LoRA is applied at pipeline init time (not generation time).
    """
    from app.run_config import RunConfig
    from app.commands._shared import execute_generation, resolve_lora_path

    input_image_path = getattr(args, "input_image", None)
    if not input_image_path:
        print("ERROR: --input-image is required for I2I mode.", file=sys.stderr)
        print("  Usage: run.py image i2i --pipeline flux2-klein --input-image photo.jpg "
              "--prompt '...' --denoise-strength 0.4",
              file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(input_image_path):
        print(f"ERROR: Input image not found: {input_image_path}", file=sys.stderr)
        sys.exit(1)

    denoise_strength = getattr(args, "denoise_strength", 0.4)
    if getattr(args, "steps", None) is None:
        args.steps = 4  # flux2-klein default

    # Resolve LoRA path
    lora_path = getattr(args, "lora_path", None)
    if lora_path:
        lora_path = resolve_lora_path(lora_path)

    run_config = RunConfig.from_args(args, command="image i2i")
    run_config.pipeline = "flux2-klein"
    run_config.lora_path = lora_path
    run_config.denoise_strength = denoise_strength

    # Warn about ControlNet incompatibility
    ref_image_path = getattr(args, "reference_image", None)
    if ref_image_path:
        print("WARNING: ControlNet is not supported with flux2-klein pipeline. "
              "Ignoring --reference-image.", file=sys.stderr)

    print(f"[I2I] Flux2-Klein pipeline")
    print(f"  Input     : {input_image_path}")
    print(f"  Denoise   : {denoise_strength}")
    print(f"  LoRA      : {os.path.basename(lora_path) if lora_path else 'none'}"
          + (f" (scale={run_config.lora_scale})" if lora_path else ""))
    print(f"  Steps/seed: {run_config.steps} / {run_config.seed}")

    execute_generation(run_config, pipeline_type="flux2-klein")


# ---------------------------------------------------------------------------
# Core generation: I2I with optional ControlNet (Z-Image only)
# ---------------------------------------------------------------------------

def _generate(prompt, out_w, out_h, steps, seed, clean_latent, denoise_strength,
              ctrl_33ch=None, controlnet_strength=0.6, cnet_active_steps=None) -> "Image.Image":
    """Run full I2I denoising loop with optional ControlNet. Returns PIL Image.

    Args:
        clean_latent: [1, 16, H//8, W//8] VAE-encoded source image (Flux-normalized)
        denoise_strength: 0.0–1.0, how much to change from source
        ctrl_33ch: [1, 33, H, W] optional ControlNet 33-channel input
        controlnet_strength: ControlNet conditioning strength
        cnet_active_steps: dual-sampler — only apply ControlNet for first N steps
    """
    from PIL import Image
    from transformers import AutoTokenizer
    from app.pipeline import (
        ZImageTransformerMLX,
        MLXFlowMatchEulerScheduler, create_coordinate_grid,
        calculate_shift, load_sharded_weights, _load_mlx_vae,
    )
    from app.text_encoder import TextEncoderMLX

    use_cnet = ctrl_33ch is not None

    # ── Phase 1: ControlNet (optional) ────────────────────────────────────
    controlnet = None
    controlnet_context = None
    if use_cnet:
        print("[I2I] Loading ControlNet weights...")
        controlnet = load_controlnet(cfg.CONTROLNET_DIR)
        print("[I2I] Embedding control context...", end=" ", flush=True)
        controlnet_context = controlnet.embed_control(ctrl_33ch)
        mx.eval(controlnet_context)
        print(f"Done → {list(controlnet_context.shape)}")

    # ── Phase 2: Text encoding ────────────────────────────────────────────
    print("[I2I] Text encoding...", end=" ", flush=True)
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

    # ── Phase 3: Transformer loading ──────────────────────────────────────
    print("[I2I] Loading transformer (4-bit)...", end=" ", flush=True)
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

    # ── Phase 4: Denoising with I2I noise mixing + optional ControlNet ────
    scheduler = MLXFlowMatchEulerScheduler(shift=3.0, use_dynamic_shifting=True)
    if seed is not None:
        np.random.seed(seed)

    _, C_lat, H_lat, W_lat = clean_latent.shape
    H_tok, W_tok = H_lat // 2, W_lat // 2
    mu = calculate_shift(H_tok * W_tok)
    scheduler.set_timesteps(steps, mu=mu)

    # ── I2I noise mixing (the key difference from T2I) ────────────────────
    noise = mx.array(np.random.randn(*clean_latent.shape)).astype(mx.bfloat16)
    if denoise_strength < 1.0:
        steps_to_run = max(1, round(steps * denoise_strength))
        start_step = steps - steps_to_run
        t_mix = float(scheduler.timesteps[start_step])
        latents = (1.0 - t_mix) * clean_latent + t_mix * noise
        print(f"[I2I] img2img: {steps_to_run} steps from step {start_step + 1}/{steps} (t_mix={t_mix:.3f})")
    else:
        start_step = 0
        latents = noise
        print(f"[I2I] Full denoise from noise (denoise_strength=1.0)")

    # Positions and RoPE
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

    # ── Denoising loop ────────────────────────────────────────────────────
    print(f"[I2I] Denoising...")
    for i in range(start_step, steps):
        step_start = time.time()
        t_curr = scheduler.timesteps[i]
        t_input = (1.0 - t_curr)[None].astype(mx.bfloat16)

        # ControlNet dual-sampler: only active for first N steps of current denoising process.
        # Use position relative to start_step (not absolute step index), because I2I
        # starts denoising from start_step, not 0. Without this offset, cnet_active_steps=5
        # with start_step=9 would mean ControlNet is NEVER active (9 < 5 is always False).
        active_strength = 0.0
        if use_cnet:
            pos_in_denoise = i - start_step
            active_strength = controlnet_strength if (cnet_active_steps is None or pos_in_denoise < cnet_active_steps) else 0.0

        B, C, H, W = latents.shape
        x_reshaped = latents.reshape(
            C, 1, 1, H_tok, 2, W_tok, 2
        ).transpose(1, 2, 3, 5, 4, 6, 0).reshape(1, -1, C * 4)

        out = model(
            x_reshaped, t_input, cap_feats_mx, img_pos, cap_pos,
            cos_cached, sin_cached, cap_mask=None,
            controlnet_model=controlnet,
            controlnet_context=controlnet_context,
            controlnet_strength=active_strength,
        )
        noise_pred = -out.reshape(
            1, 1, H_tok, W_tok, 2, 2, C
        ).transpose(6, 0, 1, 2, 4, 3, 5).reshape(1, C, H, W)

        latents = scheduler.step(noise_pred, i, latents)
        mx.eval(latents)
        print(f"   Step {i + 1}/{steps}: {time.time() - step_start:.2f}s")

    # ── Phase 5: Decode ───────────────────────────────────────────────────
    print("[I2I] Decoding...", end=" ", flush=True)
    del model, controlnet, cos_cached, sin_cached, controlnet_context
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
# Self-test mode
# ---------------------------------------------------------------------------

def _run_self_test(args):
    """Run I2I self-test: generate source + variations, open bilingual review HTML.

    Steps:
      1. Generate source image via T2I (or reuse cached)
      2. Download reference image for ControlNet tests (or reuse cached)
      3. Generate predefined variations (simple I2I + I2I+ControlNet)
      4. Generate bilingual review HTML with scoring guide
      5. Open in browser
    """
    from PIL import Image

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)

    print(f"\n{'#' * 60}")
    print(f" I2I Self-Test")
    print(f"{'#' * 60}")

    seed = getattr(args, "seed", 42)

    # ── Step 1: Generate source image via T2I ─────────────────────────────
    source_path = os.path.join(cfg.OUTPUT_DIR, f"i2i_selftest_source-s{seed}.png")
    if not os.path.exists(source_path):
        print(f"\n[Self-Test] Generating T2I source image...")
        source_img = _generate_t2i(
            prompt=_I2I_SOURCE_PROMPT,
            out_w=1024, out_h=1024,
            steps=9, seed=seed,
        )
        source_img.save(source_path)
        print(f"  Saved: {source_path}")
    else:
        print(f"\n[Self-Test] Reusing cached source: {source_path}")

    with Image.open(source_path) as img:
        src_w, src_h = img.size
    out_w = (src_w // 16) * 16
    out_h = (src_h // 16) * 16
    print(f"  Size: {src_w}×{src_h} → output {out_w}×{out_h}")

    # ── Step 2: Generate reference image via T2I (distinctive pose + different ethnicity) ──
    ref_path = os.path.join(cfg.OUTPUT_DIR, f"i2i_selftest_ref-pose-s{seed + 1}.png")
    if not os.path.exists(ref_path):
        print(f"\n[Self-Test] Generating T2I reference image (victory V-pose, Caucasian)...")
        ref_img = _generate_t2i(
            prompt=_I2I_REF_POSE_PROMPT,
            out_w=1024, out_h=1024,
            steps=9, seed=seed + 1,  # different seed → different face
        )
        ref_img.save(ref_path)
        print(f"  Saved: {ref_path}")
    else:
        print(f"\n[Self-Test] Reusing cached reference: {ref_path}")

    # ── Step 3: VAE encode source image (once, reused by all variations) ──
    print(f"\n[Self-Test] VAE encoding source image...", end=" ", flush=True)
    vae = _load_vae()
    source_pil = Image.open(source_path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    clean_latent = _vae_encode(vae, source_pil)
    clean_latent = (clean_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR
    print(f"Done → {list(clean_latent.shape)}")

    # ── Step 3b: Pre-encode ControlNet reference (for ControlNet variations) ──
    ctrl_33ch = None
    if ref_path:
        print(f"[Self-Test] VAE encoding ControlNet reference...", end=" ", flush=True)
        ref_pil = _load_and_preprocess(
            ref_path, out_w, out_h, skip=True, blur_ref=5.0,
        )
        ctrl_latent = _vae_encode(vae, ref_pil)
        ctrl_latent = (ctrl_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR
        ctrl_33ch = build_control_input_33ch(ctrl_latent, lambda img: _vae_encode(vae, img))
        print(f"Done → {list(ctrl_33ch.shape)}")

    del vae
    _gc()

    # ── Step 4: Generate variations ───────────────────────────────────────
    results = []

    for label, dn_str, ctrl_str, blur_ref, cnet_active, tstps in _I2I_SELF_TEST_VARIATIONS:
        # Skip ControlNet variations if no reference image
        if ctrl_str is not None and ctrl_33ch is None:
            print(f"\n[Self-Test] SKIP {label} (no ControlNet reference)")
            continue

        print(f"\n{'=' * 60}")
        print(f"[Self-Test] {label}")
        print(f"{'=' * 60}")

        use_ctrl = ctrl_33ch if ctrl_str is not None else None
        mode_desc = "I2I+ControlNet" if ctrl_str is not None else "I2I"
        print(f"  Type: {mode_desc} (denoise={dn_str}, steps={tstps})")

        pil_image = _generate(
            prompt=_I2I_SELF_TEST_PROMPT,
            out_w=out_w,
            out_h=out_h,
            steps=tstps,
            seed=seed,
            clean_latent=clean_latent,
            denoise_strength=dn_str,
            ctrl_33ch=use_ctrl,
            controlnet_strength=ctrl_str or 0.6,
            cnet_active_steps=cnet_active,
        )

        img_filename = f"i2i_selftest_{label}-s{seed}.png"
        out_p = os.path.join(cfg.OUTPUT_DIR, img_filename)
        pil_image.save(out_p)
        print(f"  Saved: {out_p}")

        params = {
            "denoise_strength": dn_str,
            "steps": tstps,
            "seed": seed,
        }
        run_config = {
            "command": "image",
            "action": "i2i",
            "pipeline": "zimage",
            "denoise_strength": dn_str,
            "steps": tstps,
            "seed": seed,
        }
        if ctrl_str is not None:
            params["controlnet_strength"] = ctrl_str
            params["blur_ref"] = blur_ref
            params["cnet_active_steps"] = cnet_active
            run_config["controlnet_strength"] = ctrl_str
            run_config["blur_ref"] = blur_ref
            run_config["cnet_active_steps"] = cnet_active
            run_config["reference_image"] = os.path.basename(ref_path) if ref_path else None

        results.append({
            "id": label,
            "label": label,
            "img": img_filename,
            "params": params,
            "run_config": run_config,
        })

    # ── Step 5: Generate bilingual review HTML ─────────────────────────────
    print(f"\n{'=' * 60}")
    print(f"[Self-Test] Generating review HTML")
    print(f"{'=' * 60}")

    html_path = os.path.join(cfg.OUTPUT_DIR, "i2i_selftest_review.html")
    _generate_self_test_html(
        html_path, results,
        source_image=os.path.basename(source_path),
        ref_image=os.path.basename(ref_path) if ref_path else None,
    )
    print(f"  Saved: {html_path}")

    # ── Step 6: Open in browser ────────────────────────────────────────────
    import webbrowser
    webbrowser.open(f"file://{os.path.abspath(html_path)}")
    print(f"  Opened in browser")


def _generate_t2i(prompt, out_w, out_h, steps, seed):
    """Generate a T2I image (no I2I, no ControlNet). Used for source + reference."""
    from PIL import Image
    from transformers import AutoTokenizer
    from app.pipeline import (
        ZImageTransformerMLX,
        MLXFlowMatchEulerScheduler, create_coordinate_grid,
        calculate_shift, load_sharded_weights, _load_mlx_vae,
    )
    from app.text_encoder import TextEncoderMLX

    print("[T2I Source] Loading text encoder...", end=" ", flush=True)
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

    print("[T2I Source] Loading transformer (4-bit)...", end=" ", flush=True)
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

    print("[T2I Source] Denoising...")
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
        B, C, H, W = latents.shape
        x_reshaped = latents.reshape(
            C, 1, 1, H_tok, 2, W_tok, 2
        ).transpose(1, 2, 3, 5, 4, 6, 0).reshape(1, -1, C * 4)
        out = model(x_reshaped, t_input, cap_feats_mx, img_pos, cap_pos,
                    cos_cached, sin_cached, cap_mask=None)
        noise_pred = -out.reshape(
            1, 1, H_tok, W_tok, 2, 2, C
        ).transpose(6, 0, 1, 2, 4, 3, 5).reshape(1, C, H, W)
        latents = scheduler.step(noise_pred, i, latents)
        mx.eval(latents)
        print(f"   Step {i + 1}/{steps}: {time.time() - step_start:.2f}s")

    print("[T2I Source] Decoding...", end=" ", flush=True)
    del model, cos_cached, sin_cached
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
# Review HTML generator
# ---------------------------------------------------------------------------

def _generate_self_test_html(html_path, results, source_image, ref_image=None):
    """Generate bilingual (EN/zh_TW) review HTML with scoring guide."""
    import html as html_mod

    tests_json = json.dumps(results, ensure_ascii=False)

    ref_img_html = ""
    if ref_image:
        ref_img_html = f"""
        <div style="display:inline-block;text-align:center;margin:0 12px;">
            <img src="{html_mod.escape(ref_image)}" style="max-height:180px;border-radius:8px;border:2px solid var(--border);"><br>
            <span style="font-size:0.75em;color:var(--muted);"
                  data-en="Reference (Caucasian, V-pose)" data-zh="參考圖（白人女性，V 姿勢）"></span>
        </div>
        """

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>I2I Self-Test Review</title>
<style>
  :root {{ --bg: #1a1a2e; --card: #16213e; --border: #0f3460; --accent: #e94560;
           --text: #eee; --muted: #999; --success: #4ecca3; }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; padding-bottom: 80px; }}

  .header {{ text-align: center; margin-bottom: 20px; }}
  .header h1 {{ font-size: 1.6em; margin-bottom: 4px; }}
  .header .subtitle {{ color: var(--muted); font-size: 0.9em; }}
  .lang-toggle {{ display: inline-flex; background: var(--border); border-radius: 6px; overflow: hidden; margin-top: 8px; }}
  .lang-toggle button {{ padding: 6px 16px; border: none; background: transparent; color: var(--muted);
    cursor: pointer; font-size: 0.85em; font-weight: 600; transition: all 0.2s; }}
  .lang-toggle button.active {{ background: var(--accent); color: #fff; }}

  .ref-strip {{ text-align: center; margin-bottom: 20px; background: var(--card); border-radius: 12px; padding: 16px; border: 1px solid var(--border); }}
  .ref-strip h3 {{ font-size: 0.9em; margin-bottom: 10px; }}

  .guide {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    margin-bottom: 20px; overflow: hidden; }}
  .guide-header {{ padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between;
    align-items: center; user-select: none; }}
  .guide-header:hover {{ background: rgba(255,255,255,0.03); }}
  .guide-header h2 {{ font-size: 1em; }}
  .guide-header .chevron {{ transition: transform 0.2s; font-size: 0.8em; }}
  .guide-header .chevron.open {{ transform: rotate(180deg); }}
  .guide-body {{ padding: 0 16px 16px; display: none; }}
  .guide-body.open {{ display: block; }}
  .guide-body h3 {{ font-size: 0.9em; color: var(--accent); margin: 12px 0 6px; }}
  .guide-body p, .guide-body li {{ font-size: 0.82em; line-height: 1.7; color: #ccc; }}
  .guide-body ul {{ padding-left: 20px; }}
  .guide-body li {{ margin-bottom: 4px; }}
  .guide-body .tip {{ background: rgba(233,69,96,0.1); border-left: 3px solid var(--accent);
    padding: 8px 12px; border-radius: 0 6px 6px 0; margin: 8px 0; font-size: 0.82em; }}

  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-bottom: 24px; }}
  .card {{ background: var(--card); border: 2px solid var(--border); border-radius: 12px;
    padding: 12px; transition: border-color 0.2s; }}
  .card:hover {{ border-color: var(--accent); }}
  .card.highlighted {{ border-color: var(--success); box-shadow: 0 0 12px rgba(78,204,163,0.3); }}
  .card-title {{ font-weight: 700; font-size: 0.95em; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }}
  .card-title .badge {{ font-size: 0.7em; background: var(--border); padding: 2px 8px; border-radius: 4px; }}
  .card-title .badge.i2i {{ background: rgba(78,204,163,0.2); color: var(--success); }}
  .card-title .badge.cnet {{ background: rgba(233,69,96,0.2); color: var(--accent); }}
  .card-img-wrap {{ position: relative; width: 100%; aspect-ratio: 1/1; overflow: hidden; border-radius: 8px;
    background: #111; cursor: zoom-in; margin-bottom: 8px; }}
  .card-img-wrap img {{ width: 100%; height: 100%; object-fit: contain; }}
  .card-img-wrap .zoom-hint {{ position: absolute; bottom: 4px; right: 4px; background: rgba(0,0,0,0.6);
    color: #fff; font-size: 0.7em; padding: 2px 6px; border-radius: 4px; }}
  .params {{ font-size: 0.78em; color: var(--muted); margin-bottom: 8px; line-height: 1.5; }}
  .params span {{ display: inline-block; background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 3px; margin: 1px 2px; }}
  .rating-row {{ display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.82em; }}
  .rating-row label {{ min-width: 100px; color: var(--muted); font-size: 0.8em; }}
  .stars {{ display: flex; gap: 2px; }}
  .stars span {{ font-size: 1.3em; cursor: pointer; opacity: 0.3; transition: opacity 0.15s; }}
  .stars span.active {{ opacity: 1; }}
  .stars span:hover {{ opacity: 0.8; }}
  .comment-box {{ width: 100%; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 8px; font-size: 0.8em; resize: vertical; min-height: 40px; font-family: inherit; }}
  .winner-btn {{ background: none; border: 1px solid var(--border); color: var(--muted); padding: 4px 12px;
    border-radius: 6px; cursor: pointer; font-size: 0.78em; transition: all 0.2s; margin-top: 4px; }}
  .winner-btn:hover {{ border-color: var(--success); color: var(--success); }}
  .winner-btn.selected {{ background: var(--success); color: #1a1a2e; border-color: var(--success); font-weight: 700; }}

  .bottom-bar {{ position: fixed; bottom: 0; left: 0; right: 0; background: var(--card); border-top: 1px solid var(--border);
    padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 100; }}
  .btn {{ padding: 8px 20px; border-radius: 8px; border: none; font-size: 0.9em; cursor: pointer; font-weight: 600; transition: opacity 0.2s; }}
  .btn-primary {{ background: var(--accent); color: #fff; }}
  .btn-primary:hover {{ opacity: 0.85; }}
  .btn-secondary {{ background: var(--border); color: var(--text); }}
  .btn-secondary:hover {{ opacity: 0.85; }}
  .winner-count {{ font-size: 0.85em; color: var(--muted); }}

  .overlay {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 200; cursor: zoom-out;
    justify-content: center; align-items: center; }}
  .overlay.show {{ display: flex; }}
  .overlay img {{ max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 8px; }}

  .modal {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 300;
    justify-content: center; align-items: center; }}
  .modal.show {{ display: flex; }}
  .modal-content {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    width: 90vw; max-width: 900px; max-height: 85vh; display: flex; flex-direction: column; }}
  .modal-header {{ padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }}
  .modal-body {{ flex: 1; overflow: auto; padding: 16px 20px; }}
  .modal-body pre {{ white-space: pre-wrap; word-break: break-all; font-size: 0.8em; line-height: 1.6; color: #a8d8ea; }}
</style>
</head>
<body>

<div class="header">
  <h1 data-en="🔬 Z-Image I2I Self-Test" data-zh="🔬 Z-Image I2I 自動測試"></h1>
  <p class="subtitle" data-en="Click images to zoom · Rate each test · Pick winners → Generate JSON" data-zh="點擊圖片放大 · 評分每張測試 · 選出最佳 → 產出 JSON"></p>
  <div class="lang-toggle">
    <button class="active" onclick="setLang('en')">EN</button>
    <button onclick="setLang('zh')">中文</button>
  </div>
</div>

<!-- Reference images -->
<div class="ref-strip">
  <h3 data-en="📷 Source & Reference Images" data-zh="📷 來源圖 & 參考圖"></h3>
  <div style="display:inline-block;text-align:center;margin:0 12px;">
      <img src="{html_mod.escape(source_image)}" style="max-height:180px;border-radius:8px;border:2px solid var(--border);"><br>
      <span style="font-size:0.75em;color:var(--muted);"
            data-en="Source (Asian, standing)" data-zh="來源圖（亞洲女性，站立）"></span>
  </div>
  {ref_img_html}
</div>

<!-- Pipeline Metadata -->
<div class="meta-strip" style="background:var(--card);border-radius:12px;padding:12px 16px;margin-bottom:20px;border:1px solid var(--border);">
  <h3 style="font-size:0.85em;margin-bottom:8px;" data-en="⚙️ Pipeline & Model Info" data-zh="⚙️ 管線與模型資訊"></h3>
  <table style="font-size:0.78em;border-collapse:collapse;width:100%;">
    <tr style="border-bottom:1px solid rgba(255,255,255,0.06);"><td style="padding:3px 8px;color:var(--muted);white-space:nowrap;">Pipeline</td><td style="padding:3px 8px;">Z-Image Turbo (native MLX, 4-bit quantized)</td></tr>
    <tr style="border-bottom:1px solid rgba(255,255,255,0.06);"><td style="padding:3px 8px;color:var(--muted);white-space:nowrap;">Transformer</td><td style="padding:3px 8px;">{html_mod.escape(os.path.basename(cfg.TRANSFORMER_DIR))}</td></tr>
    <tr style="border-bottom:1px solid rgba(255,255,255,0.06);"><td style="padding:3px 8px;color:var(--muted);white-space:nowrap;">ControlNet</td><td style="padding:3px 8px;">{html_mod.escape(os.path.basename(cfg.CONTROLNET_DIR))} (Union 2.1, 3 control layers)</td></tr>
    <tr style="border-bottom:1px solid rgba(255,255,255,0.06);"><td style="padding:3px 8px;color:var(--muted);white-space:nowrap;">Text Encoder</td><td style="padding:3px 8px;">{html_mod.escape(os.path.basename(cfg.TEXT_ENCODER_DIR))} (4-bit)</td></tr>
    <tr style="border-bottom:1px solid rgba(255,255,255,0.06);"><td style="padding:3px 8px;color:var(--muted);white-space:nowrap;">VAE</td><td style="padding:3px 8px;">{html_mod.escape(os.path.basename(cfg.VAE_DIR))}</td></tr>
    <tr><td style="padding:3px 8px;color:var(--accent);white-space:nowrap;">⚠️ Note</td><td style="padding:3px 8px;" data-en="ControlNet only works with Z-Image Turbo. Flux2 Klein does NOT support ControlNet." data-zh="ControlNet 僅支援 Z-Image Turbo。Flux2 Klein 不支援 ControlNet。"></td></tr>
  </table>
</div>

<!-- Scoring Guide -->
<div class="guide">
  <div class="guide-header" onclick="toggleGuide()">
    <h2 data-en="📖 How to Score — Click to Expand" data-zh="📖 評分指南 — 點擊展開"></h2>
    <span class="chevron">▼</span>
  </div>
  <div class="guide-body" id="guideBody">
    <p data-en="Rate each image on 4 criteria using 1–5 stars. Compare to the SOURCE and REFERENCE images above."
	       data-zh="每張圖片依 4 個面向以 1–5 顆星評分。與上方「來源圖」和「參考圖」比較。"></p>

	    <h3 data-en="⭐ Test Design" data-zh="⭐ 測試設計"></h3>
	    <ul>
	      <li data-en="<b>Source</b>: Asian woman with black hair, standing with arms at sides (I-shape)"
	             data-zh="<b>來源圖</b>：黑髮亞洲女性，雙手自然放下站立（I 字形）"></li>
	      <li data-en="<b>Reference</b>: Caucasian woman with blonde hair, arms raised in V-pose (different pose AND ethnicity)"
	             data-zh="<b>參考圖</b>：金髮白人女性，雙手高舉 V 字勝利姿勢（姿勢和外貌完全不同）"></li>
	      <li data-en="<b>Prompt</b>: Oil painting style only — NO pose. Pose from source (I2I) or reference (ControlNet)."
	             data-zh="<b>Prompt</b>：僅描述油畫風格，不描述姿勢。姿勢來自來源圖（純 I2I）或參考圖（ControlNet）。"></li>
	    </ul>

	    <h3 data-en="⭐ Criteria" data-zh="⭐ 評分面向"></h3>
	    <ul>
	      <li data-en="<b>Source Identity</b>: Does output still look like the <b>Asian source</b>? Or became the Caucasian reference? <b>1</b>=source lost, <b>5</b>=source preserved."
	             data-zh="<b>Source Identity（來源身份）</b>：輸出是否仍像<b>亞洲來源</b>？還是變成白人？<b>1 分</b>=來源消失，<b>5 分</b>=來源保留。"></li>
	      <li data-en="<b>Style Change</b>: How well does the oil painting style come through? <b>1</b>=no change, <b>5</b>=perfect oil painting."
	             data-zh="<b>Style Change（風格轉換）</b>：油畫風格有多好？<b>1 分</b>=沒有轉換，<b>5 分</b>=完美油畫。"></li>
	      <li data-en="<b>Pose Match</b>: Simple I2I → should match source (arms down). I2I+ControlNet → should match reference (V-pose, arms up). <b>1</b>=wrong, <b>5</b>=exact."
	             data-zh="<b>Pose Match（姿勢匹配）</b>：純 I2I → 應匹配來源（雙手放下）。I2I+ControlNet → 應匹配參考（V 字、雙手高舉）。<b>1 分</b>=錯誤，<b>5 分</b>=精確。"></li>
	      <li data-en="<b>Low Artifacts</b>: Extra limbs, deformed faces, melting textures. <b>1</b>=severe, <b>5</b>=clean."
	             data-zh="<b>Low Artifacts（低瑕疵）</b>：多餘肢體、變形、融化紋理。<b>1 分</b>=嚴重，<b>5 分</b>=乾淨。"></li>
	    </ul>

	    <h3 data-en="🎯 Denoise Strength Guide" data-zh="🎯 Denoise 強度指南"></h3>
	    <ul>
	      <li data-en="<b>0.15–0.25</b>: Polishing — keep pose/layout, change color/texture only."
	             data-zh="<b>0.15–0.25</b>：修飾 — 完全保留姿勢/構圖，僅改變色彩/紋理。"></li>
	      <li data-en="<b>0.30–0.45</b>: Controlled restyle — maintain structure, shift vibe/style."
	             data-zh="<b>0.30–0.45</b>：控制風格轉換 — 保留結構，改變氛圍/風格。"></li>
	      <li data-en="<b>0.50–0.65</b>: Bold reinterpretation — pose and scene hold loosely."
	             data-zh="<b>0.50–0.65</b>：大幅重新詮釋 — 姿勢和場景僅粗略保留。"></li>
	      <li data-en="<b>0.70+</b>: New idea with a memory — source becomes a suggestion."
	             data-zh="<b>0.70+</b>：全新創作帶點記憶 — 來源圖僅作為參考。"></li>
	    </ul>

	    <div class="tip" data-en="💡 <b>Quick check</b>: <b>Simple I2I</b> — lower denoise = more like source (Asian, arms down). <b>I2I+ControlNet</b> — should show V-pose (arms up). If all ControlNet outputs still have arms down, CN is NOT working."
	         data-zh="💡 <b>快速判斷</b>：<b>純 I2I</b> — denoise 越低越像來源（亞洲人、雙手放下）。<b>I2I+ControlNet</b> — 應出現 V 姿勢（雙手高舉）。如果所有 CN 結果仍雙手放下，CN 沒有生效。"></div>
  </div>
</div>

<div class="grid" id="grid"></div>

<div class="bottom-bar">
  <span class="winner-count" id="winnerCount" data-en="0 winners selected" data-zh="已選 0 個最佳"></span>
  <div>
    <button class="btn btn-secondary" onclick="resetAll()" style="margin-right:8px" data-en="Reset All" data-zh="全部重設"></button>
    <button class="btn btn-primary" onclick="generateJSON()">📋 Generate JSON</button>
  </div>
</div>

<div class="overlay" id="overlay" onclick="this.classList.remove('show')">
  <img id="overlayImg" src="">
</div>

<div class="modal" id="modal">
  <div class="modal-content">
    <div class="modal-header">
      <strong>📋 Review Results JSON</strong>
      <div>
        <button class="btn btn-secondary" onclick="copyJSON()" style="margin-right:8px">Copy</button>
        <button class="btn btn-secondary" onclick="downloadJSON()" style="margin-right:8px">Download</button>
        <button class="btn btn-primary" onclick="document.getElementById('modal').classList.remove('show')">Close</button>
      </div>
    </div>
    <div class="modal-body">
      <pre id="jsonOutput"></pre>
    </div>
  </div>
</div>

<script>
const TESTS = {tests_json};

const CRITERIA = [
  {{ key: "source_identity",  en: "Source Identity",  zh: "來源身份" }},
  {{ key: "style_change",    en: "Style Change",     zh: "風格轉換" }},
  {{ key: "pose_match",      en: "Pose Match",       zh: "姿勢匹配" }},
  {{ key: "artifact_level",  en: "Low Artifacts",    zh: "低瑕疵" }}
];

let lang = 'en';
const state = {{}};
TESTS.forEach(t => {{
  state[t.id] = {{ ratings: {{}}, comment: "", winner: false }};
  CRITERIA.forEach(c => state[t.id].ratings[c.key] = 0);
}});

function setLang(l) {{
  lang = l;
  document.querySelectorAll('.lang-toggle button').forEach(b => b.classList.remove('active'));
  document.querySelector(`.lang-toggle button:${{l === 'en' ? 'first' : 'last'}}-child`).classList.add('active');
  document.querySelectorAll('[data-' + l + ']').forEach(el => {{
    el.innerHTML = el.getAttribute('data-' + l);
  }});
  renderGrid();
  updateWinnerCount();
}}

function toggleGuide() {{
  const body = document.getElementById('guideBody');
  const chevron = document.querySelector('.guide-header .chevron');
  body.classList.toggle('open');
  chevron.classList.toggle('open');
}}

function getTestLabel(t) {{
  const p = t.params;
  let label = 'dn=' + p.denoise_strength;
  if (p.controlnet_strength) label += ' cnet=' + p.controlnet_strength;
  if (p.blur_ref) label += ' blur=' + p.blur_ref;
  label += ' ' + p.steps + 'st';
  if (p.cnet_active_steps) label += ' act=' + p.cnet_active_steps;
  return label;
}}

function getTestBadge(t) {{
  if (t.params.controlnet_strength)
    return '<span class="badge cnet">' + (lang === 'en' ? 'I2I+ControlNet' : 'I2I+ControlNet') + '</span>';
  return '<span class="badge i2i">' + (lang === 'en' ? 'I2I' : 'I2I') + '</span>';
}}

function renderGrid() {{
  const grid = document.getElementById('grid');
  grid.innerHTML = TESTS.map(t => {{
    const paramsHtml = Object.entries(t.params).map(([k,v]) => `<span>${{k}}=${{v}}</span>`).join('');
    const starsHtml = CRITERIA.map(c => {{
      const critLabel = c[lang];
      const stars = [1,2,3,4,5].map(s =>
        `<span class="${{state[t.id].ratings[c.key] >= s ? 'active' : ''}}" onclick="setRating('${{t.id}}','${{c.key}}',${{s}})">★</span>`
      ).join('');
      return `<div class="rating-row"><label>${{critLabel}}</label><div class="stars">${{stars}}</div></div>`;
    }}).join('');

    return `
    <div class="card ${{state[t.id].winner ? 'highlighted' : ''}}" id="card-${{t.id}}">
      <div class="card-title">
        <span>${{getTestLabel(t)}}</span>
        ${{getTestBadge(t)}}
      </div>
      <div class="card-img-wrap" onclick="zoom('${{t.img}}')">
        <img src="${{t.img}}" loading="lazy" alt="${{t.id}}">
        <span class="zoom-hint">🔍</span>
      </div>
      <div class="params">${{paramsHtml}}</div>
      ${{starsHtml}}
      <textarea class="comment-box" placeholder="${{lang === 'en' ? 'Comments...' : '評論...'}}"
        id="comment-${{t.id}}" oninput="state['${{t.id}}'].comment=this.value">${{state[t.id].comment}}</textarea>
      <button class="winner-btn ${{state[t.id].winner ? 'selected' : ''}}" onclick="toggleWinner('${{t.id}}')">
        ${{state[t.id].winner
            ? '✅ ' + (lang === 'en' ? 'Winner' : '最佳')
            : '🏆 ' + (lang === 'en' ? 'Mark Winner' : '標記最佳')}}
      </button>
    </div>`;
  }}).join('');
}}

function setRating(testId, criterion, value) {{
  state[testId].ratings[criterion] = value;
  renderGrid();
}}

function toggleWinner(testId) {{
  state[testId].winner = !state[testId].winner;
  updateWinnerCount();
  renderGrid();
}}

function updateWinnerCount() {{
  const count = Object.values(state).filter(s => s.winner).length;
  document.getElementById('winnerCount').textContent =
    lang === 'en' ? `${{count}} winner${{count !== 1 ? 's' : ''}} selected`
                  : `已選 ${{count}} 個最佳`;
}}

function zoom(imgSrc) {{
  document.getElementById('overlayImg').src = imgSrc;
  document.getElementById('overlay').classList.add('show');
}}

function resetAll() {{
  const msg = lang === 'en' ? 'Reset all ratings, comments, and winners?' : '重設所有評分、評論和最佳選擇？';
  if (!confirm(msg)) return;
  TESTS.forEach(t => {{
    state[t.id].ratings = {{}};
    state[t.id].comment = "";
    state[t.id].winner = false;
    CRITERIA.forEach(c => state[t.id].ratings[c.key] = 0);
    const ta = document.getElementById('comment-' + t.id);
    if (ta) ta.value = '';
  }});
  updateWinnerCount();
  renderGrid();
}}

function generateJSON() {{
  const results = TESTS.map(t => ({{
    id: t.id,
    label: getTestLabel(t),
    image_file: t.img,
    parameters: t.params,
    run_config: t.run_config,
    feedback: {{
      ratings: {{ ...state[t.id].ratings }},
      comment: state[t.id].comment,
      is_winner: state[t.id].winner
    }}
  }}));

  const winners = results.filter(r => r.feedback.is_winner);
  const output = {{
    title: "Z-Image I2I Self-Test Results",
    date: new Date().toISOString(),
    source_image: "{html_mod.escape(source_image)}",
    reference_image: "{html_mod.escape(ref_image or '')}",
    source_prompt: "{html_mod.escape(_I2I_SOURCE_PROMPT)}",
    i2i_prompt: "{html_mod.escape(_I2I_SELF_TEST_PROMPT)}",
    language: lang,
    total_tests: results.length,
    winners: winners.map(w => w.id),
    results: results
  }};

  const jsonStr = JSON.stringify(output, null, 2);
  document.getElementById('jsonOutput').textContent = jsonStr;
  document.getElementById('modal').classList.add('show');
}}

function copyJSON() {{
  const text = document.getElementById('jsonOutput').textContent;
  navigator.clipboard.writeText(text).then(() => {{
    const btn = event.target;
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  }});
}}

function downloadJSON() {{
  const text = document.getElementById('jsonOutput').textContent;
  const blob = new Blob([text], {{ type: 'application/json' }});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `i2i_selftest_${{new Date().toISOString().slice(0,10)}}.json`;
  a.click();
  URL.revokeObjectURL(url);
}}

renderGrid();
</script>
</body>
</html>"""

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)


# ---------------------------------------------------------------------------
# Preprocessing (reused from image-controlnet.py)
# ---------------------------------------------------------------------------

def _load_and_preprocess(path: str, out_w: int, out_h: int,
                          skip: bool, blur_ref: float | None = None) -> "Image.Image":
    """Load and preprocess reference image for ControlNet."""
    from PIL import Image, ImageFilter

    img = Image.open(path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    if skip:
        if blur_ref is not None:
            radius = max(1, int(blur_ref))
            img = img.filter(ImageFilter.GaussianBlur(radius=radius))
            print(f"[I2I] Reference blur sigma={blur_ref} applied")
        print(f"[I2I] Using raw reference image as control signal")
        return img
    # Default: canny edge detection
    return _apply_canny(img)


def _apply_canny(pil_img: "Image.Image") -> "Image.Image":
    """Apply Canny edge detection."""
    from PIL import Image
    try:
        import cv2
    except ImportError:
        return pil_img
    import numpy as np
    gray = np.array(pil_img.convert("L"))
    edges = cv2.Canny(gray, threshold1=100, threshold2=200)
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


def _vae_encode(vae, pil_img) -> mx.array:
    """Encode PIL image → latent [1, 16, H//8, W//8]."""
    from PIL import Image
    import numpy as np

    if isinstance(pil_img, Image.Image):
        img_np = np.array(pil_img.convert("RGB")).astype(np.float32) / 127.5 - 1.0
    else:
        img_np = np.array(pil_img).astype(np.float32) / 127.5 - 1.0

    h, w = img_np.shape[:2]
    h8 = (h // 8) * 8
    w8 = (w // 8) * 8
    if h8 != h or w8 != w:
        img_np = img_np[:h8, :w8]
    img_mx = mx.array(img_np.transpose(2, 0, 1)[None]).astype(mx.bfloat16)
    encoded = vae.encode(img_mx)
    if encoded.ndim == 5:
        encoded = encoded[:, :, 0, :, :]
    mx.eval(encoded)
    return encoded.astype(mx.bfloat16)


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
