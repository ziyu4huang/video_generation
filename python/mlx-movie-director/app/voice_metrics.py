"""voice_metrics — richer voice-quality metrics for generated speech clips.

Complements ``app.audio_noise_detect`` (the numpy-only noise gate) with
numpy + scipy metrics that capture *quality / naturalness* dimensions the gate
cannot. The noise gate answers "is this white noise?"; these metrics answer
"is this GOOD speech?" — the dimension that actually differentiates cells which
all pass ASR at ~100%.

Metrics (all from a single decoded audio array):
  - snr_db               signal-to-noise (clean vs noisy) — signal = mean frame
                         energy, noise = mean of the bottom-10% frame energies
  - speech_activity      fraction of the clip that is voiced (relative to peak
                         RMS) — detects truncation / over-talk / dead air
  - f0_mean / f0_std     pitch mean + std (Hz), autocorrelation on voiced frames
  - f0_st_std            pitch variation in SEMITONES relative to median F0 —
                         the naturalness proxy (low = monotone/robotic = the
                         ~60% MLX voice ceiling symptom). Independent of pitch.
  - dynamic_range_db     peak vs RMS headroom (low = compressed / clipped)
  - onset_rate           speech-cadence onsets per second (scipy find_peaks)
  - spectral_centroid_hz brightness proxy (FFT centroid)
  - duration_s           clip length (len/sr)

Audio is decoded once via ``audio_noise_detect._extract_audio_pcm`` at its
native rate (48 kHz for LTX output); the actual rate is probed via ffprobe so
the F0 math is exact. No new dependencies: numpy + scipy.signal only — the
noise gate's "numpy + ffmpeg, no scipy" contract is untouched.

KNOWN bug (not fixed here, to keep audio_noise_detect.py byte-identical):
``_extract_audio_pcm``'s ``sample_rate`` branch mis-orders the ffmpeg ``-ac``/
``-ar`` args, so passing ``sample_rate`` yields an empty array. We therefore
always decode at the native rate (no ``sample_rate``) and probe the rate
ourselves.
"""

from __future__ import annotations

import subprocess

import numpy as np
from scipy import signal as _sig

# Same-package reuse of the already-tested decode helper. We call it WITHOUT a
# sample_rate (native decode) because the sample_rate-insertion branch in
# _extract_audio_pcm mis-orders the ffmpeg args (see KNOWN bug). The actual
# sample rate is probed separately via ffprobe so F0 math is exact.
from app.audio_noise_detect import _extract_audio_pcm  # noqa: E402


