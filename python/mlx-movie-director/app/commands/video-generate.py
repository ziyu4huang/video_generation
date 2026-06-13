"""video-generate — LTX-2.3 22B video generation (T2V, I2V, A2V, FLF2V) on Apple Silicon.

Modes:
  T2V   — text-to-video (--prompt only)
  I2V   — image-to-video (--input-image + --prompt)
  A2V   — audio-to-video (--audio + --prompt)
  FLF2V — first-last-frame interpolation (--begin-image + --end-image + --prompt)

FLF2V keyframe generation best practice (proven across 6 experiments):
  1. Generate begin frame: same seed, free generation
  2. Generate end frame:   same seed, DIFFERENT prompt (pose/expression),
                            --input <begin_frame> (background consistency)
  3. Run FLF2V:            cfg_scale auto-set to 3.0 (not 5.0)

CFG mechanism:
  cfg_scale controls TEXT GUIDANCE ONLY. It does not affect keyframe enforcement.
  Keyframes are preserved deterministically via denoise_mask=0.0 — lowering
  cfg_scale never risks "not reaching the end frame", it only changes how
  smoothly the model interpolates between keyframes.

  - cfg_scale=5.0: aggressive text guidance → jump cuts (T2V/I2V default)
  - cfg_scale=3.0: soft guidance → smooth interpolation (FLF2V optimal)
  - cfg_scale=1.0: no text guidance → model-driven (distilled mode)

Extracted from video.py as the "generate" sub-action module.
Exports: add_generate_args(), run_generate().
"""

import os
import shutil
import subprocess
import sys
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name, make_output_paths, resolve_prompt, run_session
from app.ltx_variants import get_variant
from app.manifest import Manifest, file_fingerprint
from app.run_config import RunConfig
from app.test_prompts_video import get_test_prompt, list_test_prompt_names

_VALID_FRAMES_MSG = (
    "must satisfy 8k+1: 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121, ..."
)


