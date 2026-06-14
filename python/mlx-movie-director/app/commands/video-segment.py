"""video-segment — Scene detection + per-segment quality analysis.

Detects shot boundaries using HSV histogram correlation, divides the video into
scenes, then runs quality metrics and optional VLM scoring on each segment.

Usage:
  run.py video segment --segment-input output/video.mp4
  run.py video segment --segment-input output/video.mp4 --vlm-score
  run.py video segment --segment-input output/video.mp4 --threshold 0.3
  run.py video segment --segment-input video.mp4 --vlm-score --frames-per-seg 6
"""

import json
import os
import sys
from datetime import datetime, timezone

import cv2
import numpy as np

from app import config as cfg
from app.video_utils import detect_scenes, scenes_to_timestamps, extract_keyframes_from_range

PARSER_META = {
    "help": "Detect scenes and analyze per-segment quality",
    "description": (
        "Detect shot boundaries using HSV histogram correlation, then analyze "
        "each segment's quality independently.\n\n"
        "Examples:\n"
        "  run.py video segment --segment-input output/video.mp4\n"
        "  run.py video segment --segment-input output/video.mp4 --segment-vlm\n"
        "  run.py video segment --segment-input output/video.mp4 --threshold 0.3\n"
    ),
}


def add_segment_args(parser):
    """Register scene-segment analysis CLI arguments."""
    parser.add_argument(
        "--segment-input", type=str, default=None, metavar="VIDEO",
        help="Input video file to analyze",
    )
    parser.add_argument(
        "--threshold", type=float, default=0.4, metavar="T",
        help="Scene change sensitivity: lower = more sensitive (0.3-0.5, default: 0.4)",
    )
    parser.add_argument(
        "--min-frames", type=int, default=8, metavar="N",
        help="Minimum frames per scene (shorter scenes merged, default: 8)",
    )
    parser.add_argument(
        "--segment-vlm", action="store_true", default=False,
        help="Also score each segment using VLM (Qwen3-VL via LM Studio)",
    )
    parser.add_argument(
        "--frames-per-seg", type=int, default=4, metavar="N",
        help="Keyframes per segment for VLM (default: 4)",
    )
    parser.add_argument(
        "--json", type=str, default=None, metavar="PATH",
        help="Save per-segment report as JSON",
    )


def run_segment(args):
    """Detect scenes and analyze each segment."""
    input_path = getattr(args, "segment_input", None)
    if not input_path:
        print("ERROR: provide --segment-input <video.mp4>", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(input_path):
        print(f"ERROR: file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    threshold = getattr(args, "threshold", 0.4)
    min_frames = getattr(args, "min_frames", 8)
    use_vlm = getattr(args, "segment_vlm", False)
    frames_per_seg = getattr(args, "frames_per_seg", 4)

    # Get video info
    cap = cv2.VideoCapture(input_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    print(f"[segment] {os.path.basename(input_path)}")
    print(f"[segment] {total_frames} frames, {width}×{height}, {fps:.1f}fps")
    print(f"[segment] Threshold: {threshold}, min frames: {min_frames}")

    # Detect scenes
    print(f"[segment] Detecting scene changes...")
    scenes = detect_scenes(input_path, threshold=threshold, min_scene_frames=min_frames)
    timestamps = scenes_to_timestamps(scenes, fps)

    if not timestamps:
        print("[segment] No scenes detected (single continuous shot)")
        timestamps = [{
            "scene_num": 1, "start_frame": 0, "end_frame": total_frames - 1,
            "frames": total_frames, "start_sec": 0,
            "end_sec": round(total_frames / fps, 2) if fps > 0 else 0,
            "duration_sec": round(total_frames / fps, 2) if fps > 0 else 0,
        }]

    print(f"[segment] Detected {len(timestamps)} scene(s)")
    print()

    # Analyze each segment
    for seg in timestamps:
        print(f"  Scene {seg['scene_num']}: "
              f"frames {seg['start_frame']}-{seg['end_frame']} "
              f"({seg['frames']} frames, {seg['duration_sec']:.1f}s)")

    if use_vlm:
        print()
        _run_segment_vlm(input_path, timestamps, frames_per_seg)

    # JSON output
    json_path = getattr(args, "json", None)
    if json_path:
        report = {
            "video": os.path.abspath(input_path),
            "total_frames": total_frames,
            "fps": fps,
            "resolution": [width, height],
            "threshold": threshold,
            "min_frames": min_frames,
            "scenes": timestamps,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(json_path, "w") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"\n[segment] JSON report: {json_path}")


def _run_segment_vlm(video_path: str, timestamps: list[dict], n_frames: int):
    """Run VLM scoring on each segment."""
    from app.commands.caption import caption_video

    for seg in timestamps:
        sn = seg["scene_num"]
        print(f"\n[segment] VLM scoring Scene {sn} "
              f"({seg['start_sec']:.1f}s-{seg['end_sec']:.1f}s)...")

        try:
            # Extract keyframes from this segment's range
            from app.video_utils import extract_keyframes_from_range
            import tempfile
            tmp_dir = tempfile.mkdtemp(prefix=f"seg{sn}_")
            frame_paths = extract_keyframes_from_range(
                video_path, seg["start_frame"], seg["end_frame"],
                n_frames=n_frames, output_dir=tmp_dir,
            )

            if not frame_paths:
                print(f"[segment]   WARNING: no keyframes for scene {sn}")
                continue

            # Build VLM prompt with segment context
            from app.commands.caption import _call_vlm_multi, _image_to_base64, _STYLE_PROMPTS, _LANG_INSTRUCTIONS, _DEFAULT_API_URL, _DEFAULT_MODEL, _extract_caption_json, _lmstudio_ensure_model

            prompt_text = _STYLE_PROMPTS.get("video_score", "")
            prompt_text += "\n" + _LANG_INSTRUCTIONS.get("en", "")

            b64_images = [_image_to_base64(p) for p in frame_paths]
            response = _call_vlm_multi(
                _DEFAULT_API_URL, _DEFAULT_MODEL, b64_images, prompt_text,
                auto_load=True,
            )
            result = _extract_caption_json(response)

            # Clean up temp frames
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)

            if result and result.get("overall"):
                seg["vlm_score"] = result
                print(f"[segment]   Overall: {result['overall']}/10  "
                      f"Detail: {result.get('detail_preservation', '?')}/10  "
                      f"Temporal: {result.get('temporal_coherence', '?')}/10")
                if result.get("summary"):
                    print(f"[segment]   Summary: {result['summary']}")
            else:
                print(f"[segment]   WARNING: invalid VLM response")

        except Exception as exc:
            print(f"[segment]   WARNING: VLM failed for scene {sn}: {exc}")
