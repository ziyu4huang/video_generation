"""video-relay — multi-segment Prompt-Relay-Custom-Audio pipeline for LTX-2.3.

Implements the "Prompt Relay" pattern from RuneXX/LTX-2.3-Workflows:
  1. Generate segment 1 using --relay-first-image (I2V) or without (T2V)
  2. Extract last frame of segment 1 → use as input image for segment 2
  3. Repeat for all N segments
  4. Concatenate all segments into a single MP4
  5. Overlay custom audio track (if provided)

This is the MLX equivalent of the ComfyUI Prompt-Relay-Custom-Audio workflows.
The pipeline is loaded once and reused across all segments (~21 GB avoids N reloads).

Examples:
  # 4-segment relay from prompts file + first image + audio
  run.py video relay \
    --relay-prompt-file prompts.txt \
    --relay-first-image opening.jpg \
    --relay-audio background.mp3 \
    --relay-duration 8 --fps 24 --low-ram

  # Inline prompts with per-segment images (empty = use relay frame)
  run.py video relay \
    --relay-prompts "opening shot" "person walks" "enters lobby" "sits at desk" \
    --relay-images city.jpg "" building.jpg "" \
    --relay-audio music.mp3

  # With VBVR reasoning LoRA across all segments
  run.py video relay \
    --relay-prompt-file prompts.txt --relay-first-image base.jpg \
    --relay-audio music.mp3 --lora-path vbvr-ltx2.3

Prompt file format: one prompt per line, blank lines and # comments ignored.
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
import types
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name, resolve_lora_path
from app.manifest import Manifest
from app.run_config import RunConfig


PARSER_META = {
    "help": "Multi-segment Prompt-Relay video generation with custom audio",
    "description": (
        "Generate a short film by chaining N video segments with prompt relay.\n\n"
        "The last frame of segment N becomes the input image for segment N+1 (I2V relay),\n"
        "creating visual continuity. All segments are concatenated into one video.\n"
        "An optional audio track is overlaid on the final output.\n\n"
        "Equivalent to the RuneXX LTX-2.3 Prompt-Relay-Custom-Audio ComfyUI workflows.\n\n"
        "Examples:\n"
        "  run.py video relay --relay-prompt-file prompts.txt --relay-first-image base.jpg\n"
        "  run.py video relay --relay-prompt-file prompts.txt --relay-audio music.mp3 --low-ram\n"
        "  run.py video relay --relay-prompts 'shot 1' 'shot 2' 'shot 3' --relay-audio sfx.mp3\n"
    ),
}


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_relay_args(parser):
    """Register video-relay arguments (relay-specific only; reuses generate args for the rest)."""
    grp = parser.add_argument_group("Prompt Relay")

    # Prompt input — relay-specific (mutually exclusive with each other but NOT with generate's --prompt)
    prompt_grp = grp.add_mutually_exclusive_group()
    prompt_grp.add_argument("--relay-prompts", nargs="+", default=None, metavar="PROMPT",
                            help="Inline prompts, one per segment (N args = N segments)")
    prompt_grp.add_argument("--relay-prompt-file", type=str, default=None, metavar="PATH",
                            help="Text file with one prompt per line "
                                 "(blank lines and # comments ignored)")

    # Per-segment images (optional)
    grp.add_argument("--relay-first-image", type=str, default=None, metavar="PATH",
                     help="Reference image for segment 1 (T2V if omitted)")
    grp.add_argument("--relay-images", nargs="*", default=None, metavar="PATH",
                     help="Per-segment image paths (use '' for relay frame). "
                          "When provided, overrides --relay-first-image for their segments.")

    # Audio track
    grp.add_argument("--relay-audio", type=str, default=None, metavar="PATH",
                     help="Custom audio track overlaid on the final concatenated video "
                          "(WAV, MP3, AAC, M4A — any ffmpeg-supported format)")

    # Timing
    grp.add_argument("--relay-duration", type=float, default=8.0, metavar="SECS",
                     help="Duration per segment in seconds (default: 8.0). "
                          "Frame count auto-calculated from fps × duration and snapped to 8k+1.")

    # Output path (optional override)
    grp.add_argument("--relay-output", type=str, default=None, metavar="PATH",
                     help="Explicit output path for the final relay MP4 "
                          "(default: output/<timestamp>_relay.mp4)")

    # Self-test
    grp.add_argument(
        "--relay-self-test", action="store_true", default=False, dest="relay_self_test",
        help="Run a 2-segment relay self-test (T2V → last-frame → I2V → concat). "
             "No prompts or images required. Pass --relay-audio to also test audio mux.",
    )


# ---------------------------------------------------------------------------
# ffmpeg helpers
# ---------------------------------------------------------------------------

def _require_ffmpeg() -> str:
    """Return ffmpeg path or exit with a clear error."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ERROR: ffmpeg not found in PATH. Install it: brew install ffmpeg", file=sys.stderr)
        sys.exit(1)
    return ffmpeg


