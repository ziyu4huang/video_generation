"""video_utils — shared video processing utilities for frame extraction, analysis, and captioning.

Provides reusable helpers used by video-quality, caption, and other video commands.
"""

import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np


def require_ffmpeg() -> str:
    """Return ffmpeg path or exit with a clear error."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ERROR: ffmpeg not found in PATH. Install it: brew install ffmpeg", file=sys.stderr)
        sys.exit(1)
    return ffmpeg


def get_video_info(video_path: str) -> dict:
    """Probe a video file and return metadata.

    Returns dict with: total_frames, fps, duration_sec, width, height, has_audio.
    Uses OpenCV for frame-accurate info.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"ERROR: cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration_sec = total_frames / fps if fps > 0 else 0
    cap.release()

    # Audio detection via ffprobe
    has_audio = False
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        result = subprocess.run(
            [ffprobe, "-i", video_path, "-show_streams",
             "-select_streams", "a", "-loglevel", "error"],
            capture_output=True, timeout=30,
        )
        has_audio = bool(result.stdout.strip())

    return {
        "total_frames": total_frames,
        "fps": fps,
        "duration_sec": duration_sec,
        "width": width,
        "height": height,
        "has_audio": has_audio,
    }


def extract_keyframes(video_path: str, n_frames: int = 8,
                      output_dir: str | None = None,
                      max_size: int = 768) -> list[str]:
    """Extract N evenly-spaced keyframes from a video as resized JPEG images.

    Uses ffmpeg's select filter to pick frames at uniform intervals, then
    resizes each to fit within max_size on the longest edge (preserving aspect
    ratio). JPEG quality is set relatively high (q:v 2 = ~95% quality) to
    avoid adding compression artifacts before VLM analysis.

    Args:
        video_path: Path to input video file.
        n_frames: Number of keyframes to extract (default: 8).
        output_dir: Directory for output JPEGs (default: system temp dir).
        max_size: Longest edge in pixels (default: 768). Images are resized
                  so the longest side is ≤ max_size.

    Returns:
        List of absolute paths to the extracted JPEG files, in frame order.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if output_dir is None:
        ts_dir = tempfile.mkdtemp(prefix="keyframes_")
        output_dir = ts_dir
    else:
        os.makedirs(output_dir, exist_ok=True)

    ffmpeg = require_ffmpeg()
    info = get_video_info(video_path)

    if info["total_frames"] <= 1:
        print(f"[video_utils] WARNING: video has only {info['total_frames']} frame(s)", file=sys.stderr)
        return []

    if n_frames < 1:
        n_frames = 1

    n_frames = min(n_frames, info["total_frames"])

    # Calculate skip interval so frames are evenly spaced
    if n_frames >= info["total_frames"]:
        # Take all frames (rare — very short videos)
        skip = 1
        n_frames = info["total_frames"]
    else:
        skip = max(1, info["total_frames"] // n_frames)

    # Build select filter expression: eq(n,0)+eq(n,skip)+eq(n,2*skip)+...
    indices = [i * skip for i in range(n_frames)]
    select_expr = "+".join(f"eq(n,{idx})" for idx in indices)

    output_pattern = os.path.join(output_dir, "frame_%02d.jpg")
    scale_filter = f"scale='min({max_size},iw)':'min({max_size},ih)':force_original_aspect_ratio=decrease"

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", f"select='{select_expr}',setpts=N/FRAME_RATE/TB,{scale_filter}",
        "-q:v", "2",       # high JPEG quality (2 = ~95%)
        "-vsync", "0",     # don't duplicate frames to match a target framerate
        "-frame_pts", "1",  # use PTS in filename (frame index)
        output_pattern,
    ]

    result = subprocess.run(cmd, capture_output=True, timeout=120)
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")
        print(f"[video_utils] WARNING: ffmpeg keyframe extraction failed:\n{stderr}",
              file=sys.stderr)

    # Collect output files in frame order
    extracted = []
    for i in range(n_frames):
        expected = os.path.join(output_dir, f"frame_{i:02d}.jpg")
        if os.path.exists(expected):
            extracted.append(os.path.abspath(expected))

    if not extracted:
        print("[video_utils] ERROR: no keyframes extracted", file=sys.stderr)

    return extracted


def extract_keyframes_from_range(video_path: str, start_frame: int, end_frame: int,
                                  n_frames: int = 4, output_dir: str | None = None,
                                  max_size: int = 768) -> list[str]:
    """Extract evenly-spaced keyframes from a specific frame range of a video.

    Useful for per-segment analysis after scene detection.

    Args:
        video_path: Path to input video.
        start_frame: First frame index (inclusive).
        end_frame: Last frame index (inclusive).
        n_frames: Number of keyframes to extract from this range.
        output_dir: Directory for output JPEGs (default: system temp dir).
        max_size: Longest edge in pixels.

    Returns:
        List of absolute paths to extracted JPEG files.
    """
    import cv2
    import numpy as np

    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if output_dir is None:
        import tempfile
        ts_dir = tempfile.mkdtemp(prefix="seg_keyframes_")
        output_dir = ts_dir
    else:
        os.makedirs(output_dir, exist_ok=True)

    total_frames_in_range = end_frame - start_frame + 1
    if total_frames_in_range < 1:
        return []

    n_frames = min(max(1, n_frames), total_frames_in_range)
    indices = set(
        start_frame + int(i * total_frames_in_range / n_frames)
        for i in range(n_frames)
    )

    cap = cv2.VideoCapture(video_path)
    extracted = []
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx in indices:
            h, w = frame.shape[:2]
            if max_size > 0 and max(h, w) > max_size:
                scale = max_size / max(h, w)
                new_w, new_h = int(w * scale), int(h * scale)
                frame = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)
            out_path = os.path.join(output_dir, f"frame_{frame_idx:06d}.jpg")
            cv2.imwrite(out_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            extracted.append(os.path.abspath(out_path))
        frame_idx += 1
        if frame_idx > end_frame:
            break

    cap.release()
    return extracted


def extract_keyframes_cv(video_path: str, n_frames: int = 8,
                         output_dir: str | None = None,
                         max_size: int = 768) -> list[str]:
    """Alternative keyframe extraction using OpenCV (no ffmpeg select filter needed).

    Slower than ffmpeg-based extraction for long videos because it decodes all
    frames sequentially, but works on any system with cv2 installed.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if output_dir is None:
        ts_dir = tempfile.mkdtemp(prefix="keyframes_")
        output_dir = ts_dir
    else:
        os.makedirs(output_dir, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"ERROR: cannot open video: {video_path}", file=sys.stderr)
        return []

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames <= 1:
        cap.release()
        return []

    n_frames = min(max(1, n_frames), total_frames)
    indices = set(
        int(i * total_frames / n_frames) for i in range(n_frames)
    )

    extracted = []
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx in indices:
            # Resize to max_size on longest edge
            h, w = frame.shape[:2]
            if max_size > 0 and max(h, w) > max_size:
                scale = max_size / max(h, w)
                new_w, new_h = int(w * scale), int(h * scale)
                frame = cv2.resize(frame, (new_w, new_h),
                                   interpolation=cv2.INTER_AREA)

            out_path = os.path.join(output_dir, f"frame_{frame_idx:06d}.jpg")
            cv2.imwrite(out_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            extracted.append(os.path.abspath(out_path))
        frame_idx += 1

    cap.release()
    return extracted


def detect_scenes(video_path: str, threshold: float = 0.4,
                  min_scene_frames: int = 8) -> list[tuple[int, int]]:
    """Detect scene boundaries using HSV histogram correlation.

    Compares consecutive frames via HSV histogram correlation. A large drop
    in correlation signals a scene change. Adjacent short segments are merged
    into the previous scene.

    Args:
        video_path: Path to input video.
        threshold: Correlation threshold for scene change detection.
                   Lower = more sensitive (0.3-0.5 recommended).
                   Default 0.4 (moderate sensitivity).
        min_scene_frames: Minimum frames per scene; shorter scenes are merged
                          into the previous segment.

    Returns:
        List of (start_frame, end_frame) tuples, one per detected scene.
    """
    import cv2
    import numpy as np

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"ERROR: cannot open video: {video_path}", file=sys.stderr)
        return []

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames <= 1:
        cap.release()
        return [(0, max(0, total_frames - 1))]

    # HSV histogram params (32 bins per channel, H only for speed)
    hist_size = [32]
    hist_range = [0, 180]  # Hue range

    scene_starts = [0]
    prev_hist = None
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0], None, hist_size, hist_range)
        cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)

        if prev_hist is not None:
            # Use correlation: 1 = identical, lower = different
            corr = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
            if corr < threshold:
                # Scene change candidate
                frames_since_last = frame_idx - scene_starts[-1]
                if frames_since_last >= min_scene_frames:
                    scene_starts.append(frame_idx)
                    prev_hist = hist
                    frame_idx += 1
                    continue

        prev_hist = hist
        frame_idx += 1

    cap.release()

    if not scene_starts or scene_starts[-1] == 0:
        return [(0, max(0, total_frames - 1))]

    # Convert to (start, end) ranges
    scenes = []
    for i, start in enumerate(scene_starts):
        if i + 1 < len(scene_starts):
            end = scene_starts[i + 1] - 1
        else:
            end = total_frames - 1
        scenes.append((start, end))

    return scenes


def scenes_to_timestamps(scenes: list[tuple[int, int]], fps: float) -> list[dict]:
    """Convert frame-range scenes to timestamp dicts for display.

    Args:
        scenes: List of (start_frame, end_frame) from detect_scenes().
        fps: Frames per second.

    Returns:
        List of dicts with: scene_num, start_frame, end_frame, frames,
        start_sec, end_sec, duration_sec.
    """
    result = []
    for i, (s, e) in enumerate(scenes):
        result.append({
            "scene_num": i + 1,
            "start_frame": s,
            "end_frame": e,
            "frames": e - s + 1,
            "start_sec": round(s / fps, 2) if fps > 0 else 0,
            "end_sec": round(e / fps, 2) if fps > 0 else 0,
            "duration_sec": round((e - s + 1) / fps, 2) if fps > 0 else 0,
        })
    return result