def _probe_sample_rate(mp4_path: str) -> int:
    """Return the audio track's native sample rate (Hz); 48000 on any failure."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate", "-of", "csv=p=0", mp4_path],
            capture_output=True, text=True, timeout=30,
        )
        return int((r.stdout or "").strip() or 48000)
    except Exception:
        return 48000


def _frame_rms(samples: np.ndarray, frame: int = 1024, hop: int = 512) -> np.ndarray:
    """Per-frame RMS energy (one value per hop)."""
    if len(samples) < frame:
        frame = max(64, len(samples))
    n = max(0, 1 + (len(samples) - frame) // hop)
    out = np.zeros(n, dtype=np.float32)
    for i in range(n):
        seg = samples[i * hop : i * hop + frame].astype(np.float64)
        out[i] = np.sqrt(np.mean(seg ** 2))
    return out


def _snr_db(rms_frames: np.ndarray) -> float:
    """SNR in dB from an RMS envelope: signal = mean energy, noise = bottom-10%."""
    if rms_frames.size < 4:
        return 0.0
    e = rms_frames ** 2
    k = max(1, int(0.1 * e.size))
    noise = float(np.mean(np.sort(e)[:k]))
    sig = float(np.mean(e))
    if noise <= 1e-12 or sig <= 1e-12:
        return 0.0
    return float(10.0 * np.log10(sig / noise))


def _f0_track(samples: np.ndarray, sr: int,
              frame: int = 1024, hop: int = 512) -> list[float]:
    """Autocorrelation F0 (Hz) per voiced frame; unvoiced frames are skipped.

    Voicing guard: a frame must clear 8% of peak RMS, and its normalized
    autocorrelation peak in the 60–500 Hz lag band must exceed 0.3.
    """
    if len(samples) < frame:
        return []
    lag_min = int(sr / 500.0)   # 500 Hz ceiling
    lag_max = int(sr / 60.0)    # 60 Hz floor
    if lag_max >= frame:
        lag_max = frame - 1

    rms = _frame_rms(samples, frame, hop)
    if rms.size == 0:
        return []
    voiced_thr = 0.08 * float(np.max(rms))

    n = rms.size
    f0s: list[float] = []
    for i in range(n):
        if rms[i] < voiced_thr:
            continue
        seg = samples[i * hop : i * hop + frame].astype(np.float64)
        seg = seg - seg.mean()
        win = seg * np.hanning(frame)
        ac = np.correlate(win, win, mode="full")[frame - 1:]  # lags 0..frame-1
        ac = ac / (ac[0] + 1e-12)
        band = ac[lag_min : lag_max + 1]
        if band.size == 0:
            continue
        lag_rel = int(np.argmax(band))
        if float(band[lag_rel]) < 0.3:          # weak periodicity → unvoiced
            continue
        lag = lag_min + lag_rel
        if lag <= 0:
            continue
        f0s.append(sr / lag)
    return f0s


def analyze_voice(mp4_path: str) -> dict:
    """Compute rich voice-quality metrics for an mp4's audio track.

    Returns a dict whose values are all finite floats (0.0 on failure / empty
    audio). Duration is included so callers can normalize rates.
    """
    sr = _probe_sample_rate(mp4_path)
    samples = _extract_audio_pcm(mp4_path)
    res: dict = {
        "snr_db": 0.0, "speech_activity": 0.0,
        "f0_mean": 0.0, "f0_std": 0.0, "f0_st_std": 0.0,
        "dynamic_range_db": 0.0, "onset_rate": 0.0,
        "spectral_centroid_hz": 0.0, "duration_s": 0.0,
    }
    if len(samples) < 1024:
        res["note"] = "audio too short or missing"
        return res

    duration = len(samples) / float(sr)
    res["duration_s"] = round(duration, 3)

    # --- RMS envelope → SNR + speech activity ---
    rms_frames = _frame_rms(samples)
    res["snr_db"] = round(_snr_db(rms_frames), 2)
    peak_rms = float(np.max(rms_frames)) if rms_frames.size else 0.0
    if peak_rms > 1e-6:
        res["speech_activity"] = round(float(np.mean(rms_frames > 0.15 * peak_rms)), 3)

    # --- dynamic range (peak vs RMS) ---
    peak = float(np.max(np.abs(samples)))
    rms_all = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    if peak > 1e-6 and rms_all > 1e-9:
        res["dynamic_range_db"] = round(20.0 * np.log10(peak / rms_all), 2)

    # --- pitch (F0) on voiced frames ---
    f0s = _f0_track(samples, sr)
    if len(f0s) >= 2:
        arr = np.asarray(f0s, dtype=np.float64)
        med = float(np.median(arr))
        res["f0_mean"] = round(float(np.mean(arr)), 1)
        res["f0_std"] = round(float(np.std(arr)), 1)
        # semitone deviation from the median → pitch-spread independent of F0
        st = 12.0 * np.log2(arr / (med + 1e-9))
        res["f0_st_std"] = round(float(np.std(st)), 2)

    # --- onset rate (speech cadence) ---
    if rms_frames.size > 4 and duration > 0:
        prom = max(1e-6, 0.15 * float(np.max(rms_frames)))
        peaks, _ = _sig.find_peaks(rms_frames, prominence=prom, distance=8)
        res["onset_rate"] = round(len(peaks) / duration, 2)

    # --- spectral centroid (brightness) of a representative window ---
    frame = 1 << int(np.floor(np.log2(max(64, len(samples)))))
    frame = min(2048, frame)
    seg = samples[:frame].astype(np.float64) * np.hanning(frame)
    spec = np.abs(np.fft.rfft(seg)) + 1e-12
    freqs = np.fft.rfftfreq(frame, d=1.0 / sr)
    if np.sum(spec) > 1e-9:
        res["spectral_centroid_hz"] = round(float(np.sum(freqs * spec) / np.sum(spec)), 1)

    return res
