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
from app.commands._shared import _arg_registered, _option_registered
from app.io_utils import load_image_rgb, require_file
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

# Full-body prompt for denoise=1.0 ControlNet-only variations.
# "classical portraiture" fights V-pose ControlNet guidance; use a neutral full-body prompt
# so the ControlNet signal is not suppressed by portrait crop bias in the text embedding.
_I2I_CNET_FULLBODY_PROMPT = (
    "A single young Asian woman with black hair, full body shot, arms raised high in victory V-pose, "
    "pure white background, studio photography, one person only, no other people, no crowd, "
    "isolated figure, ultra sharp focus, high quality portrait photography."
)

# Clothing-anchored prompt: explicitly describes the source outfit to anchor clothing preservation.
# Hypothesis: adding "white t-shirt, blue jeans" to the prompt gives the model a text prior
# for clothing that competes with / anchors against the sampling drift at dn=0.9.
_I2I_CNET_CLOTHING_PROMPT = (
    "A single young Asian woman with straight black hair, wearing a simple white t-shirt and blue jeans, "
    "full body shot, both arms raised high in a V-shape victory pose above head, "
    "pure white background, studio photography, one person only, "
    "isolated figure, ultra sharp focus, high quality portrait photography."
)

# Self-test variations:
#   (label, denoise_strength, ctrl_strength_or_None, blur_ref_or_None,
#    cnet_active_steps_or_None, steps, prompt_override_or_None)
# Note: blur_ref in ControlNet variations is display-only; actual preprocessing is
# always Canny edges (skip=False in _run_self_test step 3b), which matches Union 2.1 training.
_I2I_SELF_TEST_VARIATIONS = [
    # Row 1: Simple I2I — denoise_strength sweep (no ControlNet)
    ("dn02-9st",                0.2, None,  None, None, 9,  None),
    ("dn04-9st",                0.4, None,  None, None, 9,  None),
    ("dn06-9st",                0.6, None,  None, None, 9,  None),
    ("dn08-9st",                0.8, None,  None, None, 9,  None),

    # Row 2: I2I + ControlNet (canny) — increasing denoise (source anchor weakens)
    # denoise<1.0: source image anchors identity → portrait prompt OK
    ("dn04-cnet-canny-9st",     0.4, 0.6, None, None, 9,  None),
    ("dn06-cnet-canny-9st",     0.6, 0.6, None, None, 9,  None),
    ("dn08-cnet-canny-9st",     0.8, 0.6, None, None, 9,  None),

    # Row 3: Full redraw + ControlNet (smoking gun — verifies ControlNet itself works)
    # denoise=1.0 = pure noise, no source influence. Must use full-body prompt or the text
    # encoder's portrait-crop bias fights the V-pose ControlNet signal.
    ("dn10-cnet-canny-15st-a5", 1.0, 0.6, None, 5, 15, _I2I_CNET_FULLBODY_PROMPT),
]

# Debug variations — minimal set for fast turnaround when debugging ControlNet issues.
# Use --self-test debug to run this instead of the full suite.
_I2I_DEBUG_VARIATIONS = [
    ("debug-dn10-cnet-canny-15st", 1.0, 0.6, None, None, 15, _I2I_CNET_FULLBODY_PROMPT),
]

