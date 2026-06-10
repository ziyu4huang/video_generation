"""video-restore — LTX-2.3 IC-LoRA video restoration (sub-action of 'video restore').

Removes watermarks, subtitles, blur, and compression artifacts from video using
LTX-2.3's IC-LoRA conditioning mechanism. The degraded input video itself serves
as the reference conditioning guide, with restoration/upscale LoRAs directing the
model to produce a cleaned-up version.

Based on the ComfyUI workflow: 去水印，去字幕，去模糊，高清LTX2.3+iclora+insight

Required LoRA files (download from Lightricks/CivitAI):
  comfyui_data/models/loras/ltx2.3-video-restoration-general-lora.safetensors
  comfyui_data/models/loras/ltx2.3-ic-video-upscale-general.safetensors

Usage:
  run.py video restore --restore-input input.mp4
  run.py video restore --restore-input input.mp4 --output restored.mp4 --low-ram
  run.py video restore --restore-input input.mp4 --frames 49 --seed 888 --low-ram
  run.py video restore --restore-input input.mp4 --no-audio   (skip original audio mux)
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time

# Ensure ltx-2-mlx vendor packages are importable (same setup as ltx_pipeline.py)
_VENDOR_BASE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "vendor", "ltx-2-mlx",
)
for _pkg in ("packages/ltx-core-mlx", "packages/ltx-pipelines-mlx"):
    _src = os.path.join(_VENDOR_BASE, _pkg, "src")
    if os.path.isdir(_src) and _src not in sys.path:
        sys.path.insert(0, _src)

from app import config as cfg

_DEFAULT_POSITIVE_PROMPT = (
    "Convert to ultra-HD quality, reconstruct high-frequency details while "
    "eliminating artifacts, significantly improve image clarity, remove "
    "watermarks, subtitles and text occlusions, eliminate blur and "
    "compression noise, preserve original scene content"
)

_DEFAULT_NEGATIVE_PROMPT = (
    "pc game, console game, video game, ugly, 3d render, photo, "
    "still, static, slow"
)

# Matches the ComfyUI workflow's ManualSigmas 6-step schedule
_DEFAULT_STAGE1_STEPS = 6


PARSER_META = {
    "help": "Restore video: remove watermarks/subtitles, deblur, upscale via LTX-2.3 IC-LoRA",
    "description": (
        "Video restoration using LTX-2.3 with IC-LoRA conditioning.\n"
        "The input video frames serve as the IC-LoRA reference guide; "
        "restoration and upscale LoRAs direct the model to output a cleaned version.\n\n"
        "Required LoRA files (place in comfyui_data/models/loras/):\n"
        "  ltx2.3-video-restoration-general-lora.safetensors\n"
        "  ltx2.3-ic-video-upscale-general.safetensors\n\n"
        "Examples:\n"
        "  run.py video restore --input degraded.mp4\n"
        "  run.py video restore --input degraded.mp4 --output restored.mp4 --low-ram\n"
        "  run.py video restore --input degraded.mp4 --frames 49 --seed 888\n"
        "  run.py video restore --input degraded.mp4 --scale 2.0   # 2x output resolution\n"
    ),
}


def add_restore_args(parser):
    """Register video restore arguments.

    Only adds flags unique to the restore sub-action. The following flags are
    already added by add_generate_args() and are reused here by name:
      --seed, --frames, --fps, --low-ram, --stage1-steps, --stage2-steps,
      --prompt, --video-model
    The shared video parser also has --output (from add_review_args), so the
    restore output flag uses --restore-output instead.
    """
    # Unique restore flags — all prefixed or clearly distinct
    parser.add_argument(
        "--restore-input", type=str, default=None, dest="restore_input_flag", metavar="PATH",
        help="Input (degraded) video file path",
    )
    parser.add_argument(
        "--restore-output", type=str, default=None, dest="restore_output", metavar="PATH",
        help="Output path (default: <input>_restored.mp4)",
    )
    parser.add_argument(
        "--restore-negative-prompt", type=str, default=_DEFAULT_NEGATIVE_PROMPT,
        dest="restore_negative_prompt", metavar="TEXT",
        help="Negative prompt for restoration (default: built-in)",
    )
    parser.add_argument(
        "--restore-scale", type=float, default=1.0, metavar="FACTOR",
        dest="restore_scale",
        help=(
            "Output resolution scale relative to input "
            "(default: 1.0 = same resolution; 2.0 = 2x). "
            "Snapped to nearest 64-multiple per axis."
        ),
    )
    parser.add_argument(
        "--restore-cond-strength", type=float, default=1.0, dest="restore_cond_strength",
        metavar="S",
        help="IC-LoRA reference conditioning attention strength in [0, 1] (default: 1.0)",
    )

    # LoRA paths (unique to restoration)
    parser.add_argument(
        "--restoration-lora", type=str, default=None, metavar="PATH",
        help=f"Restoration LoRA path (default: {cfg.LTX_RESTORE_LORA})",
    )
    parser.add_argument(
        "--upscale-lora", type=str, default=None, metavar="PATH",
        help=f"Upscale LoRA path (default: {cfg.LTX_UPSCALE_LORA})",
    )
    parser.add_argument(
        "--restoration-scale", type=float, default=1.0,
        help="Restoration LoRA strength (default: 1.0)",
    )
    parser.add_argument(
        "--upscale-scale", type=float, default=1.0,
        help="Upscale LoRA strength (default: 1.0)",
    )
    parser.add_argument(
        "--no-upscale-lora", action="store_true", default=False, dest="no_upscale_lora",
        help="Skip the upscale LoRA (use only the restoration LoRA)",
    )
    parser.add_argument(
        "--restore-no-audio", action="store_true", default=False, dest="restore_no_audio",
        help="Do not mux original audio back into the restored video",
    )


def run_restore(args):
    """Main restore execution (called by video.py dispatcher)."""
    # Resolve input path
    input_path = getattr(args, "restore_input_flag", None)
    if not input_path:
        print("ERROR: input video path required: run.py video restore --restore-input <video.mp4>", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(input_path):
        print(f"ERROR: input video not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Resolve LoRA paths
    restoration_lora = args.restoration_lora or cfg.LTX_RESTORE_LORA
    upscale_lora = args.upscale_lora or cfg.LTX_UPSCALE_LORA

    _check_lora_file(restoration_lora, "restoration")
    if not args.no_upscale_lora:
        _check_lora_file(upscale_lora, "upscale")

    # Probe input video
    print(f"[restore] Probing {os.path.basename(input_path)}…")
    from ltx_core_mlx.utils.ffmpeg import probe_video_info
    info = probe_video_info(input_path)
    print(
        f"[restore] Input: {info.width}x{info.height}, "
        f"{info.num_frames} frames @ {info.fps:.2f} fps, "
        f"audio={'yes' if info.has_audio else 'no'}"
    )

    # Compute output dimensions (snap to 64-multiple for Stage 1 half-res → 32-multiple)
    out_w = _snap_to_64(int(info.width * args.restore_scale))
    out_h = _snap_to_64(int(info.height * args.restore_scale))
    if out_w < 64 or out_h < 64:
        print(f"ERROR: output resolution too small: {out_w}x{out_h}", file=sys.stderr)
        sys.exit(1)

    # Compute frame count (snap to 8k+1)
    fps = args.fps or info.fps
    if args.frames is not None:
        n_frames = _snap_to_8k1(args.frames)
    else:
        n_frames = _snap_to_8k1(min(info.num_frames, 161))

    print(f"[restore] Output: {out_w}x{out_h}, {n_frames} frames @ {fps:.2f} fps")

    # Build output path
    output_path = args.restore_output
    if not output_path:
        base, ext = os.path.splitext(input_path)
        output_path = base + "_restored" + (ext or ".mp4")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # Extract original audio to temp file
    tmp_audio_path = None
    if info.has_audio and not args.restore_no_audio:
        tmp_audio_path = _extract_audio(input_path)

    # Build IC-LoRA path list
    ic_lora_paths: list[tuple[str, float]] = [
        (restoration_lora, args.restoration_scale),
    ]
    if not args.no_upscale_lora:
        ic_lora_paths.append((upscale_lora, args.upscale_scale))

    # Resolve prompt (fall back to built-in restoration prompt)
    prompt = args.prompt or _DEFAULT_POSITIVE_PROMPT

    # Determine pipeline output path (before audio mux we write to a temp path)
    gen_output = output_path
    if tmp_audio_path:
        tmp_gen_fd, gen_output = tempfile.mkstemp(suffix=".mp4", prefix="ltx_restore_")
        os.close(tmp_gen_fd)

    try:
        # Run IC-LoRA generation
        from app.ltx_pipeline import LTXVideoPipeline

        pipeline = LTXVideoPipeline(
            model_dir=args.video_model,
            low_ram=args.low_ram,
            distilled=True,  # IC-LoRA pipeline uses the distilled transformer
        )

        print(f"[restore] Running IC-LoRA restoration…")
        t0 = time.time()

        timings = pipeline.generate_ic_lora(
            prompt=prompt,
            output_path=gen_output,
            video_conditioning=[(input_path, args.restore_cond_strength)],
            ic_lora_paths=ic_lora_paths,
            height=out_h,
            width=out_w,
            num_frames=n_frames,
            frame_rate=fps,
            seed=args.seed,
            stage1_steps=args.stage1_steps,   # None → vendor DISTILLED_SIGMAS (8 steps)
            stage2_steps=args.stage2_steps,   # None → vendor STAGE_2_SIGMAS (3 steps)
            conditioning_attention_strength=args.restore_cond_strength,
        )

        elapsed = timings.get("generate_seconds", time.time() - t0)
        print(f"[restore] Generation done in {elapsed:.1f}s")

        # Mux original audio back
        if tmp_audio_path and os.path.exists(tmp_audio_path):
            _mux_audio(gen_output, tmp_audio_path, output_path)
        elif gen_output != output_path:
            shutil.move(gen_output, output_path)

    finally:
        # Clean up temp files
        if tmp_audio_path and os.path.exists(tmp_audio_path):
            os.unlink(tmp_audio_path)
        if gen_output != output_path and os.path.exists(gen_output):
            os.unlink(gen_output)

    size_mb = os.path.getsize(output_path) / (1024 * 1024) if os.path.exists(output_path) else 0
    print(f"[restore] Saved: {output_path} ({size_mb:.1f} MB)")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _snap_to_64(value: int) -> int:
    """Round DOWN to nearest multiple of 64 (so Stage 1 half is a 32-multiple)."""
    return max(64, (value // 64) * 64)


def _snap_to_8k1(n: int) -> int:
    """Round to nearest valid LTX-2.3 frame count (8k+1, k >= 1)."""
    k = max(1, round((n - 1) / 8))
    return 8 * k + 1


def _check_lora_file(path: str, label: str) -> None:
    """Abort with a helpful message if a LoRA file is missing."""
    if not os.path.exists(path):
        print(
            f"ERROR: {label} LoRA not found: {path}\n"
            f"Download from Lightricks and place it at the path above, or pass "
            f"--{label.replace(' ', '-')}-lora <path> to override.",
            file=sys.stderr,
        )
        sys.exit(1)


def _extract_audio(video_path: str) -> str | None:
    """Extract audio stream to a temp .aac file. Returns path or None on failure."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("[restore] WARNING: ffmpeg not found, skipping audio extraction", file=sys.stderr)
        return None

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".aac", prefix="ltx_restore_audio_")
    os.close(tmp_fd)

    result = subprocess.run(
        [ffmpeg, "-y", "-i", video_path, "-vn", "-c:a", "aac", "-b:a", "192k", tmp_path],
        capture_output=True, timeout=120,
    )
    if result.returncode != 0:
        print("[restore] WARNING: audio extraction failed, output will have no audio",
              file=sys.stderr)
        os.unlink(tmp_path)
        return None

    return tmp_path


def _mux_audio(video_path: str, audio_path: str, output_path: str) -> None:
    """Mux original audio into the generated video, replacing any generated audio."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("[restore] WARNING: ffmpeg not found, cannot mux audio", file=sys.stderr)
        shutil.move(video_path, output_path)
        return

    result = subprocess.run(
        [
            ffmpeg, "-y",
            "-i", video_path,
            "-i", audio_path,
            "-c:v", "copy",
            "-c:a", "aac",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-shortest",
            output_path,
        ],
        capture_output=True, timeout=120,
    )
    if result.returncode != 0:
        print("[restore] WARNING: audio mux failed, output has generated audio", file=sys.stderr)
        shutil.move(video_path, output_path)
    else:
        print("[restore] Original audio muxed into output")