def add_generate_args(parser):
    """Register video generation arguments."""
    prompt_grp = parser.add_mutually_exclusive_group()
    prompt_grp.add_argument("--prompt", type=str, help="Text prompt")
    prompt_grp.add_argument("--prompt-file", type=str,
                            help="Path to a .txt file containing the prompt")
    prompt_grp.add_argument("--test-prompt", type=str, dest="test_prompt",
                            choices=list_test_prompt_names(), metavar="NAME",
                            help="Built-in test prompt (choices: %(choices)s)")

    parser.add_argument("--width", type=int, default=704,
                        help="Video width — auto-adjusted to nearest multiple of 64 (default: 704)")
    parser.add_argument("--height", type=int, default=448,
                        help="Video height — auto-adjusted to nearest multiple of 64 (default: 448)")
    parser.add_argument("--frames", type=int, default=97,
                        help="Number of frames — auto-adjusted to nearest 8k+1 (default: 97)")
    parser.add_argument("--fps", type=float, default=24.0,
                        help="Output frame rate (default: 24.0)")

    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Reference image for I2V conditioning (optional)")
    parser.add_argument("--audio", type=str, default=None, metavar="PATH",
                        help="Audio file for A2V mode (.wav/.mp3, optional)")

    # FLF2V (First-Last Frame to Video / 首尾帧视频生成)
    flf2v_grp = parser.add_argument_group(
        "FLF2V (First-Last Frame to Video)",
        description=(
            "Interpolate between begin/end keyframe images. Keyframes are enforced "
            "deterministically via denoise_mask (not CFG) — the model always reaches "
            "the end frame regardless of cfg_scale. "
            "Best practice: generate keyframes with same seed + different prompt + --input "
            "reference for background consistency. See module docstring for details."
        ))
    flf2v_grp.add_argument("--begin-image", type=str, default=None, metavar="PATH",
                           help="Begin frame image for FLF2V mode (requires --end-image)")
    flf2v_grp.add_argument("--end-image", type=str, default=None, metavar="PATH",
                           help="End frame image for FLF2V mode (requires --begin-image)")
    flf2v_grp.add_argument("--begin-strength", type=float, default=1.0,
                           help="Begin frame conditioning strength 0-1 (default: 1.0). "
                                "Controls how strictly the model matches the begin frame. "
                                "Lower values allow more creative motion freedom.")
    flf2v_grp.add_argument("--end-strength", type=float, default=1.0,
                           help="End frame conditioning strength 0-1 (default: 1.0). "
                                "Controls how strictly the model matches the end frame. "
                                "Lower values allow more motion freedom near the end.")

    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed (default: 42)")
    parser.add_argument("--cfg-scale", type=float, default=5.0, dest="cfg_scale",
                        help="Text guidance scale. Controls how strongly the model follows "
                             "the text prompt. Does NOT affect keyframe enforcement (FLF2V) "
                             "or image conditioning (I2V) — those use a separate mechanism. "
                             "Auto-set: 3.0 for FLF2V, 1.0 for --distilled. (default: 5.0)")
    parser.add_argument("--stg-scale", type=float, default=1.0, dest="stg_scale",
                        help="Spatial-temporal guidance scale (default: 1.0)")
    parser.add_argument("--stage1-steps", type=int, default=None,
                        help="Stage 1 denoising steps (default: 8 standard/distilled, "
                             "15 for --hq, 20 for FLF2V). Use 30 for max quality — slower on MPS. "
                             "For VOICE/speech quality use 16 (8 steps produces audio noise); "
                             "see docs/ltx-voice.md.")
    parser.add_argument("--stage2-steps", type=int, default=None,
                        help="Stage 2 refinement steps (default: 3)")

    parser.add_argument("--low-ram", action="store_true", default=False,
                        help="Block-streaming mode — ~75%% lower peak Metal RAM, slower per step")
    parser.add_argument("--hq", action="store_true", default=False,
                        help="Use HQ pipeline with res_2s second-order sampler — higher quality, "
                             "~2× slower per step. Default stage1_steps becomes 15.")
    parser.add_argument("--distilled", action="store_true", default=False,
                        help="Use distilled transformer (8 steps, CFG=1) — faster generation, "
                             "no LoRA stage. Auto-sets stage1_steps=8, cfg_scale=1.0. "
                             "Equivalent to --transformer distilled.")
    parser.add_argument("--transformer", type=str, default=None,
                        choices=["dev", "distilled", "dasiwa"],
                        help="Transformer variant to load (default: dev, or distilled if "
                             "--distilled). 'dasiwa' = a DaSiWa dev-architecture finetune "
                             "(converted via convert.py --ltx-checkpoint); behaves like dev "
                             "(CFG/STG on) but loads models/ltx-mlx/dasiwa/.")
    parser.add_argument("--teacache", action="store_true", default=False,
                        help="Enable TeaCache timestep-aware caching — ~1.46× speedup "
                             "with minimal quality loss (vendor calibrated for LTX-2)")
    parser.add_argument("--teacache-thresh", type=float, default=None, metavar="THRESH",
                        help="TeaCache threshold override (lower=safer, higher=faster; "
                             "default: 0.5 Euler, 1.0 HQ)")
    parser.add_argument("--video-model", type=str, default=None, metavar="PATH",
                        help=(
                            "Local flat model dir or HF repo ID "
                            "(default: auto-detect from models/ or HF auto-download)"
                        ))

    parser.add_argument("--first-frame", action="store_true", default=False,
                        help="Extract first frame to <base>.png via ffmpeg — useful as input for a follow-up I2V or FLF2V run")
    parser.add_argument("--caption", action="store_true", default=False,
                        help="Extract first frame and run 'run.py caption' on it (implies --first-frame)")
    # NOTE: --caption-style is defined in video-compare.add_compare_args() and
    # shared across the flat `video` parser (generate/compare/etc. all add to
    # one parser in video.add_args). Both consumers apply their own fallback
    # default (generate -> "default", compare -> "prompt"). 'review' yields the
    # structured scores the comparison HTML consumes.
    parser.add_argument("--enhance-prompt", action="store_true", default=False,
                        help="Use Gemma to expand terse prompts into detailed cinematographic "
                             "descriptions before generation (~10-20s extra overhead)")

    parser.add_argument("--variations", type=int, default=1,
                        help="Number of variations for A/B testing (default: 1)")
    parser.add_argument("--ab-params", type=str, default=None, metavar="JSON",
                        help=(
                            "Per-variation parameter overrides as JSON dict of arrays. "
                            "Keys: cfg_scale, stg_scale, seed, stage1_steps, stage2_steps. "
                            "Example: '{\"cfg_scale\":[3,5],\"stg_scale\":[1,0.5]}'"
                        ))

    parser.add_argument("--allow-noise", action="store_true", default=False,
                        help="Skip audio RMS noise check and proceed even if audio appears silent or clipped (A2V only)")

    parser.add_argument("--audio-stage1-only", action="store_true", default=False,
                        help="Use stage 1 audio latent only (skip stage 2 audio refinement). "
                             "May improve audio quality — see upstream LTX-2 issue #126.")

    parser.add_argument("--audio-volume", type=float, default=50.0, metavar="GAIN",
                        help="Post-process audio volume multiplier (default: 50). "
                             "LTX-2.3 MLX audio is ~50x too quiet. Use 1 to disable.")

    parser.add_argument("--audio-cfg-scale", type=float, default=None, metavar="SCALE",
                        help="Audio CFG guidance scale (default: 7.0, upstream hardcoded). "
                             "Try 1.0 to disable audio CFG, 3.0 for less aggressive guidance.")

    parser.add_argument("--yes", "-y", action="store_true", default=False,
                        help="Skip interactive confirmation prompts (non-interactive / scripting mode)")

    parser.add_argument("--temporal-upscale", action="store_true", default=False,
                        dest="temporal_upscale",
                        help="Apply 2x temporal upsampling after generation (F → 2F-1 frames, "
                             "smoother motion). Requires temporal_upscaler_x2_v1_0.safetensors. "
                             "Not compatible with --audio (A2V mode).")

    # LoRA (style/quality enhancement)
    parser.add_argument("--lora-path", type=str, default=None, metavar="PATH",
                        help="Style/quality LoRA for video generation (.safetensors). "
                             "Accepts full path, directory, or short name "
                             "(e.g. singularity-omnicine-v1, ltx-2-3-transition)")
    parser.add_argument("--lora-scale", type=float, default=1.0,
                        help="LoRA scale factor (default: 1.0)")


# ---------------------------------------------------------------------------
# Runtime estimation (empirical model from benchmarks)
# ---------------------------------------------------------------------------
# Calibrated on Apple Silicon MPS, LTX-2.3 22B Q8, ~21 GB peak RAM.
# Per-million-pixel linear model. Accurate for large/long generations
# (the cases where estimates matter most). Overestimates small/short runs.
# Stage 2 is ~2× slower per step than stage 1 (refinement at full res).
# Default stage1_steps=8 (official distilled schedule; was 6 before v7).
#
# T2V/I2V (distilled pipeline):
#   Calibrated from 1216×704×241 run: stage1=48.8s/step, stage2=102s/step,
#   decode=51.8s. Linear model accurate to ~5% for long generations.
#
# FLF2V (dev transformer pipeline):
#   Calibrated from 640×960×241 (148.1 Mpx) runs with stage1=16, stage2=3:
#     Run 1: stage1 avg 42.4 s/it, stage2 avg 80.2 s/it, decode=39.4s → 967.5s
#     Run 2: stage1 avg 44.8 s/it, stage2 avg 83.0 s/it, decode=40.6s → 1015.6s
#   Dev transformer is ~28% slower per step than distilled (larger model,
#   no distillation optimization). FLF2V default stage1_steps=20 (not 8).
_BENCH_S1_SLOPE = 0.237          # seconds per Mpixel per stage1 step (distilled)
_BENCH_S2_SLOPE = 0.495          # seconds per Mpixel per stage2 step (distilled)
_BENCH_DECODE = 0.251            # seconds per Mpixel for VAE decode + mux
_BENCH_OVERHEAD = 7.4            # fixed overhead (text encode, model load, audio)

