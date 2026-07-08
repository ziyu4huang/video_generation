"""lipsync_metrics — measure whether generated mouth motion tracks the audio.

Answers the open question left by the IA2V vendor-bug fix (see
``docs/openmontage-capability-matrix.md`` "Not yet assessed"): the pipeline
produces a plausible talking-portrait clip, but does mouth motion actually
correlate with speech energy, or is it "a face talking in general"?

Two independent time series are extracted from the same mp4 and correlated:

  - mouth-open ratio per video frame, via mediapipe FaceLandmarker (inner-lip
    gap normalized by interocular distance, so it is invariant to face scale/
    zoom rather than to mouth width, which itself changes during speech).
  - audio RMS envelope, reusing ``app.voice_metrics._frame_rms`` /
    ``app.audio_noise_detect._extract_audio_pcm`` (already-tested decode
    path — no new audio-decoding code).

Both series are resampled onto the video's frame timestamps and compared via
Pearson correlation, searching a small lag window (mouth motion can lag
audio by a frame or two in a joint-diffusion model). The lag-adjusted |r| is
the numeric verdict.
"""

from __future__ import annotations

import os
import subprocess
import tempfile

import numpy as np

from app.audio_noise_detect import _extract_audio_pcm
from app.voice_metrics import _frame_rms, _probe_sample_rate

# Inner-lip vertical gap (top, bottom) and interocular horizontal reference
# (outer eye corners), MediaPipe FaceMesh 468-point topology.
_MOUTH_TOP = 13
_MOUTH_BOTTOM = 14
_EYE_LEFT_OUTER = 33
_EYE_RIGHT_OUTER = 263

# Lag search window in video frames when aligning mouth-open ratio against the
# audio envelope (a few frames covers plausible diffusion-model audio/video
# offset without over-fitting to noise).
_MAX_LAG_FRAMES = 4


def _get_face_landmarker_model_path() -> str:
    """Resolve path to the mediapipe FaceLandmarker task bundle."""
    base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "models", "face_landmark", "face_landmarker.task")