def _extract_last_frame(video_path: str, png_path: str) -> bool:
    """Extract the last video frame to png_path using ffmpeg."""
    ffmpeg = _require_ffmpeg()
    # -sseof -3: seek 3 seconds from end; -vframes 1: take one frame
    result = subprocess.run(
        [ffmpeg, "-y", "-sseof", "-3", "-i", video_path, "-vframes", "1",
         "-update", "1", png_path],
        capture_output=True, timeout=60,
    )
    if result.returncode != 0 or not os.path.exists(png_path):
        # Fallback: use last frame by filter (slower but reliable)
        result2 = subprocess.run(
            [ffmpeg, "-y", "-i", video_path,
             "-vf", "reverse,fps=1,vframes=1",
             png_path],
            capture_output=True, timeout=120,
        )
        return result2.returncode == 0 and os.path.exists(png_path)
    return True


def _concat_videos(video_paths: list, output_path: str) -> None:
    """Concatenate MP4 files using ffmpeg concat demuxer (stream copy, no re-encode)."""
    ffmpeg = _require_ffmpeg()

    # Write concat list to temp file
    tmp_fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="relay_concat_")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            for vp in video_paths:
                f.write(f"file '{os.path.abspath(vp)}'\n")

        result = subprocess.run(
            [ffmpeg, "-y", "-f", "concat", "-safe", "0",
             "-i", list_path, "-c", "copy", output_path],
            capture_output=True, timeout=300,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")
            print(f"ERROR: ffmpeg concat failed:\n{stderr}", file=sys.stderr)
            sys.exit(1)
    finally:
        if os.path.exists(list_path):
            os.unlink(list_path)


def _mux_audio_track(video_path: str, audio_path: str, output_path: str) -> None:
    """Overlay an audio track on the video (stream copy for video, re-encode audio to AAC)."""
    ffmpeg = _require_ffmpeg()
    tmp_path = output_path + ".audio_tmp.mp4"

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
            tmp_path,
        ],
        capture_output=True, timeout=300,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")
        print(f"[relay] WARNING: audio mux failed — output has no audio.\n{stderr}",
              file=sys.stderr)
        shutil.move(video_path, output_path) if video_path != output_path else None
        return

    os.replace(tmp_path, output_path)
    print(f"[relay] Audio overlaid: {os.path.basename(audio_path)}")


# ---------------------------------------------------------------------------
# Resolution / frame helpers (same logic as video-generate.py)
# ---------------------------------------------------------------------------

def _adjust_resolution(width: int, height: int) -> tuple:
    aligned_w = max(64, round(width / 64) * 64)
    aligned_h = max(64, round(height / 64) * 64)
    if aligned_w != width or aligned_h != height:
        print(f"[relay] Resolution adjusted: {width}×{height} → {aligned_w}×{aligned_h}")
    return aligned_w, aligned_h


def _adjust_frames(frames: int) -> int:
    if (frames - 1) % 8 == 0:
        return frames
    k = round((frames - 1) / 8)
    adjusted = max(9, 8 * k + 1)
    print(f"[relay] Frames adjusted: {frames} → {adjusted} (must satisfy 8k+1)")
    return adjusted


def _duration_to_frames(duration_secs: float, fps: float) -> int:
    """Convert duration + FPS to valid frame count (8k+1 pattern)."""
    raw = int(round(duration_secs * fps))
    return _adjust_frames(max(9, raw))


# ---------------------------------------------------------------------------
# Prompt loading
# ---------------------------------------------------------------------------