# ControlNet sweep — tune cnet_active_steps and ctrl_strength to eliminate double-body artifact
# while keeping pose transfer. Triggered by mode="cnet-sweep" in _run_self_test().
# Hypothesis: cnet_active=ALL (15/15 steps) over-constrains and causes ghost duplication;
#             cutting off at step 8-12 should preserve pose but let anatomy converge cleanly.
_I2I_CNET_SWEEP_VARIATIONS = [
    # (label,                        dn,   ctrl, blur, cnet_act, steps, prompt)
    ("cns-act08-str06-15st",         1.0,  0.6,  None, 8,        15,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns-act10-str06-15st",         1.0,  0.6,  None, 10,       15,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns-act12-str06-15st",         1.0,  0.6,  None, 12,       15,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns-actALL-str04-15st",        1.0,  0.4,  None, None,     15,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns-act08-str04-15st",         1.0,  0.4,  None, 8,        15,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns-act08-str08-20st",         1.0,  0.8,  None, 8,        20,   _I2I_CNET_FULLBODY_PROMPT),
]

# Sweep 2 — push ctrl_strength higher (0.9-1.0) with fixed act=8 cutoff.
# act08-str08-20st was PARTIAL (no issues); this sweep tries to force full V-pose
# by increasing ControlNet strength while keeping the step-8 cutoff that prevents double-body.
_I2I_CNET_SWEEP2_VARIATIONS = [
    # (label,                        dn,   ctrl, blur, cnet_act, steps, prompt)
    ("cns2-act08-str09-20st",        1.0,  0.9,  None, 8,        20,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns2-act08-str10-20st",        1.0,  1.0,  None, 8,        20,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns2-act08-str10-25st",        1.0,  1.0,  None, 8,        25,   _I2I_CNET_FULLBODY_PROMPT),
    ("cns2-act06-str10-20st",        1.0,  1.0,  None, 6,        20,   _I2I_CNET_FULLBODY_PROMPT),
]

# Pose sweep — OpenPose skeleton conditioning (joint positions only, no clothing edges).
# Root cause of clothing bleed: Canny captures garment silhouette → ControlNet copies appearance.
# Fix: replace Canny with mediapipe OpenPose skeleton → pure pose signal, no clothing info.
# Tuple has 8th field: preprocess_mode ("canny" | "openpose")
_I2I_CNET_POSE_VARIATIONS = [
    # (label,                        dn,   ctrl, blur, cnet_act, steps, prompt,                    preprocess)
    # Full denoise baseline — same as best Canny result but with OpenPose (no clothing bleed)
    ("pose-dn10-str08-act8-20st",    1.0,  0.8,  None, 8,        20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # Medium denoise — keep source identity (face/clothes), OpenPose guides only pose
    ("pose-dn07-str10-all-20st",     0.7,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    ("pose-dn08-str10-all-20st",     0.8,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    ("pose-dn06-str10-all-20st",     0.6,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # Canny baseline for direct comparison
    ("canny-dn10-str08-act8-20st",   1.0,  0.8,  None, 8,        20,   _I2I_CNET_FULLBODY_PROMPT, "canny"),
]

# Pose sweep 2 — based on feedback from cnet-pose sweep:
#   dn10+act8 → double_body (act=8 not enough), dn08+ALL → partial/bad_hands,
#   dn07+ALL → fail (no pose), dn06+ALL → no_pose, canny+act8 → v_pose_ok but appearance bleed.
# Hypothesis: medium denoise needs cutoff to prevent ghost; dn09 may be sweet spot.
_I2I_CNET_POSE2_VARIATIONS = [
    # (label,                         dn,   ctrl, blur, cnet_act, steps, prompt,                    preprocess)
    # Fill gap between dn08 (partial) and dn10 (ghost) — no cutoff first
    ("pose2-dn09-str10-all-20st",     0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # dn08 was partial (ALL steps) — add act=8 cutoff to prevent ghost
    ("pose2-dn08-str10-act8-20st",    0.8,  1.0,  None, 8,        20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # dn09 + act=8 cutoff — combines the two above hypotheses
    ("pose2-dn09-str10-act8-20st",    0.9,  1.0,  None, 8,        20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # dn10 but act=6 (earlier cutoff than act=8 which still had double_body)
    ("pose2-dn10-str10-act6-20st",    1.0,  1.0,  None, 6,        20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
]

# Pose sweep 3 — all pose2 variants are "partial_pose": ctrl_strength=1.0 cannot override the
# source latent's "arms at sides" momentum at dn=0.8-0.9.
# Hypotheses to test:
#   A) Amplify ctrl_strength >1.0 (1.5, 2.0) — raw signal boost without changing denoise
#   B) dn=0.95 + act=10 — between dn09 partial and dn10 ghost, longer ctrl window
#   C) steps=30 at dn09 — more denoising time for ControlNet to shape the output
_I2I_CNET_POSE3_VARIATIONS = [
    # (label,                          dn,   ctrl, blur, cnet_act, steps, prompt,                    preprocess)
    # A: boost ctrl_strength — does 1.5x push "partial" to full V-pose?
    ("pose3-dn09-str15-all-20st",      0.9,  1.5,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # A: even stronger — 2.0x might finally overcome source latent bias
    ("pose3-dn09-str20-all-20st",      0.9,  2.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # B: dn=0.95 with act=10 cutoff — narrow window between dn09 (partial) and dn10 (ghost)
    ("pose3-dn095-str10-act10-20st",   0.95, 1.0,  None, 10,       20,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
    # C: more steps with same best params — 30 steps gives ctrl more guidance iterations
    ("pose3-dn09-str10-30st",          0.9,  1.0,  None, None,     30,   _I2I_CNET_FULLBODY_PROMPT, "openpose"),
]

# Seed sweep — best params from pose2 (dn=0.9, ctrl=1.0, ALL steps, 20st, openpose)
# run across 8 different seeds to find one where the stochastic sampling lands on a better V-pose.
# 9th field = seed_override (overrides default seed=42 for this variation's generation).
_I2I_CNET_SEED_SWEEP_VARIATIONS = [
    # (label,                   dn,   ctrl, blur, cnet_act, steps, prompt,                    preprocess, seed)
    ("seed-s42",                0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 42),
    ("seed-s43",                0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 43),
    ("seed-s100",               0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 100),
    ("seed-s200",               0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 200),
    ("seed-s300",               0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 300),
    ("seed-s500",               0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 500),
    ("seed-s1000",              0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 1000),
    ("seed-s2025",              0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 2025),
]

# Pose sweep 4 — Blurred Canny strategy.
# Insight from pose3: ctrl_strength>1.0 → pixelation; OpenPose maxes at partial_pose.
# Canny at dn=1.0+act8 achieved v_pose_ok (sweep1) but "too close to reference" (appearance bleed).
# Root cause: Canny captures clothing texture edges → appearance info leaks into ControlNet signal.
# Fix: apply Gaussian blur to reference BEFORE Canny to remove high-freq clothing detail.
# After blur, Canny sees only gross body structure (V-shape arms, leg spread) — no fabric folds.
# Bug fix: _load_and_preprocess() now applies blur before Canny (was skip-only before).
# ctrl_33ch_map now keyed by (mode, blur_ref) to distinguish blurred variants.
_I2I_CNET_POSE4_VARIATIONS = [
    # (label,                              dn,   ctrl, blur, cnet_act, steps, prompt,                    preprocess)
    # Progressive blur levels — find the sweet spot between pose retention and appearance removal
    ("pose4-blur10-dn10-str08-act8-20st",  1.0,  0.8,  10,   8,        20,   _I2I_CNET_FULLBODY_PROMPT, "canny"),
    ("pose4-blur15-dn10-str08-act8-20st",  1.0,  0.8,  15,   8,        20,   _I2I_CNET_FULLBODY_PROMPT, "canny"),
    ("pose4-blur20-dn10-str08-act8-20st",  1.0,  0.8,  20,   8,        20,   _I2I_CNET_FULLBODY_PROMPT, "canny"),
    # Higher ctrl_strength with medium blur — more pose signal without appearance bleed
    ("pose4-blur15-dn10-str10-act8-20st",  1.0,  1.0,  15,   8,        20,   _I2I_CNET_FULLBODY_PROMPT, "canny"),
]


# Dual-guidance sweep — use Union ControlNet inpaint channel as source-appearance anchor.
# Hypothesis: putting source_latent in the inpaint_latent slot (mask > 0) constrains the
# generation to stay close to source clothing/identity while OpenPose guides the pose.
# Tuple has 10th field: inpaint_mask (0.0 = off, 1.0 = full anchor).
# Using seed=43 (confirmed best V-pose + identity from seed sweep).
_I2I_DUAL_GUIDANCE_VARIATIONS = [
    # (label,              dn,   ctrl, blur, cnet_act, steps, prompt,                    preprocess, seed,  inpaint_mask)
    ("dual-m00-s43",       0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,    0.0),  # baseline (same as seed-s43)
    ("dual-m02-s43",       0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,    0.2),
    ("dual-m05-s43",       0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,    0.5),
    ("dual-m08-s43",       0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,    0.8),
    ("dual-m10-s43",       0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,    1.0),
]

# Clothing-prompt sweep — test whether adding explicit clothing description to the prompt
# improves clothing preservation at dn=0.9. Compared to baseline (seed-s43 / dual-m00-s43).
# Also tests best seeds from seed sweep (s43, s200) with the clothing-anchored prompt.
_I2I_CLOTHING_PROMPT_VARIATIONS = [
    # (label,              dn,   ctrl, blur, cnet_act, steps, prompt,                      preprocess, seed)
    ("cloth-s43",          0.9,  1.0,  None, None,     20,   _I2I_CNET_CLOTHING_PROMPT,   "openpose", 43),
    ("cloth-s200",         0.9,  1.0,  None, None,     20,   _I2I_CNET_CLOTHING_PROMPT,   "openpose", 200),
    ("cloth-s43-dn08",     0.8,  1.0,  None, None,     20,   _I2I_CNET_CLOTHING_PROMPT,   "openpose", 43),
    ("cloth-s43-base",     0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT,   "openpose", 43),   # baseline for A/B
]

# Spatial arm mask sweep — torso/head anchored to source (mask=0, clothing preserved),
# arm regions free for ControlNet V-pose (mask=1). Three padding sizes test the
# arm bounding-box tightness/looseness tradeoff.
# 11-field tuple: (label, dn, ctrl, blur, cnet_act, steps, prompt, preprocess, seed, inpaint_mask, arm_pad_frac)
_I2I_SPATIAL_MASK_VARIATIONS = [
    ("spatial-tight-s43",  0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT,  "openpose", 43,   0.0, 0.08),
    ("spatial-med-s43",    0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT,  "openpose", 43,   0.0, 0.14),
    ("spatial-loose-s43",  0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT,  "openpose", 43,   0.0, 0.20),
    ("spatial-med-s200",   0.9,  1.0,  None, None,     20,   _I2I_CNET_FULLBODY_PROMPT,  "openpose", 200,  0.0, 0.14),
]

# 12-field tuple: adds arm_erase_frac at index 11.
# arm_erase_frac > 0: paint source arms white before VAE-encoding inpaint_latent.
# This removes the "arms at sides" anchor that conflicts with ControlNet V-pose guidance.
# inpaint_mask=1.0 anchors the whole image to the arm-erased source:
#   torso → white T-shirt preserved, arm regions → white background (neutral, ControlNet draws V-pose).
_I2I_ARM_ERASE_VARIATIONS = [
    ("arm-erase-r8-m1-s43",   0.9, 1.0, None, None, 20, _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,  1.0, 0.0, 0.08),
    ("arm-erase-r12-m1-s43",  0.9, 1.0, None, None, 20, _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,  1.0, 0.0, 0.12),
    ("arm-erase-r8-m07-s43",  0.9, 1.0, None, None, 20, _I2I_CNET_FULLBODY_PROMPT, "openpose", 43,  0.7, 0.0, 0.08),
    ("arm-erase-r8-m1-s200",  0.9, 1.0, None, None, 20, _I2I_CNET_FULLBODY_PROMPT, "openpose", 200, 1.0, 0.0, 0.08),
]


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

def add_i2i_args(parser: argparse.ArgumentParser) -> None:
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

def run_i2i(args: argparse.Namespace) -> None:
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

    require_file(input_image_path, "input image (--input-image)")

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
    source_img = load_image_rgb(input_image_path).resize((out_w, out_h), Image.LANCZOS)
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
        mx.eval(ctrl_33ch)  # Force materialize before VAE is freed (lazy tensor safety)
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
        ctx_max = float(mx.abs(controlnet_context).max())
        ctx_nan = bool(mx.any(mx.isnan(controlnet_context)))
        print(f"Done → {list(controlnet_context.shape)}  max={ctx_max:.3f} nan={ctx_nan}")

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
        lat_max = float(mx.abs(latents).max())
        lat_nan = bool(mx.any(mx.isnan(latents)))
        print(f"   Step {i + 1}/{steps}: {time.time() - step_start:.2f}s  "
              f"lat_max={lat_max:.3f} nan={lat_nan}  cnet_str={active_strength:.2f}")

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


def _apply_sam_white(img: "Image.Image") -> "Image.Image":
    """Remove background via SAM 3.1 (MLX-native) and composite on pure white."""
    import numpy as np
    from PIL import Image as _Image
    from app.sam3_predictor import get_sam3_predictor, segment_image, feather_mask

    predictor = get_sam3_predictor(threshold=0.3)
    result = segment_image(predictor, img, "person")

    if len(result.scores) == 0:
        print("  [sam3] No person detected — keeping original")
        return img

    best_idx = int(np.argmax(result.scores))
    mask = result.masks[best_idx]  # (H, W) binary uint8

    alpha = feather_mask(mask, radius=3)  # float [0,1]
    img_np = np.array(img.convert("RGB")).astype(np.float32)
    white = np.full_like(img_np, 255.0)
    for c in range(3):
        img_np[:, :, c] = img_np[:, :, c] * alpha + white[:, :, c] * (1.0 - alpha)

    return _Image.fromarray(img_np.astype(np.uint8))


# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

def _run_self_test(args: argparse.Namespace) -> None:
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

    # ── Step 3: Select variations early (needed to know which ctrl modes to encode) ──
    results = []
    st_val = getattr(args, "self_test", True)
    if isinstance(st_val, str) and st_val == "debug":
        variations = _I2I_DEBUG_VARIATIONS
        print(f"\n[Self-Test] Using DEBUG variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "cnet-sweep":
        variations = _I2I_CNET_SWEEP_VARIATIONS
        print(f"\n[Self-Test] Using CNET-SWEEP variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "cnet-sweep2":
        variations = _I2I_CNET_SWEEP2_VARIATIONS
        print(f"\n[Self-Test] Using CNET-SWEEP2 variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "cnet-pose":
        variations = _I2I_CNET_POSE_VARIATIONS
        print(f"\n[Self-Test] Using CNET-POSE variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "cnet-pose2":
        variations = _I2I_CNET_POSE2_VARIATIONS
        print(f"\n[Self-Test] Using CNET-POSE2 variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "cnet-pose3":
        variations = _I2I_CNET_POSE3_VARIATIONS
        print(f"\n[Self-Test] Using CNET-POSE3 variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "cnet-pose4":
        variations = _I2I_CNET_POSE4_VARIATIONS
        print(f"\n[Self-Test] Using CNET-POSE4 variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "seed-sweep":
        variations = _I2I_CNET_SEED_SWEEP_VARIATIONS
        print(f"\n[Self-Test] Using SEED-SWEEP variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "dual-guidance":
        variations = _I2I_DUAL_GUIDANCE_VARIATIONS
        print(f"\n[Self-Test] Using DUAL-GUIDANCE variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "clothing-prompt":
        variations = _I2I_CLOTHING_PROMPT_VARIATIONS
        print(f"\n[Self-Test] Using CLOTHING-PROMPT variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "spatial-mask":
        variations = _I2I_SPATIAL_MASK_VARIATIONS
        print(f"\n[Self-Test] Using SPATIAL-MASK variations ({len(variations)} tests)")
    elif isinstance(st_val, str) and st_val == "arm-erase":
        variations = _I2I_ARM_ERASE_VARIATIONS
        print(f"\n[Self-Test] Using ARM-ERASE variations ({len(variations)} tests)")
    else:
        variations = _I2I_SELF_TEST_VARIATIONS

    # ── Step 4: VAE encode source + all needed ControlNet reference modes ──
    print(f"\n[Self-Test] VAE encoding source image...", end=" ", flush=True)
    vae = _load_vae()
    source_pil = Image.open(source_path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    clean_latent = _vae_encode(vae, source_pil)
    clean_latent = (clean_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR
    print(f"Done → {list(clean_latent.shape)}")

    # Encode ControlNet reference image for each unique
    # (mode, blur_ref, inpaint_mask, arm_pad_frac, arm_erase_frac) 5-tuple key.
    # arm_pad_frac > 0: spatial bbox arm mask (source landmarks).
    # arm_erase_frac > 0: paint source arms white before encoding inpaint_latent.
    ctrl_33ch_map: dict[tuple[str, float | None, float, float, float], mx.array] = {}
    ctrl_33ch = None  # legacy fallback (canny, no blur, no inpaint, no arm ops)
    if ref_path:
        needed_keys = {
            (v[7] if len(v) > 7 else "canny",
             v[3],
             float(v[9]) if len(v) > 9 else 0.0,
             float(v[10]) if len(v) > 10 else 0.0,
             float(v[11]) if len(v) > 11 else 0.0)
            for v in variations if v[2] is not None
        } or {("canny", None, 0.0, 0.0, 0.0)}
        # Pre-extract source landmarks once if any variation needs arm ops
        src_landmarks = None
        if any(k[3] > 0.0 or k[4] > 0.0 for k in needed_keys):
            print("[Self-Test] Extracting source pose landmarks for arm ops...", end=" ", flush=True)
            _, src_landmarks = _apply_openpose(source_pil, return_landmarks=True)
            if src_landmarks is None:
                print("FAILED (no pose detected) — arm-mask/arm-erase variations fall back to uniform mask=0")
            else:
                print("OK")
        for mode, blur, inpaint_mask, arm_pad_frac, arm_erase_frac in sorted(needed_keys):
            blur_label = f"+blur{blur:.0f}" if blur is not None else ""
            inpaint_label = f"+src{inpaint_mask:.1f}" if inpaint_mask > 0.0 else ""
            arm_label = f"+arm{arm_pad_frac:.2f}" if arm_pad_frac > 0.0 else ""
            erase_label = f"+erase{arm_erase_frac:.2f}" if arm_erase_frac > 0.0 else ""
            print(f"[Self-Test] VAE encoding ControlNet reference ({mode}{blur_label}{inpaint_label}{arm_label}{erase_label})...",
                  end=" ", flush=True)
            ref_pil = _load_and_preprocess(ref_path, out_w, out_h, skip=False,
                                            blur_ref=blur, preprocess_mode=mode)
            ctrl_lat = _vae_encode(vae, ref_pil)
            ctrl_lat = (ctrl_lat - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR
            if arm_erase_frac > 0.0 and src_landmarks is not None:
                # Erase source arms → neutral white inpaint_latent in arm regions
                erased_pil = _erase_arms_from_pil(source_pil, src_landmarks, arm_erase_frac)
                erased_lat = _vae_encode(vae, erased_pil)
                erased_lat = (erased_lat - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR
                mx.eval(erased_lat)
                c33 = build_control_input_33ch(ctrl_lat, inpaint_latent=erased_lat,
                                               mask_value=inpaint_mask)
            elif arm_pad_frac > 0.0 and src_landmarks is not None:
                import numpy as _np
                arm_mask_np = _build_arm_mask_latent(src_landmarks, out_w, out_h, arm_pad_frac)
                arm_mask_mx = mx.array(arm_mask_np)
                c33 = build_control_input_33ch(ctrl_lat, inpaint_latent=clean_latent,
                                               mask_spatial=arm_mask_mx)
            elif inpaint_mask > 0.0:
                c33 = build_control_input_33ch(ctrl_lat, inpaint_latent=clean_latent,
                                               mask_value=inpaint_mask)
            else:
                c33 = build_control_input_33ch(ctrl_lat, lambda img: _vae_encode(vae, img))
            mx.eval(c33)
            ctrl_33ch_map[(mode, blur, inpaint_mask, arm_pad_frac, arm_erase_frac)] = c33
            print(f"Done → {list(c33.shape)} max={float(mx.abs(c33).max()):.3f} (evaluated)")
        ctrl_33ch = ctrl_33ch_map.get(("canny", None, 0.0, 0.0, 0.0))

    del vae
    _gc()

    # ── Step 5: Generate variations ───────────────────────────────────────

    for var in variations:
        label, dn_str, ctrl_str, blur_ref, cnet_active, tstps = var[:6]
        prompt_override = var[6] if len(var) > 6 else None
        preprocess_mode = var[7] if len(var) > 7 else "canny"
        seed_override  = var[8] if len(var) > 8 else None
        inpaint_mask   = float(var[9]) if len(var) > 9 else 0.0
        arm_pad_frac   = float(var[10]) if len(var) > 10 else 0.0
        arm_erase_frac = float(var[11]) if len(var) > 11 else 0.0
        prompt = prompt_override if prompt_override is not None else _I2I_SELF_TEST_PROMPT
        gen_seed = seed_override if seed_override is not None else seed

        # Pick the ctrl_33ch for this variation's 5-tuple key
        var_ctrl_33ch = ctrl_33ch_map.get(
            (preprocess_mode, blur_ref, inpaint_mask, arm_pad_frac, arm_erase_frac), ctrl_33ch)

        # Skip ControlNet variations if no reference image
        if ctrl_str is not None and var_ctrl_33ch is None:
            print(f"\n[Self-Test] SKIP {label} (no ControlNet reference)")
            continue

        print(f"\n{'=' * 60}")
        print(f"[Self-Test] {label}")
        print(f"{'=' * 60}")

        img_filename = f"i2i_selftest_{label}-s{gen_seed}.png"
        out_p = os.path.join(cfg.OUTPUT_DIR, img_filename)

        if os.path.exists(out_p):
            print(f"  Reusing cached: {out_p}")
        else:
            use_ctrl = var_ctrl_33ch if ctrl_str is not None else None
            mode_desc = f"I2I+ControlNet({preprocess_mode})" if ctrl_str is not None else "I2I"
            print(f"  Type: {mode_desc} (denoise={dn_str}, steps={tstps})")

            pil_image = _generate(
                prompt=prompt,
                out_w=out_w,
                out_h=out_h,
                steps=tstps,
                seed=gen_seed,
                clean_latent=clean_latent,
                denoise_strength=dn_str,
                ctrl_33ch=use_ctrl,
                controlnet_strength=ctrl_str or 0.6,
                cnet_active_steps=cnet_active,
            )

            if ctrl_str is not None:
                print("  [sam3] Removing background...", end=" ", flush=True)
                pil_image = _apply_sam_white(pil_image)
                print("Done")

            pil_image.save(out_p)
            print(f"  Saved: {out_p}")

        params = {
            "denoise_strength": dn_str,
            "steps": tstps,
            "seed": gen_seed,
        }
        run_config = {
            "command": "image",
            "action": "i2i",
            "pipeline": "zimage",
            "denoise_strength": dn_str,
            "steps": tstps,
            "seed": gen_seed,
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
    # ── Step 6: Simple HTML (skipped when called from image-review, which generates a better one) ──
    if not getattr(args, "skip_inner_html", False):
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
                          skip: bool, blur_ref: float | None = None,
                          preprocess_mode: str = "canny") -> "Image.Image":
    """Load and preprocess reference image for ControlNet.

    preprocess_mode: "canny" (default) or "openpose"
    """
    from PIL import Image, ImageFilter

    img = Image.open(path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    if blur_ref is not None:
        radius = max(1, int(blur_ref))
        img = img.filter(ImageFilter.GaussianBlur(radius=radius))
        print(f"[I2I] Pre-process blur sigma={blur_ref} applied")
    if skip:
        print(f"[I2I] Using raw reference image as control signal")
        return img
    if preprocess_mode == "openpose":
        return _apply_openpose(img)
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


# MediaPipe → OpenPose 18-joint index mapping
# mp indices: nose=0, l_eye=2, r_eye=5, l_ear=7, r_ear=8,
#             l_shoulder=11, r_shoulder=12, l_elbow=13, r_elbow=14,
#             l_wrist=15, r_wrist=16, l_hip=23, r_hip=24,
#             l_knee=25, r_knee=26, l_ankle=27, r_ankle=28
_OP_MP_MAP = [0, None, 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7]
_OP_LIMBS = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7),
    (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
    (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]
_OP_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0),
    (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
    (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255),
    (255, 0, 170), (255, 0, 85),
]


_POSE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
)
_POSE_MODEL_CACHE = os.path.join(os.path.expanduser("~"), ".cache",
                                  "mlx-movie-director", "pose_landmarker.task")


def _ensure_pose_model() -> str:
    """Download mediapipe PoseLandmarker model if not cached. Returns local path."""
    import urllib.request
    if not os.path.exists(_POSE_MODEL_CACHE):
        os.makedirs(os.path.dirname(_POSE_MODEL_CACHE), exist_ok=True)
        print(f"[openpose] Downloading pose model...", end=" ", flush=True)
        urllib.request.urlretrieve(_POSE_MODEL_URL, _POSE_MODEL_CACHE)
        print("Done")
    return _POSE_MODEL_CACHE


def _apply_openpose(pil_img: "Image.Image", return_landmarks: bool = False):
    """Extract body skeleton via mediapipe Tasks API; render OpenPose-style on white bg.

    White background aligns with "clean white background" text prompt so ControlNet
    does not push the generation toward dark/complex backgrounds.
    Falls back to Canny if mediapipe or pose detection fails.

    Args:
        pil_img: Input image.
        return_landmarks: If True, return (skeleton_pil, landmarks_list) tuple
                          so caller can build spatial masks without running MediaPipe twice.
    """
    import numpy as np
    from PIL import Image

    W, H = pil_img.size
    canvas = np.zeros((H, W, 3), dtype=np.uint8)
    lm_out = None

    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python as _mp_py
        from mediapipe.tasks.python import vision as _mp_vis

        model_path = _ensure_pose_model()
        base_opts = _mp_py.BaseOptions(model_asset_path=model_path)
        opts = _mp_vis.PoseLandmarkerOptions(
            base_options=base_opts,
            running_mode=_mp_vis.RunningMode.IMAGE,
            num_poses=1,
            min_pose_detection_confidence=0.5,
        )
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                          data=np.array(pil_img.convert("RGB")))

        with _mp_vis.PoseLandmarker.create_from_options(opts) as detector:
            result = detector.detect(mp_img)

        if not result.pose_landmarks:
            print("[openpose] No pose detected — falling back to Canny", flush=True)
            if return_landmarks:
                return _apply_canny(pil_img), None
            return _apply_canny(pil_img)

        lm = result.pose_landmarks[0]  # first (only) person
        lm_out = lm

        # Build OpenPose 18-joint pixel coordinates
        joints = []
        for i, mp_idx in enumerate(_OP_MP_MAP):
            if mp_idx is None:
                joints.append(None)  # neck placeholder
            else:
                l = lm[mp_idx]
                if l.visibility < 0.3:
                    joints.append(None)
                else:
                    joints.append((int(l.x * W), int(l.y * H)))

        # Joint 1 = Neck = midpoint of L/R shoulders (mp 11, 12)
        ls, rs = lm[11], lm[12]
        if ls.visibility > 0.3 and rs.visibility > 0.3:
            joints[1] = (int((ls.x + rs.x) / 2 * W), int((ls.y + rs.y) / 2 * H))

        r = max(4, W // 80)

        # Draw limbs behind joints
        for a, b in _OP_LIMBS:
            if joints[a] and joints[b]:
                cv2.line(canvas, joints[a], joints[b],
                         _OP_COLORS[a % len(_OP_COLORS)], thickness=max(2, r // 2))

        # Draw joints on top
        for i, pt in enumerate(joints):
            if pt:
                cv2.circle(canvas, pt, r, _OP_COLORS[i % len(_OP_COLORS)], thickness=-1)

    except Exception as e:
        print(f"[openpose] Error: {e} — falling back to Canny", flush=True)
        if return_landmarks:
            return _apply_canny(pil_img), None
        return _apply_canny(pil_img)

    skeleton_pil = Image.fromarray(canvas)
    if return_landmarks:
        return skeleton_pil, lm_out
    return skeleton_pil


def _build_arm_mask_latent(landmarks, img_w: int, img_h: int,
                            padding_frac: float = 0.14):
    """Build spatial inpaint mask: 1.0=preserve source (torso/head), 0.0=free for ControlNet (arms).

    Union ControlNet mask semantics: mask=1 means "use inpaint_latent here" (anchor/preserve),
    mask=0 means "no inpaint guidance" (free generation, ControlNet guides pose).

    So torso/head=1 preserves clothing from source; arm regions=0 lets ControlNet draw V-pose.

    Args:
        landmarks: MediaPipe Landmark list from result.pose_landmarks[0] of SOURCE image.
                   Arm mask computed from source so its arm footprint is freed for new pose.
        img_w, img_h: Source image pixel dimensions (e.g. 1024, 1024).
        padding_frac: Arm bounding-box padding as fraction of latent dimension (default 0.14 ≈ 18px).

    Returns:
        numpy float32 [1, 1, H_lat, W_lat] mask in range [0, 1].
    """
    import numpy as np
    from PIL import Image, ImageFilter

    H_lat, W_lat = img_h // 8, img_w // 8   # 128 × 128 for 1024×1024
    mask = np.ones((H_lat, W_lat), dtype=np.float32)   # default=1: preserve source everywhere
    pad_x = max(2, int(padding_frac * W_lat))
    pad_y = max(2, int(padding_frac * H_lat))

    # Left arm: shoulder(11) → elbow(13) → wrist(15)
    # Right arm: shoulder(12) → elbow(14) → wrist(16)
    arm_lm_sets = [(11, 13, 15), (12, 14, 16)]
    for sh_idx, el_idx, wr_idx in arm_lm_sets:
        sh = landmarks[sh_idx]
        el = landmarks[el_idx]
        wr = landmarks[wr_idx]
        visible = [l for l in [sh, el, wr] if l.visibility >= 0.2]
        if len(visible) < 2:
            continue
        xs = [max(0, min(W_lat - 1, int(l.x * W_lat))) for l in visible]
        ys = [max(0, min(H_lat - 1, int(l.y * H_lat))) for l in visible]
        x1 = max(0, min(xs) - pad_x)
        x2 = min(W_lat, max(xs) + pad_x)
        y1 = max(0, min(ys) - pad_y)
        y2 = min(H_lat, max(ys) + pad_y)
        mask[y1:y2, x1:x2] = 0.0   # arm regions: free for ControlNet to draw V-pose
        side = "L" if sh_idx == 11 else "R"
        print(f"  [arm-mask] {side}_arm bbox lat=({x1},{y1},{x2},{y2})", flush=True)

    # Soft feather at arm boundary to reduce seam artifacts at shoulder attachment
    mask_pil = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    mask_feathered = (np.array(mask_pil.filter(ImageFilter.GaussianBlur(radius=2)))
                      .astype(np.float32) / 255.0)
    return mask_feathered.reshape(1, 1, H_lat, W_lat)


def _erase_arms_from_pil(source_pil, landmarks, radius_frac=0.08):
    """Paint white over arm regions to neutralize arms-at-sides in the inpaint anchor.

    When used as inpaint_latent with mask=1, the erased regions have white background
    instead of arms, so ControlNet can draw V-pose arms without conflicting anchor.

    Args:
        source_pil: PIL Image (source person with arms at sides).
        landmarks: MediaPipe Landmark list from result.pose_landmarks[0].
        radius_frac: Brush radius as fraction of image min-dimension (default 0.08 ≈ 82px at 1024).

    Returns:
        PIL Image copy with arm regions painted white.
    """
    from PIL import ImageDraw

    img = source_pil.copy()
    draw = ImageDraw.Draw(img)
    w, h = img.size
    r = max(20, int(radius_frac * min(w, h)))

    for sh_idx, el_idx, wr_idx in [(11, 13, 15), (12, 14, 16)]:
        pts = []
        for idx in [sh_idx, el_idx, wr_idx]:
            lm = landmarks[idx]
            if lm.visibility >= 0.2:
                pts.append((int(lm.x * w), int(lm.y * h)))
        if len(pts) < 2:
            continue
        for i in range(len(pts) - 1):
            draw.line([pts[i], pts[i + 1]], fill=(255, 255, 255), width=2 * r)
        for px, py in pts:
            draw.ellipse([(px - r, py - r), (px + r, py + r)], fill=(255, 255, 255))
        side = "L" if sh_idx == 11 else "R"
        print(f"  [arm-erase] {side}_arm erased at {pts} radius={r}px", flush=True)

    return img


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