_BENCH_FLF2V_S1_SLOPE = 0.303   # seconds per Mpixel per stage1 step (dev transformer)
_BENCH_FLF2V_S2_SLOPE = 0.561   # seconds per Mpixel per stage2 step (dev transformer)
_BENCH_FLF2V_DECODE = 0.274     # seconds per Mpixel for VAE decode + mux
_BENCH_FLF2V_OVERHEAD = 7.0     # fixed overhead (text encode + model load)


def _estimate_runtime(args, variations: int = 1) -> float:
    """Estimate total generation time in seconds based on empirical benchmarks.

    Uses different benchmark constants for FLF2V (dev transformer) vs
    T2V/I2V (distilled pipeline). FLF2V dev transformer is ~28% slower
    per step but requires fewer default steps (20 vs 8 for distilled).
    """
    mpx = args.width * args.height * args.frames / 1_000_000
    is_flf2v = bool(getattr(args, "begin_image", None))

    if is_flf2v:
        s1_slope = _BENCH_FLF2V_S1_SLOPE
        s2_slope = _BENCH_FLF2V_S2_SLOPE
        decode_slope = _BENCH_FLF2V_DECODE
        overhead = _BENCH_FLF2V_OVERHEAD
    else:
        s1_slope = _BENCH_S1_SLOPE
        s2_slope = _BENCH_S2_SLOPE
        decode_slope = _BENCH_DECODE
        overhead = _BENCH_OVERHEAD

    # HQ (res_2s) does 2 sub-evaluations per step, so ~2× slower per step
    hq_mult = 2.0 if getattr(args, "hq", False) else 1.0

    s1_time = args.stage1_steps * s1_slope * mpx * hq_mult
    s2_time = args.stage2_steps * s2_slope * mpx

    # Dev/dasiwa transformer is ~28% slower per step than distilled; the T2V/I2V
    # slopes above are distilled-calibrated, so scale them for dev-architecture
    # variants. (The FLF2V slopes are already dev-calibrated, so no scaling there.)
    if not is_flf2v:
        bench_mult = get_variant(
            getattr(args, "transformer", None), getattr(args, "distilled", False)
        ).bench_mult
        s1_time *= bench_mult
        s2_time *= bench_mult

    decode = decode_slope * mpx
    single_run = s1_time + s2_time + decode + overhead

    # TeaCache saves ~31% on stage 1 time (vendor calibrated: 1.46× speedup)
    if getattr(args, "teacache", False):
        teacache_savings = 0.31 * s1_time
        single_run -= teacache_savings

    return single_run * variations


def _adjust_resolution(width: int, height: int) -> tuple[int, int]:
    """Auto-adjust width/height to nearest values valid for LTX-2.3.

    Constraints: both dimensions must be divisible by 64.
    The two-stage pipeline uses floor(height/2/32), so only multiples of 64
    survive Stage 1 → Stage 2 without a silent dimension change.
    """
    aligned_w = round(width / 64) * 64
    aligned_h = round(height / 64) * 64
    aligned_w = max(64, aligned_w)
    aligned_h = max(64, aligned_h)

    if aligned_w != width or aligned_h != height:
        print(f"[video] Resolution adjusted: {width}×{height} → {aligned_w}×{aligned_h} "
              f"(must be divisible by 64)")

    return aligned_w, aligned_h


def _adjust_frames(frames: int) -> int:
    """Auto-adjust frame count to nearest valid value for LTX-2.3.

    Constraint: frames must satisfy (frames-1) % 8 == 0 (i.e. 8k+1 pattern).
    Adjusts to the nearest valid value and prints what changed.
    """
    if (frames - 1) % 8 == 0:
        return frames

    # Find nearest valid value (round to nearest 8k+1)
    k = round((frames - 1) / 8)
    adjusted = 8 * k + 1
    if adjusted < 9:
        adjusted = 9  # minimum meaningful frame count

    print(f"[video] Frames adjusted: {frames} → {adjusted} "
          f"(must satisfy 8k+1: 9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, ...)")

    return adjusted


# Argparse defaults for detecting user overrides (must match add_generate_args)
_ARGPARSE_DIM_DEFAULTS = {"width": 704, "height": 448}


def _fit_to_image(image_path: str, width: int, height: int) -> tuple[int, int]:
    """Adjust video dimensions to match input image aspect ratio.

    When the user provides --input-image without explicit --width/--height,
    auto-adjusts the video dimensions to minimize center-cropping.
    When dimensions are explicit, warns if image aspect ratio differs significantly.

    Returns:
        (width, height) — potentially adjusted to match image aspect ratio.
    """
    try:
        from PIL import Image
        img = Image.open(image_path)
        img_w, img_h = img.size
        img.close()
    except ImportError:
        return width, height

    img_ratio = img_w / img_h
    video_ratio = width / height
    ratio_diff = abs(img_ratio - video_ratio) / max(img_ratio, video_ratio)

    print(f"[video] Input image: {os.path.basename(image_path)} "
          f"({img_w}×{img_h}, aspect {img_ratio:.2f}:1)")

    if ratio_diff < 0.03:
        # Close enough — no adjustment needed
        print(f"[video] Video target: {width}×{height} — aspect match ✓")
        return width, height

    # Auto-fit: keep the shorter dimension, adjust the other to match image ratio
    if width >= height:
        # Landscape: keep height, adjust width
        new_w = round(height * img_ratio / 64) * 64
        new_w = max(64, new_w)
        if new_w != width:
            print(f"[video] Auto-fit to image: {width}×{height} → {new_w}×{height} "
                  f"(aspect {img_ratio:.2f}:1, was {video_ratio:.2f}:1)")
        return new_w, height
    else:
        # Portrait: keep width, adjust height
        new_h = round(width / img_ratio / 64) * 64
        new_h = max(64, new_h)
        if new_h != height:
            print(f"[video] Auto-fit to image: {width}×{height} → {width}×{new_h} "
                  f"(aspect {img_ratio:.2f}:1, was {video_ratio:.2f}:1)")
        return width, new_h