def _load_prompts(args) -> list:
    """Load prompts from --relay-prompts or --relay-prompt-file."""
    if getattr(args, "relay_prompts", None):
        return [p.strip() for p in args.relay_prompts if p.strip()]

    prompt_file = getattr(args, "relay_prompt_file", None)
    if prompt_file:
        if not os.path.exists(prompt_file):
            print(f"ERROR: prompt file not found: {prompt_file}", file=sys.stderr)
            sys.exit(1)
        with open(prompt_file, "r", encoding="utf-8") as f:
            prompts = [
                line.strip() for line in f
                if line.strip() and not line.strip().startswith("#")
            ]
        if not prompts:
            print(f"ERROR: no prompts found in {prompt_file}", file=sys.stderr)
            sys.exit(1)
        return prompts

    print("ERROR: No prompts provided. Use --relay-prompts or --relay-prompt-file.",
          file=sys.stderr)
    sys.exit(1)


def _resolve_segment_images(args, n_segments: int) -> list:
    """Build per-segment image list. None = use relay frame (auto-extracted last frame)."""
    relay_images = getattr(args, "relay_images", None) or []
    first_image = getattr(args, "relay_first_image", None)

    # Pad or trim to n_segments
    result = list(relay_images) + [None] * n_segments
    result = result[:n_segments]

    # Treat empty strings as None (relay frame)
    result = [r if r and r.strip() else None for r in result]

    # Fill segment 0 with first_image if not explicitly set
    if result[0] is None and first_image:
        result[0] = first_image

    # Validate provided image paths
    for i, img in enumerate(result):
        if img and not os.path.exists(img):
            print(f"ERROR: segment {i+1} image not found: {img}", file=sys.stderr)
            sys.exit(1)

    return result


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run_relay(args):
    """Entry point for video relay sub-action."""
    from app.gpu_lock import GpuLock
    if getattr(args, "relay_self_test", False):
        with GpuLock(skip=False):
            _run_relay_self_test(args)
        return
    with GpuLock(skip=False):
        _run_relay_inner(args)


_SELF_TEST_PROMPTS = [
    (
        "Style: cinematic realism. "
        "A person stands at the edge of a calm mountain lake at dawn, mist rising from the "
        "water surface, soft golden light falling on the still surface. Distant birds call "
        "faintly. Ripples spread slowly outward from a stone dropped near the shore."
    ),
    (
        "Style: cinematic realism. "
        "The same person steps forward along the gravel bank of the lake, footsteps crunching "
        "softly, arms swinging at their sides. Morning birdsong echoes across the water. "
        "The mist begins to thin as sunlight intensifies, casting long shadows on the ground."
    ),
]