def _probe_fps(mp4_path: str) -> float:
    """Return the video track's frame rate (fps); 24.0 on any failure."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", mp4_path],
            capture_output=True, text=True, timeout=30,
        )
        raw = (r.stdout or "").strip()
        if "/" in raw:
            num, den = raw.split("/")
            return float(num) / float(den) if float(den) != 0 else 24.0
        return float(raw) if raw else 24.0
    except Exception:
        return 24.0


def _extract_video_frames(mp4_path: str, out_dir: str) -> list[str]:
    """Extract every video frame as PNG files (frame_0001.png, ...); return sorted paths."""
    pattern = os.path.join(out_dir, "frame_%05d.png")
    cmd = ["ffmpeg", "-i", mp4_path, "-vsync", "0", pattern]
    subprocess.run(cmd, capture_output=True, timeout=60)
    frames = sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.startswith("frame_")
    )
    return frames


def _mouth_open_ratio_from_landmarks(landmarks) -> float | None:
    """Inner-lip gap / interocular distance for one mediapipe landmark list."""
    try:
        top = landmarks[_MOUTH_TOP]
        bottom = landmarks[_MOUTH_BOTTOM]
        eye_l = landmarks[_EYE_LEFT_OUTER]
        eye_r = landmarks[_EYE_RIGHT_OUTER]
    except IndexError:
        return None
    mouth_gap = float(np.hypot(top.x - bottom.x, top.y - bottom.y))
    interocular = float(np.hypot(eye_l.x - eye_r.x, eye_l.y - eye_r.y))
    if interocular <= 1e-9:
        return None
    return mouth_gap / interocular


def extract_mouth_open_series(mp4_path: str) -> dict:
    """Extract per-frame mouth-open ratio for the (single, primary) face in mp4_path.

    Returns:
        dict with keys:
        - ratios: np.ndarray of mouth-open ratios (NaN for frames with no
          detected face)
        - fps: float, video frame rate
        - n_frames: int, total frames processed
        - n_detected: int, frames where a face was found
    """
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core.base_options import BaseOptions
    except ImportError:
        return {"ratios": np.array([]), "fps": 0.0, "n_frames": 0, "n_detected": 0,
                "note": "mediapipe not installed"}

    model_path = _get_face_landmarker_model_path()
    if not os.path.exists(model_path):
        return {"ratios": np.array([]), "fps": 0.0, "n_frames": 0, "n_detected": 0,
                "note": f"FaceLandmarker model not found: {model_path}"}

    fps = _probe_fps(mp4_path)

    with tempfile.TemporaryDirectory() as tmp:
        frame_paths = _extract_video_frames(mp4_path, tmp)
        if not frame_paths:
            return {"ratios": np.array([]), "fps": fps, "n_frames": 0, "n_detected": 0,
                    "note": "no frames extracted"}

        options = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            num_faces=1,
        )
        landmarker = vision.FaceLandmarker.create_from_options(options)

        ratios = []
        n_detected = 0
        try:
            from PIL import Image
            for frame_path in frame_paths:
                img = Image.open(frame_path).convert("RGB")
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.array(img))
                result = landmarker.detect(mp_img)
                if not result.face_landmarks:
                    ratios.append(float("nan"))
                    continue
                ratio = _mouth_open_ratio_from_landmarks(result.face_landmarks[0])
                if ratio is None:
                    ratios.append(float("nan"))
                else:
                    ratios.append(ratio)
                    n_detected += 1
        finally:
            landmarker.close()

    return {
        "ratios": np.array(ratios, dtype=np.float64),
        "fps": fps,
        "n_frames": len(frame_paths),
        "n_detected": n_detected,
    }


def extract_audio_envelope(mp4_path: str, n_samples: int) -> np.ndarray:
    """Audio RMS envelope resampled onto n_samples points spanning the clip duration."""
    sr = _probe_sample_rate(mp4_path)
    samples = _extract_audio_pcm(mp4_path)
    if len(samples) < 1024 or n_samples <= 0:
        return np.zeros(max(0, n_samples), dtype=np.float64)

    rms_frames = _frame_rms(samples).astype(np.float64)
    if rms_frames.size < 2:
        return np.zeros(n_samples, dtype=np.float64)

    # rms_frames is indexed by audio-frame hop; resample onto n_samples video
    # frame positions spanning the same time range via linear interpolation.
    src_x = np.linspace(0.0, 1.0, rms_frames.size)
    dst_x = np.linspace(0.0, 1.0, n_samples)
    return np.interp(dst_x, src_x, rms_frames)


def _lagged_pearson(a: np.ndarray, b: np.ndarray, max_lag: int) -> tuple[float, int]:
    """Best |Pearson r| between a and b over lags in [-max_lag, max_lag].

    Positive lag means b is shifted forward relative to a (b lags a).
    Returns (best_r, best_lag). NaNs in either series are dropped pairwise
    per-lag before computing r; a lag with fewer than 4 valid pairs is skipped.
    """
    best_r = 0.0
    best_lag = 0
    n = min(len(a), len(b))
    if n < 8:
        return 0.0, 0
    a = a[:n]
    b = b[:n]
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            a_seg = a[lag:]
            b_seg = b[: n - lag]
        else:
            a_seg = a[: n + lag]
            b_seg = b[-lag:]
        mask = ~(np.isnan(a_seg) | np.isnan(b_seg))
        if mask.sum() < 4:
            continue
        a_valid = a_seg[mask]
        b_valid = b_seg[mask]
        if np.std(a_valid) < 1e-9 or np.std(b_valid) < 1e-9:
            continue
        r = float(np.corrcoef(a_valid, b_valid)[0, 1])
        if abs(r) > abs(best_r):
            best_r = r
            best_lag = lag
    return best_r, best_lag


# Verdict threshold: |r| >= 0.3 is a conventional "weak-to-moderate but real"
# correlation floor in behavioral/signal-correlation literature; below that,
# mouth motion is indistinguishable from audio-independent talking motion.
ADEQUATE_R_THRESHOLD = 0.3


def measure_lipsync_precision(mp4_path: str) -> dict:
    """End-to-end: extract both series from mp4_path, correlate, verdict.

    Returns a dict with mouth/audio series stats, the lag-adjusted Pearson r,
    the chosen lag, and a verdict string ("adequate" | "inadequate" | "no_face"
    | "no_audio").
    """
    mouth = extract_mouth_open_series(mp4_path)
    if mouth.get("n_detected", 0) < 4:
        return {
            "verdict": "no_face",
            "note": mouth.get("note", "insufficient face detections"),
            "n_frames": mouth.get("n_frames", 0),
            "n_detected": mouth.get("n_detected", 0),
        }

    ratios = mouth["ratios"]
    audio_env = extract_audio_envelope(mp4_path, n_samples=len(ratios))
    if np.std(audio_env[~np.isnan(audio_env)] if np.isnan(audio_env).any() else audio_env) < 1e-9:
        return {
            "verdict": "no_audio",
            "note": "audio envelope has ~zero variance (silent/missing track)",
            "n_frames": mouth["n_frames"],
            "n_detected": mouth["n_detected"],
        }

    r, lag = _lagged_pearson(ratios, audio_env, _MAX_LAG_FRAMES)
    # Cross-check with no lag search at all: on short clips, letting the search
    # pick from a shrinking-sample-size window at extreme lags can inflate |r|
    # on noise alone (fewer valid pairs = higher spurious-correlation variance).
    # If the lag-adjusted r and the lag-0 r disagree sharply, the lag search is
    # not to be trusted and the verdict should lean on lag-0.
    mask0 = ~(np.isnan(ratios) | np.isnan(audio_env))
    lag0_r = (
        float(np.corrcoef(ratios[mask0], audio_env[mask0])[0, 1])
        if mask0.sum() >= 4 and np.std(ratios[mask0]) > 1e-9 and np.std(audio_env[mask0]) > 1e-9
        else 0.0
    )
    lag_search_hit_boundary = abs(lag) == _MAX_LAG_FRAMES

    verdict = "adequate" if abs(r) >= ADEQUATE_R_THRESHOLD else "inadequate"

    result = {
        "verdict": verdict,
        "pearson_r": round(r, 4),
        "best_lag_frames": lag,
        "lag0_pearson_r": round(lag0_r, 4),
        "fps": mouth["fps"],
        "n_frames": mouth["n_frames"],
        "n_detected": mouth["n_detected"],
        "mouth_ratio_mean": round(float(np.nanmean(ratios)), 4),
        "mouth_ratio_std": round(float(np.nanstd(ratios)), 4),
        "audio_rms_mean": round(float(np.mean(audio_env)), 6),
    }
    if lag_search_hit_boundary:
        result["caveat"] = (
            f"best_lag_frames hit the search boundary (±{_MAX_LAG_FRAMES}); on short "
            "clips this can reflect fewer valid sample pairs at extreme lags rather "
            "than genuine lip-sync offset — treat lag0_pearson_r as the more "
            "trustworthy statistic in this case."
        )
    return result


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) != 2:
        print("usage: python -m app.lipsync_metrics <mp4_path>", file=sys.stderr)
        sys.exit(1)

    result = measure_lipsync_precision(sys.argv[1])
    print(json.dumps(result, indent=2))