def _fit_to_dual_images(begin_path: str, end_path: str, width: int, height: int) -> tuple[int, int]:
    """Adjust video dimensions to match both begin/end images for FLF2V mode.

    Strategy: compute the geometric mean of both image aspect ratios, then
    auto-fit width/height to that average ratio. Warns if ratios differ
    significantly.

    Returns:
        (width, height) — potentially adjusted.
    """
    import math

    try:
        from PIL import Image
        begin_img = Image.open(begin_path)
        end_img = Image.open(end_path)
        begin_w, begin_h = begin_img.size
        end_w, end_h = end_img.size
        begin_img.close()
        end_img.close()
    except ImportError:
        return width, height

    begin_ratio = begin_w / begin_h
    end_ratio = end_w / end_h

    print(f"[video] Begin image: {os.path.basename(begin_path)} "
          f"({begin_w}×{begin_h}, aspect {begin_ratio:.2f}:1)")
    print(f"[video] End image:   {os.path.basename(end_path)} "
          f"({end_w}×{end_h}, aspect {end_ratio:.2f}:1)")

    ratio_diff = abs(begin_ratio - end_ratio) / max(begin_ratio, end_ratio)
    if ratio_diff > 0.1:
        print(f"[video] WARNING: begin/end image aspect ratios differ significantly "
              f"({begin_ratio:.2f}:1 vs {end_ratio:.2f}:1). Using average.")

    # Geometric mean of the two aspect ratios for balanced framing
    avg_ratio = math.sqrt(begin_ratio * end_ratio)
    video_ratio = width / height
    ratio_diff = abs(avg_ratio - video_ratio) / max(avg_ratio, video_ratio)

    if ratio_diff < 0.03:
        print(f"[video] Video target: {width}×{height} — aspect match ✓")
        return width, height

    # Auto-fit: keep the shorter dimension, adjust the other
    if width >= height:
        new_w = round(height * avg_ratio / 64) * 64
        new_w = max(64, new_w)
        if new_w != width:
            print(f"[video] Auto-fit to dual images: {width}×{height} → {new_w}×{height} "
                  f"(avg aspect {avg_ratio:.2f}:1)")
        return new_w, height
    else:
        new_h = round(width / avg_ratio / 64) * 64
        new_h = max(64, new_h)
        if new_h != height:
            print(f"[video] Auto-fit to dual images: {width}×{height} → {width}×{new_h} "
                  f"(avg aspect {avg_ratio:.2f}:1)")
        return width, new_h


def run_generate(args):
    """Entry point for video generation."""
    _run_generate_inner(args)