def _run_relay_self_test(args):
    """2-segment relay integration test: T2V → last-frame extract → I2V → concat (→ audio mux)."""
    print("[relay-self-test] ═══ Relay Self-Test ═══")
    print("[relay-self-test] 2 segments, 49 frames each (@24fps ≈ 2s), 704×448, distilled pipeline (CFG=1, stage1=8)")

    relay_audio = getattr(args, "relay_audio", None)
    if relay_audio and not os.path.exists(relay_audio):
        print(f"ERROR: audio file not found: {relay_audio}", file=sys.stderr)
        sys.exit(1)

    # Build synthetic test args — distilled pipeline (has transformer-distilled-1.1.safetensors,
    # supports low_ram). 49 frames × 2 segments = ~4s total, 704×448, representative of real use.
    test_args = types.SimpleNamespace(
        relay_prompts=_SELF_TEST_PROMPTS,
        relay_prompt_file=None,
        relay_first_image=None,       # seg1 = T2V (no image)
        relay_images=None,
        relay_audio=relay_audio,
        relay_duration=2.0,           # 49 frames @ 24fps per segment
        relay_output=None,
        relay_self_test=False,        # prevent recursion
        width=704,
        height=448,
        fps=24.0,
        stage1_steps=8,
        stage2_steps=3,
        cfg_scale=1.0,                # distilled requires CFG=1
        stg_scale=0.0,                # distilled has no STG
        seed=42,
        low_ram=getattr(args, "low_ram", False),
        hq=False,
        distilled=True,               # distilled dir has transformer-distilled-1.1.safetensors
        lora_path=None,
        lora_scale=1.0,
        video_model=None,             # use default distilled dir
        teacache=False,
        teacache_thresh=None,
    )

    before_segs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_seg*.mp4")))
    before_relay = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.mp4")))
    before_pngs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.png")))

    _run_relay_inner(test_args)

    after_segs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_seg*.mp4")))
    after_relay = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.mp4")))
    after_pngs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.png")))

    new_segs = sorted(after_segs - before_segs)
    new_relay = sorted(after_relay - before_relay)
    new_pngs = sorted(after_pngs - before_pngs)

    checks = []

    # seg01 exists and non-empty
    seg01 = next((p for p in new_segs if "_seg01." in p), None)
    checks.append(("seg01.mp4 exists", bool(seg01 and os.path.getsize(seg01) > 0)))

    # relay frame PNG extracted between segments
    relay_png = bool(new_pngs)
    checks.append(("relay frame PNG extracted", relay_png))

    # seg02 exists and non-empty
    seg02 = next((p for p in new_segs if "_seg02." in p), None)
    checks.append(("seg02.mp4 exists", bool(seg02 and os.path.getsize(seg02) > 0)))

    # concat relay.mp4 exists
    relay_mp4 = new_relay[-1] if new_relay else None
    checks.append(("relay.mp4 concat exists", bool(relay_mp4 and os.path.exists(relay_mp4))))

    # relay.mp4 size plausible (≥ 80% of seg01+seg02 combined)
    if relay_mp4 and seg01 and seg02:
        relay_sz = os.path.getsize(relay_mp4)
        combined = os.path.getsize(seg01) + os.path.getsize(seg02)
        checks.append(("relay.mp4 size plausible", relay_sz >= combined * 0.8))
    else:
        checks.append(("relay.mp4 size plausible", False))

    # Audio stream check (only if audio was requested)
    if relay_audio and relay_mp4:
        ffprobe = shutil.which("ffprobe")
        if ffprobe:
            r = subprocess.run(
                [ffprobe, "-v", "error", "-select_streams", "a:0",
                 "-show_entries", "stream=codec_type",
                 "-of", "default=nw=1:nk=1", relay_mp4],
                capture_output=True, text=True, timeout=30,
            )
            checks.append(("audio stream in relay.mp4", r.stdout.strip() == "audio"))
        else:
            print("[relay-self-test] WARNING: ffprobe not found, skipping audio stream check",
                  file=sys.stderr)

    # Report
    print("\n[relay-self-test] Results:")
    passed = 0
    failed = 0
    for name, ok in checks:
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {name}")
        if ok:
            passed += 1
        else:
            failed += 1

    total = len(checks)
    if failed == 0:
        print(f"\n[relay-self-test] PASS: {passed}/{total} checks passed")
    else:
        print(f"\n[relay-self-test] FAIL: {failed}/{total} checks failed", file=sys.stderr)
        sys.exit(1)


