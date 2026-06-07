"""audio_noise_detect — Detect whether generated audio is noise (not meaningful sound).

Uses only numpy + ffmpeg subprocess. No scipy/librosa required.

Analyzes audio at native sample rate (no downsampling). LTX-2.3 generates
audio at 48kHz; downsampling to 16kHz destroys spectral structure and causes
false-positive noise detection.

Metrics:
  - Spectral flatness (Wiener entropy): geometric mean / arithmetic mean of
    the power spectrum. White noise ≈ 1.0; speech/music ≈ 0.1–0.3.
  - Zero-crossing rate (ZCR): noise has consistently high ZCR.

Decision: spectral_flatness > 0.55 AND zcr > 0.4 → noise.
Thresholds tunable via env vars LTX_NOISE_FLATNESS_THRESH / LTX_NOISE_ZCR_THRESH.
"""

import os
import subprocess
import sys

import numpy as np


# ---------------------------------------------------------------------------
# Thresholds (overridable via env vars for tuning without code changes)
# ---------------------------------------------------------------------------

_FLATNESS_THRESH = float(os.environ.get("LTX_NOISE_FLATNESS_THRESH", "0.55"))
_ZCR_THRESH = float(os.environ.get("LTX_NOISE_ZCR_THRESH", "0.40"))


# ---------------------------------------------------------------------------
# Low-level metric functions
# ---------------------------------------------------------------------------

def _extract_audio_pcm(mp4_path: str, sample_rate: int | None = None) -> np.ndarray:
    """Extract audio from MP4 as mono float32 numpy array via ffmpeg.

    By default uses the file's native sample rate (no resampling) to
    preserve spectral structure.  LTX-2.3 audio is generated at 48kHz;
    downsampling to 16kHz destroys high-frequency content and inflates
    both spectral flatness and ZCR, causing false-positive noise detection.
    """
    cmd = [
        "ffmpeg", "-i", mp4_path,
        "-vn",                    # no video
        "-acodec", "pcm_s16le",   # raw PCM 16-bit little-endian
        "-ac", "1",               # mono
        "-f", "s16le",            # raw format
        "pipe:1",                 # stdout
    ]
    if sample_rate is not None:
        cmd.insert(cmd.index("-ac") + 1, "-ar")
        cmd.insert(cmd.index("-ac") + 2, str(sample_rate))
    result = subprocess.run(cmd, capture_output=True, timeout=30)
    if result.returncode != 0:
        # No audio track or ffmpeg error — treat as no audio (not noise)
        return np.array([], dtype=np.float32)

    raw = result.stdout
    if len(raw) < 2:
        return np.array([], dtype=np.float32)

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def _compute_spectral_flatness(samples: np.ndarray, fft_size: int = 2048) -> float:
    """Compute spectral flatness. Returns value in [0, 1].

    High values (>0.6) indicate noise-like signal.
    """
    if len(samples) < fft_size:
        fft_size = len(samples)
    if fft_size < 64:
        return 0.0

    # Take multiple frames and average for robustness
    n_frames = max(1, (len(samples) - fft_size) // (fft_size // 2))
    flatness_values = []

    for i in range(min(n_frames, 8)):  # cap at 8 frames
        offset = i * (fft_size // 2)
        if offset + fft_size > len(samples):
            break
        frame = samples[offset : offset + fft_size]
        window = np.hanning(fft_size)
        frame = frame * window

        spectrum = np.abs(np.fft.rfft(frame))
        spectrum = spectrum + 1e-10  # avoid log(0)

        log_spectrum = np.log(spectrum)
        geometric_mean = np.exp(np.mean(log_spectrum))
        arithmetic_mean = np.mean(spectrum)

        flatness_values.append(geometric_mean / arithmetic_mean)

    return float(np.mean(flatness_values)) if flatness_values else 0.0


def _compute_zcr(samples: np.ndarray, frame_size: int = 2048) -> float:
    """Compute average zero-crossing rate."""
    if len(samples) < frame_size:
        frame_size = len(samples)
    if frame_size < 64:
        return 0.0

    n_frames = max(1, (len(samples) - frame_size) // (frame_size // 2))
    zcr_values = []

    for i in range(min(n_frames, 8)):
        offset = i * (frame_size // 2)
        if offset + frame_size > len(samples):
            break
        frame = samples[offset : offset + frame_size]
        signs = np.sign(frame)
        crossings = np.sum(np.abs(np.diff(signs)) > 0)
        zcr_values.append(crossings / frame_size)

    return float(np.mean(zcr_values)) if zcr_values else 0.0


def _compute_rms(samples: np.ndarray) -> float:
    """Compute root-mean-square energy."""
    if len(samples) == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples**2)))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_audio_noise(mp4_path: str) -> tuple[bool, dict]:
    """Check if the audio track in an MP4 is noise rather than meaningful sound.

    Returns:
        (is_noise, metrics) where metrics is a dict with keys:
        - spectral_flatness: float in [0, 1]
        - zcr: float zero-crossing rate
        - rms: float root-mean-square energy
        - samples: int number of audio samples analyzed
    """
    samples = _extract_audio_pcm(mp4_path)

    if len(samples) < 1024:
        # Too short or no audio track — not noise (nothing to complain about)
        return False, {
            "spectral_flatness": 0.0,
            "zcr": 0.0,
            "rms": 0.0,
            "samples": len(samples),
            "note": "audio track too short or missing",
        }

    flatness = _compute_spectral_flatness(samples)
    zcr = _compute_zcr(samples)
    rms = _compute_rms(samples)

    # Decision: both metrics must exceed thresholds (conservative)
    is_noise = flatness > _FLATNESS_THRESH and zcr > _ZCR_THRESH

    metrics = {
        "spectral_flatness": round(flatness, 4),
        "zcr": round(zcr, 4),
        "rms": round(rms, 6),
        "samples": len(samples),
    }

    return is_noise, metrics


def check_audio_noise_or_exit(mp4_path: str, *, allow_noise: bool = False) -> dict | None:
    """Check audio for noise; print error and exit(1) if detected.

    Args:
        mp4_path: Path to the MP4 file to analyze.
        allow_noise: If True, suppress the error exit (still print warning).

    Returns:
        metrics dict if noise was detected, None otherwise.
    """
    is_noise, metrics = is_audio_noise(mp4_path)

    if is_noise:
        msg = (
            f"WARNING: Audio appears to be noise "
            f"(spectral_flatness={metrics['spectral_flatness']:.3f}, "
            f"zcr={metrics['zcr']:.3f}, rms={metrics['rms']:.5f})"
        )
        if allow_noise:
            print(f"[video] {msg} — suppressed by --allow-noise", file=sys.stderr)
            return metrics
        else:
            print(
                f"ERROR: {msg}. "
                f"Re-try with a different seed, or use --allow-noise to suppress.",
                file=sys.stderr,
            )
            sys.exit(1)

    return None