def _run_generate_inner(args):
    # If --test-prompt selected, inject its prompt text and apply recommended defaults
    test_prompt_name = getattr(args, "test_prompt", None)
    if test_prompt_name:
        tp = get_test_prompt(test_prompt_name)
        args.prompt = tp["prompt"]
        _apply_prompt_defaults(args, tp.get("defaults") or {})

    try:
        prompt = resolve_prompt(args)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # --- FLF2V mode validation ---
    begin_image = getattr(args, "begin_image", None)
    end_image = getattr(args, "end_image", None)

    # --- Prompt enhancement (optional, uses Gemma to expand terse prompts) ---
    if getattr(args, "enhance_prompt", False):
        prompt = _enhance_prompt(prompt, image_path=begin_image or args.input_image)

    if begin_image and not end_image:
        print("ERROR: --begin-image requires --end-image", file=sys.stderr)
        sys.exit(1)
    if end_image and not begin_image:
        print("ERROR: --end-image requires --begin-image", file=sys.stderr)
        sys.exit(1)
    if begin_image and args.input_image:
        print("ERROR: --begin-image and --input-image are mutually exclusive",
              file=sys.stderr)
        sys.exit(1)
    if begin_image and args.audio:
        print("ERROR: FLF2V mode (--begin-image) does not support audio conditioning",
              file=sys.stderr)
        sys.exit(1)
    if begin_image and not os.path.exists(begin_image):
        print(f"ERROR: begin image not found: {begin_image}", file=sys.stderr)
        sys.exit(1)
    if end_image and not os.path.exists(end_image):
        print(f"ERROR: end image not found: {end_image}", file=sys.stderr)
        sys.exit(1)
    if begin_image and getattr(args, "teacache", False):
        print("[video] WARNING: --teacache is not supported in FLF2V mode — ignoring",
              file=sys.stderr)
        args.teacache = False

    # --- Auto-adjust resolution and frames for pipeline constraints ---
    # Fit video dimensions to input image(s) aspect ratio
    image_path = args.input_image
    if begin_image:
        args.width, args.height = _fit_to_dual_images(
            begin_image, end_image, args.width, args.height)
    elif image_path and os.path.exists(image_path):
        args.width, args.height = _fit_to_image(image_path, args.width, args.height)

    args.width, args.height = _adjust_resolution(args.width, args.height)
    args.frames = _adjust_frames(args.frames)

    # --- HQ mode: default to 15 steps (res_2s second-order sampler) ---
    hq = getattr(args, "hq", False)
    if hq and args.stage1_steps is None:
        args.stage1_steps = 15  # HQ optimal (res_2s second-order sampler)
        print(f"[video] HQ mode: stage1_steps auto-set to 15 (res_2s sampler)")

    # --- Transformer selection: resolve via the variant registry. ---
    # --transformer (if given) wins; otherwise fall back to the --distilled flag.
    # dasiwa is a dev-architecture finetune → behaves like dev (CFG/STG on); only
    # the loaded weights differ. Drive the existing distilled-mode logic from the
    # resolved value so both flag styles work.
    transformer = get_variant(
        getattr(args, "transformer", None), getattr(args, "distilled", False)
    ).key
    args.transformer = transformer
    args.distilled = transformer == "distilled"
    distilled = args.distilled
    if transformer == "dasiwa":
        print("[video] Transformer: dasiwa (DaSiWa dev-architecture finetune — CFG/STG on)")

    # --- Distilled mode: auto-adjust defaults ---
    if distilled:
        if hq:
            print("ERROR: --distilled and --hq are mutually exclusive", file=sys.stderr)
            sys.exit(1)
        args.cfg_scale = 1.0
        args.stg_scale = 0.0
        if args.stage1_steps is None:
            args.stage1_steps = 8
        if args.stage2_steps is None:
            args.stage2_steps = 3
        print(f"[video] Distilled mode: cfg_scale=1.0, stg_scale=0.0, "
              f"stage1_steps={args.stage1_steps}, stage2_steps={args.stage2_steps}")

    # --- FLF2V mode: dev transformer needs more steps, lower CFG ---
    if begin_image:
        if args.stage1_steps is None:
            args.stage1_steps = 20
            print("[video] FLF2V mode: stage1_steps auto-set to 20 (dev transformer)")
        if args.cfg_scale == 5.0:  # 5.0 is argparse default for T2V/I2V
            args.cfg_scale = 3.0
            print("[video] FLF2V mode: cfg_scale auto-set to 3.0 (dev transformer)")

    # --- Base defaults for T2V/I2V standard mode ---
    if args.stage1_steps is None:
        args.stage1_steps = 8
    if args.stage2_steps is None:
        args.stage2_steps = 3

    audio_path = args.audio

    if audio_path and not os.path.exists(audio_path):
        print(f"ERROR: audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)
    if image_path and not os.path.exists(image_path):
        print(f"ERROR: input image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    # Parse --ab-params JSON
    ab_params = None
    if args.ab_params:
        import json as _json
        try:
            ab_params = _json.loads(args.ab_params)
        except _json.JSONDecodeError as e:
            print(f"ERROR: --ab-params is not valid JSON: {e}", file=sys.stderr)
            sys.exit(1)

    variations = max(1, getattr(args, "variations", 1))

    # Validate ab-params array lengths
    if ab_params:
        for key, values in ab_params.items():
            if not isinstance(values, list):
                print(f"ERROR: --ab-params key '{key}' must be an array, "
                      f"got {type(values).__name__}", file=sys.stderr)
                sys.exit(1)
            if len(values) != variations:
                print(f"ERROR: --ab-params key '{key}' has {len(values)} values "
                      f"but --variations is {variations}", file=sys.stderr)
                sys.exit(1)

    if variations > 1:
        # Auto-enable caption for A/B variations
        args.first_frame = True
        args.caption = True

    # --- Pre-flight summary ---
    duration_s = args.frames / args.fps
    print(f"[video] Resolution: {args.width}×{args.height}  "
          f"Duration: {args.frames} frames @ {args.fps:.0f}fps = {duration_s:.1f}s")

    if variations > 1:
        print(f"\nA/B Test: {variations} variations (seed={args.seed})")
        labels = [chr(65 + i) for i in range(variations)]  # A, B, C, ...
        for vi in range(variations):
            var_args = _override_args(args, vi, ab_params)
            var_eta = _estimate_runtime(var_args, 1)
            diff_parts = []
            if ab_params:
                for key, values in ab_params.items():
                    diff_parts.append(f"{key}={values[vi]}")
            diff_str = ", ".join(diff_parts) if diff_parts else "default params"
            print(f"  {labels[vi]}: {diff_str}  → est {var_eta:.0f}s ({var_eta / 60:.1f} min)")
        total_eta = _estimate_runtime(args, variations)
        print(f"  Total estimated: {total_eta:.0f}s ({total_eta / 60:.1f} min)")
    else:
        eta = _estimate_runtime(args, 1)
        print(f"[video] Estimated: {eta:.0f}s ({eta / 60:.1f} min)")

    # --- FLF2V confirmation (interactive guard before expensive run) ---
    if begin_image and not getattr(args, "yes", False):
        print(f"\n[video] FLF2V: {os.path.basename(begin_image)} → "
              f"{os.path.basename(end_image)}")
        print(f"[video]   stage1_steps={args.stage1_steps}  "
              f"cfg_scale={args.cfg_scale}  seed={args.seed}")
        try:
            confirm = input("[video] Proceed? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            confirm = ""
        if confirm not in ("y", "yes"):
            print("[video] Cancelled.")
            sys.exit(0)

    if variations > 1:
        _run_variations(args, prompt, variations, ab_params)
    else:
        _run_single(args, prompt)


def _ltx_pipeline_name(args) -> str:
    """Return the canonical pipeline name for RunConfig based on active mode."""
    transformer = get_variant(
        getattr(args, "transformer", None), getattr(args, "distilled", False)
    ).key
    if getattr(args, "begin_image", None):
        return "ltx-dasiwa-flf2v" if transformer == "dasiwa" else "ltx-flf2v"
    if transformer == "distilled":
        if getattr(args, "input_image", None):
            return "ltx-distilled-i2v"
        return "ltx-distilled"
    if getattr(args, "audio", None):
        return "ltx-dasiwa-a2v" if transformer == "dasiwa" else "ltx-a2v"
    if getattr(args, "hq", False):
        return "ltx-dasiwa-hq" if transformer == "dasiwa" else "ltx-hq"
    if getattr(args, "input_image", None):
        return "ltx-dasiwa-i2v" if transformer == "dasiwa" else "ltx-i2v"
    return "ltx-dasiwa" if transformer == "dasiwa" else "ltx-t2v"


def _mode_label(args) -> str:
    """Return a human-readable mode label for log messages and manifest."""
    if getattr(args, "begin_image", None):
        return "FLF2V"
    distilled = getattr(args, "distilled", False)
    audio = getattr(args, "audio", None)
    image = getattr(args, "input_image", None)
    if distilled and image:
        return "Distilled-I2V"
    if distilled and audio:
        return "Distilled-A2V"
    if distilled:
        return "Distilled"
    if audio:
        return "A2V"
    if getattr(args, "hq", False):
        return "HQ"
    if image:
        return "I2V"
    return "T2V"


def _run_single(args, prompt: str) -> None:
    """Generate a single video."""
    frames = args.frames
    audio_path = args.audio
    image_path = args.input_image
    begin_image = getattr(args, "begin_image", None)
    end_image = getattr(args, "end_image", None)
    hq = getattr(args, "hq", False)
    distilled = getattr(args, "distilled", False)

    args.pipeline = _ltx_pipeline_name(args)
    run_config = RunConfig.from_args(args, command="video generate")
    paths = make_output_paths(ext=".mp4")
    output_mp4 = paths.output_file

    mode = _mode_label(args)

    flf2v_info = ""
    if begin_image:
        flf2v_info = (f"  begin_strength={getattr(args, 'begin_strength', 1.0)}"
                      f"  end_strength={getattr(args, 'end_strength', 1.0)}")
    print(f"[video] Mode: {mode}  Resolution: {args.width}×{args.height}  "
          f"Frames: {frames}  FPS: {args.fps}")
    temporal_upscale = getattr(args, "temporal_upscale", False)
    print(f"[video] low-ram: {args.low_ram}  seed: {args.seed}"
          f"{'  hq: True' if hq else ''}"
          f"{'  teacache: True' if getattr(args, 'teacache', False) else ''}"
          f"{'  temporal-upscale: True' if temporal_upscale else ''}"
          f"{flf2v_info}")
    if temporal_upscale and frames:
        print(f"[video]   temporal-upscale: {frames} → {frames * 2 - 1} frames out")

    json_summary = getattr(args, "json_summary", False)
    with run_session(paths, run_config, json_summary=json_summary) as ctx:
        from app.ltx_pipeline import LTXVideoPipeline

        pipeline = LTXVideoPipeline(
            model_dir=args.video_model,
            low_ram=args.low_ram,
            hq=hq,
            distilled=distilled,
            transformer=getattr(args, "transformer", None),
            temporal_upscale=temporal_upscale,
            lora_path=getattr(args, "lora_path", None),
            lora_scale=getattr(args, "lora_scale", 1.0),
        )

        if begin_image:
            timings = pipeline.generate_flf2v(
                prompt=prompt,
                output_path=output_mp4,
                begin_image=begin_image,
                end_image=end_image,
                height=args.height,
                width=args.width,
                num_frames=frames,
                frame_rate=args.fps,
                seed=args.seed,
                stage1_steps=args.stage1_steps,
                stage2_steps=args.stage2_steps,
                cfg_scale=args.cfg_scale,
                stg_scale=args.stg_scale,
                begin_strength=getattr(args, "begin_strength", 1.0),
                end_strength=getattr(args, "end_strength", 1.0),
            )
        else:
            timings = pipeline.generate(
                prompt=prompt,
                output_path=output_mp4,
                height=args.height,
                width=args.width,
                num_frames=frames,
                frame_rate=args.fps,
                seed=args.seed,
                stage1_steps=args.stage1_steps,
                stage2_steps=args.stage2_steps,
                cfg_scale=args.cfg_scale,
                stg_scale=args.stg_scale,
                image=image_path,
                audio_path=audio_path,
                audio_stage1_only=getattr(args, "audio_stage1_only", False),
                audio_cfg_scale=getattr(args, "audio_cfg_scale", None),
                enable_teacache=getattr(args, "teacache", False),
                teacache_thresh=getattr(args, "teacache_thresh", None),
            )

        # --- Audio volume boost (LTX-2.3 MLX audio is ~50x too quiet) ---
        # Skip for A2V mode: upstream pipeline uses original input audio at normal volume.
        audio_volume = getattr(args, "audio_volume", None)
        if audio_volume is not None and audio_volume != 1.0 and not audio_path:
            _boost_audio_volume(output_mp4, audio_volume)

        # --- Audio noise detection ---
        allow_noise = getattr(args, "allow_noise", False)
        _check_audio_noise(output_mp4, allow_noise=allow_noise)

        ctx["timings"] = timings
        ctx["outputs"] = [{
            "path": output_mp4,
            "mode": mode,
            "seed": args.seed,
            "size_bytes": os.path.getsize(output_mp4),
            "width": args.width,
            "height": args.height,
            "frames": frames,
            "fps": args.fps,
        }]
        ctx["models"] = _collect_model_fingerprints(pipeline._model_dir, args=args)
        print(f"[video] Saved:    {output_mp4}")

        # Optional first-frame extraction + caption
        if args.first_frame or args.caption:
            png_path = os.path.splitext(output_mp4)[0] + ".png"
            if _extract_first_frame(output_mp4, png_path):
                print(f"[video] Frame:    {png_path}")
                if args.caption:
                    _run_caption(png_path, getattr(args, "caption_style", None) or "default", prompt)
            else:
                print("[video] WARNING: first-frame extraction failed (ffmpeg not found?)",
                      file=sys.stderr)


def _run_variations(args, prompt: str, variations: int, ab_params: dict | None) -> None:
    """Run N video variations for A/B testing. Each gets its own manifest."""
    import json as _json

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()

    begin_image = getattr(args, "begin_image", None)
    mode = _mode_label(args)
    print(f"[video] A/B Test: {variations} variations  Mode: {mode}  "
          f"Resolution: {args.width}×{args.height}  Frames: {args.frames}  FPS: {args.fps}")

    from app.ltx_pipeline import LTXVideoPipeline

    hq = getattr(args, "hq", False)
    distilled = getattr(args, "distilled", False)

    # Pipeline loaded once, reused across variations
    pipeline = LTXVideoPipeline(
        model_dir=args.video_model,
        low_ram=args.low_ram,
        hq=hq,
        distilled=distilled,
        transformer=getattr(args, "transformer", None),
        lora_path=getattr(args, "lora_path", None),
        lora_scale=getattr(args, "lora_scale", 1.0),
    )

    allow_noise = getattr(args, "allow_noise", False)

    for vi in range(variations):
        suffix = f"_v{vi + 1}"
        var_base = base_name + suffix
        var_base_path = os.path.join(cfg.OUTPUT_DIR, var_base)
        output_mp4 = var_base_path + ".mp4"
        run_file = var_base_path + ".run.json"
        manifest_file = var_base_path + ".manifest.json"

        # Merge ab-params overrides for this variation
        var_args = _override_args(args, vi, ab_params)
        # Track variation metadata in run.json
        var_args.variation_index = vi + 1
        var_args.ab_params_json = ab_params

        var_args.pipeline = _ltx_pipeline_name(var_args)
        run_config = RunConfig.from_args(var_args, command="video generate")
        run_config.to_json(run_file)

        start_time = datetime.now(timezone.utc).isoformat()

        print(f"\n{'=' * 60}")
        print(f"[video] Variation {vi + 1}/{variations} "
              f"(cfg_scale={var_args.cfg_scale}, stg_scale={var_args.stg_scale}, "
              f"seed={var_args.seed})")
        print(f"{'=' * 60}")

        try:
            if begin_image:
                timings = pipeline.generate_flf2v(
                    prompt=prompt,
                    output_path=output_mp4,
                    begin_image=begin_image,
                    end_image=getattr(args, "end_image", None),
                    height=args.height,
                    width=args.width,
                    num_frames=args.frames,
                    frame_rate=args.fps,
                    seed=var_args.seed,
                    stage1_steps=var_args.stage1_steps,
                    stage2_steps=var_args.stage2_steps,
                    cfg_scale=var_args.cfg_scale,
                    stg_scale=var_args.stg_scale,
                    begin_strength=getattr(var_args, "begin_strength", 1.0),
                    end_strength=getattr(var_args, "end_strength", 1.0),
                )
            else:
                timings = pipeline.generate(
                    prompt=prompt,
                    output_path=output_mp4,
                    height=args.height,
                    width=args.width,
                    num_frames=args.frames,
                    frame_rate=args.fps,
                    seed=var_args.seed,
                    stage1_steps=var_args.stage1_steps,
                    stage2_steps=var_args.stage2_steps,
                    cfg_scale=var_args.cfg_scale,
                    stg_scale=var_args.stg_scale,
                    image=args.input_image,
                    audio_path=args.audio,
                    audio_stage1_only=getattr(args, "audio_stage1_only", False),
                    audio_cfg_scale=getattr(args, "audio_cfg_scale", None),
                    enable_teacache=getattr(args, "teacache", False),
                    teacache_thresh=getattr(args, "teacache_thresh", None),
                )

            end_time = datetime.now(timezone.utc).isoformat()

            # --- Audio volume boost ---
            audio_volume = getattr(args, "audio_volume", None)
            if audio_volume is not None and audio_volume != 1.0 and not args.audio:
                _boost_audio_volume(output_mp4, audio_volume)

            # --- Audio noise detection ---
            _check_audio_noise(output_mp4, allow_noise=allow_noise)

            output_files = [{
                "path": output_mp4,
                "mode": mode,
                "variation": vi + 1,
                "seed": var_args.seed,
                "cfg_scale": var_args.cfg_scale,
                "stg_scale": var_args.stg_scale,
                "size_bytes": os.path.getsize(output_mp4),
                "width": args.width,
                "height": args.height,
                "frames": args.frames,
                "fps": args.fps,
            }]

            models = _collect_model_fingerprints(pipeline._model_dir, args=var_args)
            manifest = Manifest.from_success(
                run_file, start_time, end_time, timings, output_files, models)
            manifest.to_json(manifest_file)

            print(f"[video] Saved:    {output_mp4}")
            print(f"[video] Run:      {run_file}")
            print(f"[video] Manifest: {manifest_file}")
            print(f"[video] Elapsed:  {manifest.elapsed_seconds:.1f}s  "
                  f"Peak RAM: {manifest.memory_peak_mb / 1024:.1f} GB")

            # Auto-caption (forced on for variations)
            png_path = var_base_path + ".png"
            if _extract_first_frame(output_mp4, png_path):
                print(f"[video] Frame:    {png_path}")
                _run_caption(png_path, getattr(args, "caption_style", None) or "default", prompt)
            else:
                print("[video] WARNING: first-frame extraction failed",
                      file=sys.stderr)

        except Exception as exc:
            end_time = datetime.now(timezone.utc).isoformat()
            manifest = Manifest.from_error(
                run_file, start_time, end_time, {}, exc, {})
            manifest.to_json(manifest_file)
            print(f"ERROR: variation {vi + 1} failed: "
                  f"{type(exc).__name__}: {exc}", file=sys.stderr)
            traceback.print_exc()
            # Continue with remaining variations instead of aborting all
            continue

    print(f"\n{'=' * 60}")
    print(f"[video] A/B Test complete: {variations} variations")
    print(f"[video] Review: run.py video review --inputs "
          f"{os.path.join(cfg.OUTPUT_DIR, base_name)}_v*.manifest.json")
    print(f"{'=' * 60}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_audio_noise(mp4_path: str, *, allow_noise: bool = False) -> None:
    """Check generated video audio for noise. Exits on detection unless suppressed."""
    from app.audio_noise_detect import check_audio_noise_or_exit
    check_audio_noise_or_exit(mp4_path, allow_noise=allow_noise)


def _boost_audio_volume(mp4_path: str, gain: float) -> None:
    """Post-process audio volume in-place using ffmpeg.

    LTX-2.3 MLX audio is ~50x too quiet (RMS ~0.002, peak ~0.014).
    This applies a volume gain with limiter then re-encodes the MP4 with
    corrected audio.

    Args:
        mp4_path: Path to the MP4 file to modify in-place.
        gain: Volume multiplier (e.g. 50 for 50x boost).
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("[video] WARNING: ffmpeg not found, skipping audio volume boost",
              file=sys.stderr)
        return

    tmp_path = mp4_path + ".tmp.mp4"
    result = subprocess.run(
        [ffmpeg, "-y", "-i", mp4_path,
         "-af", f"volume={gain},alimiter=limit=0.95",
         "-c:v", "copy",
         tmp_path],
        capture_output=True, timeout=60,
    )
    if result.returncode == 0 and os.path.exists(tmp_path):
        os.replace(tmp_path, mp4_path)
        print(f"[video] Audio volume boosted: {gain}x")
    else:
        print(f"[video] WARNING: audio volume boost failed",
              file=sys.stderr)
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _override_args(args, variation_index: int, ab_params: dict | None):
    """Create a copy of args with per-variation parameter overrides applied."""
    import copy
    var_args = copy.copy(args)

    if ab_params is None:
        # A/B test: keep same seed for fair comparison
        return var_args

    for key, values in ab_params.items():
        val = values[variation_index]
        dest_map = {
            "cfg_scale": "cfg_scale",
            "stg_scale": "stg_scale",
            "stage1_steps": "stage1_steps",
            "stage2_steps": "stage2_steps",
            "seed": "seed",
            "begin_strength": "begin_strength",
            "end_strength": "end_strength",
        }
        dest = dest_map.get(key, key)
        setattr(var_args, dest, val)

    # A/B test: keep same seed unless explicitly varied via --ab-params
    return var_args


def _enhance_prompt(prompt: str, *, image_path: str | None = None) -> str:
    """Enhance a terse prompt using Gemma into a detailed cinematographic description.

    Uses the vendor's GemmaLanguageModel.enhance_t2v/enhance_i2v methods.
    Loads Gemma, generates enhanced prompt, then frees Gemma before returning.
    """
    import time as _time
    t0 = _time.time()
    print(f"[video] Enhancing prompt ({len(prompt)} chars)…")

    # Ensure vendor packages are importable
    from app.ltx_pipeline import _VENDOR_BASE
    for _pkg in ("packages/ltx-core-mlx",):
        _src = os.path.join(_VENDOR_BASE, _pkg, "src")
        if _src not in sys.path:
            sys.path.insert(0, _src)

    from ltx_core_mlx.text_encoders.gemma.encoders.base_encoder import GemmaLanguageModel

    # Determine model dir for Gemma (same as pipeline uses)
    from app import config as _cfg
    gemma_model_id = _cfg.LTX_TEXT_ENCODER_DIR

    gemma = GemmaLanguageModel()
    gemma.load(gemma_model_id)

    mode = "i2v" if image_path else "t2v"
    if mode == "i2v":
        enhanced = gemma.enhance_i2v(prompt)
    else:
        enhanced = gemma.enhance_t2v(prompt)

    # Free Gemma immediately — generation will load it again via the pipeline
    del gemma
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:
        pass

    elapsed = _time.time() - t0
    print(f"[video] Enhanced prompt ({len(enhanced)} chars, {elapsed:.1f}s):")
    print(f"[video]   Original: {prompt[:100]}{'…' if len(prompt) > 100 else ''}")
    print(f"[video]   Enhanced: {enhanced[:100]}{'…' if len(enhanced) > 100 else ''}")

    return enhanced


def _apply_prompt_defaults(args, defaults: dict) -> None:
    """Apply test-prompt recommended defaults for params not explicitly set by the user."""
    _ARGPARSE_DEFAULTS = {
        "frames": 97, "width": 704, "height": 448,
        "fps": 24.0, "cfg_scale": 5.0, "stg_scale": 1.0,
        "stage1_steps": None, "stage2_steps": None,
    }
    for prompt_key, value in defaults.items():
        if prompt_key in _ARGPARSE_DEFAULTS:
            # Use a sentinel default; skip override if the dest is missing
            # (e.g. a parser variant that omits it) to avoid AttributeError.
            sentinel = object()
            current = getattr(args, prompt_key, sentinel)
            if current is not sentinel and current == _ARGPARSE_DEFAULTS[prompt_key]:
                setattr(args, prompt_key, value)


def _extract_first_frame(video_path: str, png_path: str) -> bool:
    """Extract first frame of video to png_path using ffmpeg."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    result = subprocess.run(
        [ffmpeg, "-y", "-i", video_path, "-vframes", "1", png_path],
        capture_output=True, timeout=30,
    )
    return result.returncode == 0 and os.path.exists(png_path)


def _run_caption(png_path: str, style: str = "default", prompt: str = "") -> None:
    """Call run.py caption on the given PNG (fire-and-wait, non-fatal on failure).

    ``style`` selects the caption style (e.g. 'review' for structured scores used
    by the comparison HTML, 'default' for a plain description). ``prompt`` is the
    generation prompt — required by the 'review' style (it scores prompt
    adherence) and harmless for others.
    """
    from app.commands._shared import build_run_py_cmd
    extra = []
    if style and style != "default":
        extra += ["--style", style]
    if prompt:
        extra += ["--prompt", prompt]
    try:
        print(f"[video] Captioning {os.path.basename(png_path)} (style={style})…")
        subprocess.run(build_run_py_cmd("caption", png_path, *extra), timeout=180)
    except Exception as exc:
        print(f"[video] Caption skipped: {exc}", file=sys.stderr)


def _collect_model_fingerprints(model_dir: str, args=None) -> dict:
    """Fingerprint only the weight files actually loaded for this run.

    The flat model dir contains symlinks for both dev and distilled transformers.
    Fingerprinting all existing files would incorrectly record models that were
    not loaded. We select files based on the active pipeline mode.
    """
    distilled = args is not None and getattr(args, "distilled", False)
    temporal_upscale = args is not None and getattr(args, "temporal_upscale", False)

    if distilled:
        # DistilledPipeline: distilled DiT for both stages, no LoRA swap
        key_files = [
            "transformer-distilled-1.1.safetensors",
            "connector.safetensors",
            "spatial_upscaler_x2_v1_1.safetensors",
            "vae_encoder.safetensors",
            "vae_decoder.safetensors",
        ]
    else:
        # Dev pipeline (T2V, I2V, HQ, FLF2V): dev transformer + distilled LoRA for stage 2
        key_files = [
            "transformer-dev.safetensors",
            "ltx-2.3-22b-distilled-lora-384.int8.safetensors",
            "connector.safetensors",
            "spatial_upscaler_x2_v1_1.safetensors",
            "vae_encoder.safetensors",
            "vae_decoder.safetensors",
        ]

    if temporal_upscale:
        key_files.append("temporal_upscaler_x2_v1_0.safetensors")

    models = {}
    for fname in key_files:
        fpath = os.path.join(model_dir, fname)
        key = fname.replace(".safetensors", "").replace("-", "_").replace(".", "_")
        if os.path.exists(fpath):
            models[key] = file_fingerprint(fpath)
    return models