def _run_relay_inner(args):
    prompts = _load_prompts(args)
    n = len(prompts)
    print(f"[relay] {n} segment(s) detected")

    # Resolution + frame count
    width = getattr(args, "width", 704)
    height = getattr(args, "height", 448)
    width, height = _adjust_resolution(width, height)

    fps = getattr(args, "fps", 24.0)
    relay_duration = getattr(args, "relay_duration", 8.0)
    frames = _duration_to_frames(relay_duration, fps)

    print(f"[relay] Resolution: {width}×{height}  "
          f"Duration: {relay_duration}s × {n} = {relay_duration * n:.0f}s total  "
          f"Frames/segment: {frames} @ {fps:.0f}fps")

    # Stage steps defaults
    hq = getattr(args, "hq", False)
    stage1_steps = getattr(args, "stage1_steps", None)
    stage2_steps = getattr(args, "stage2_steps", None)
    if hq and stage1_steps is None:
        stage1_steps = 15
        print("[relay] HQ mode: stage1_steps auto-set to 15")
    if stage1_steps is None:
        stage1_steps = 8
    if stage2_steps is None:
        stage2_steps = 3

    cfg_scale = getattr(args, "cfg_scale", 5.0)
    stg_scale = getattr(args, "stg_scale", 1.0)
    base_seed = getattr(args, "seed", 42)
    low_ram = getattr(args, "low_ram", False)
    lora_path = resolve_lora_path(getattr(args, "lora_path", None))
    lora_scale = getattr(args, "lora_scale", 1.0)

    segment_images = _resolve_segment_images(args, n)
    relay_audio = getattr(args, "relay_audio", None)

    # Validate audio file
    if relay_audio and not os.path.exists(relay_audio):
        print(f"ERROR: audio file not found: {relay_audio}", file=sys.stderr)
        sys.exit(1)

    # Pre-flight summary
    print(f"[relay] cfg={cfg_scale}  stg={stg_scale}  "
          f"s1_steps={stage1_steps}  s2_steps={stage2_steps}  "
          f"low-ram={low_ram}  hq={hq}")
    if lora_path:
        print(f"[relay] LoRA: {os.path.basename(lora_path)} (scale={lora_scale})")
    for i, (prompt, img) in enumerate(zip(prompts, segment_images)):
        img_label = os.path.basename(img) if img else ("relay frame" if i > 0 else "T2V")
        print(f"[relay] Segment {i+1}/{n}: [{img_label}] {prompt[:80]}")
    if relay_audio:
        print(f"[relay] Audio overlay: {os.path.basename(relay_audio)}")

    # Estimate total time (rough: 8 steps × empirical slope)
    mpx = width * height * frames / 1_000_000
    eta_per_seg = stage1_steps * 0.237 * mpx + stage2_steps * 0.495 * mpx + 0.251 * mpx + 7.4
    eta_total = eta_per_seg * n
    print(f"[relay] Estimated: {eta_per_seg:.0f}s/segment × {n} = "
          f"{eta_total:.0f}s ({eta_total / 60:.1f} min)")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()
    base_path = os.path.join(cfg.OUTPUT_DIR, base_name)

    # Inject attrs expected by RunConfig.from_args
    for attr, val in [("pipeline", "ltx-relay"), ("audio", None),
                      ("begin_image", None), ("end_image", None),
                      ("distilled", False), ("temporal_upscale", False),
                      ("teacache", False), ("teacache_thresh", None),
                      ("audio_stage1_only", False), ("audio_cfg_scale", None),
                      ("audio_volume", None), ("allow_noise", False),
                      ("enhance_prompt", False), ("variations", 1),
                      ("ab_params", None), ("yes", False),
                      ("first_frame", False), ("caption", False),
                      ("skip_gpu_lock", False), ("video_model", None),
                      ("prompt", prompts[0]), ("prompt_file", None),
                      ("input_image", segment_images[0]),
                      ("lora_path", lora_path), ("lora_scale", lora_scale)]:
        if not hasattr(args, attr):
            setattr(args, attr, val)
    # Override resolved values
    args.width = width
    args.height = height
    args.frames = frames
    args.fps = fps
    args.stage1_steps = stage1_steps
    args.stage2_steps = stage2_steps
    args.prompt = prompts[0]
    args.input_image = segment_images[0]
    args.lora_path = lora_path
    args.lora_scale = lora_scale

    run_file = base_path + ".run.json"
    manifest_file = base_path + ".manifest.json"
    run_config = RunConfig.from_args(args, command="video relay")
    run_config.to_json(run_file)

    start_time = datetime.now(timezone.utc).isoformat()
    segment_outputs = []
    all_timings = {}

    try:
        from app.ltx_pipeline import LTXVideoPipeline

        # Load pipeline ONCE — reuse across all segments
        pipeline = LTXVideoPipeline(
            model_dir=getattr(args, "video_model", None),
            low_ram=low_ram,
            hq=hq,
            distilled=getattr(args, "distilled", False),
            temporal_upscale=False,
            lora_path=lora_path,
            lora_scale=lora_scale,
        )

        prev_mp4 = None

        for i, prompt in enumerate(prompts):
            seg_num = i + 1
            seed = base_seed + i  # distinct seed per segment
            output_mp4 = f"{base_path}_seg{seg_num:02d}.mp4"

            # Determine input image
            input_img = segment_images[i]
            if input_img is None and i > 0:
                # Relay: extract last frame of previous segment
                relay_frame = f"{base_path}_seg{i:02d}_relay.png"
                print(f"\n[relay] Extracting last frame of segment {i} → relay.png")
                if not _extract_last_frame(prev_mp4, relay_frame):
                    print(f"ERROR: failed to extract last frame from {prev_mp4}",
                          file=sys.stderr)
                    sys.exit(1)
                input_img = relay_frame

            mode = "I2V" if input_img else "T2V"
            print(f"\n[relay] ═══ Segment {seg_num}/{n} [{mode}] seed={seed} ═══")
            print(f"[relay] Prompt: {prompt}")
            if input_img:
                print(f"[relay] Image:  {os.path.basename(input_img)}")

            timings = pipeline.generate(
                prompt=prompt,
                output_path=output_mp4,
                height=height,
                width=width,
                num_frames=frames,
                frame_rate=fps,
                seed=seed,
                stage1_steps=stage1_steps,
                stage2_steps=stage2_steps,
                cfg_scale=cfg_scale,
                stg_scale=stg_scale,
                image=input_img,
                enable_teacache=getattr(args, "teacache", False),
                teacache_thresh=None,
            )

            all_timings[f"seg{seg_num:02d}"] = timings
            segment_outputs.append({
                "segment": seg_num,
                "path": output_mp4,
                "prompt": prompt,
                "mode": mode,
                "seed": seed,
                "input_image": input_img,
                "size_bytes": os.path.getsize(output_mp4),
                "width": width,
                "height": height,
                "frames": frames,
                "fps": fps,
            })
            prev_mp4 = output_mp4
            print(f"[relay] Segment {seg_num} saved: {output_mp4}")

        # Concatenate all segments
        print(f"\n[relay] Concatenating {n} segments…")
        relay_mp4 = getattr(args, "relay_output", None) or f"{base_path}_relay.mp4"
        segment_paths = [s["path"] for s in segment_outputs]
        _concat_videos(segment_paths, relay_mp4)
        relay_size = os.path.getsize(relay_mp4)
        print(f"[relay] Concatenated: {relay_mp4} ({relay_size / 1_048_576:.1f} MB)")

        # Overlay audio track
        if relay_audio:
            print(f"[relay] Overlaying audio: {relay_audio}")
            _mux_audio_track(relay_mp4, relay_audio, relay_mp4)

        end_time = datetime.now(timezone.utc).isoformat()

        output_files = segment_outputs + [{
            "path": relay_mp4,
            "mode": "relay-final",
            "segments": n,
            "size_bytes": relay_size,
            "width": width,
            "height": height,
            "frames": frames * n,
            "fps": fps,
            "audio": os.path.basename(relay_audio) if relay_audio else None,
        }]

        models = _collect_relay_fingerprints(pipeline._model_dir, lora_path)
        manifest = Manifest.from_success(run_file, start_time, end_time,
                                         all_timings, output_files, models)
        manifest.to_json(manifest_file)

        peak_gb = manifest.memory_peak_mb / 1024
        print(f"\n[relay] ══════════════════════════════════════════")
        print(f"[relay] Final video: {relay_mp4}")
        print(f"[relay] Run:         {run_file}")
        print(f"[relay] Manifest:    {manifest_file}")
        print(f"[relay] Peak RAM:    {peak_gb:.1f} GB")
        print(f"[relay] Segments:    {n} × {relay_duration:.0f}s = "
              f"{relay_duration * n:.0f}s total")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, {}, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


def _collect_relay_fingerprints(model_dir: str, lora_path: str | None) -> dict:
    """Fingerprint key model files for the relay run (dev pipeline)."""
    from app.manifest import file_fingerprint

    key_files = [
        "transformer-dev.safetensors",
        "ltx-2.3-22b-distilled-lora-384.safetensors",
        "connector.safetensors",
        "spatial_upscaler_x2_v1_1.safetensors",
        "vae_encoder.safetensors",
        "vae_decoder.safetensors",
    ]
    models = {}
    if model_dir and os.path.isdir(model_dir):
        for fname in key_files:
            fpath = os.path.join(model_dir, fname)
            if os.path.exists(fpath):
                models[fname] = file_fingerprint(fpath)
    if lora_path and os.path.exists(lora_path):
        models["lora"] = file_fingerprint(lora_path)
    return models
