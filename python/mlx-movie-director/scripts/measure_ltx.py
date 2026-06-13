#!/usr/bin/env python3
"""measure_ltx — deterministic single-clip voice+quality scorer for LTX.

Emits ONE JSON line combining voice (ASR + app.voice_metrics) and video-quality
(app.quality_metrics) into a weighted composite. Used by the
mlx-movie-director-ltx-self-improve workflow's Measure step, and reusable
standalone. Deterministic: same mp4 → identical output (ASR is deterministic given
the same mlx-whisper release + model), so adopt/revert decisions are sound.

The composite scoring is implemented LOCALLY here (not imported) so this scorer
is self-contained. The voice composite mirrors scripts/build_voice_review.py's
``_voice_score`` weights + bounds exactly (keep them in sync if either changes).

Exits non-zero ONLY on a true measurement failure (no audio / no decodable video
frames) so the caller can self-fix (re-roll seed). A low-but-valid score exits 0
— that is a real measurement, not a failure.

Output JSON:
  {
    "mp4": "...",
    "composite": 71.3,            # weighted (active axes only)
    "voice_score": 74.0,          # 0-100, or null if voice_weight=0
    "quality_score": 68.5,        # 0-100, or null if unreadable / weight=0
    "weakest": "voice.snr",       # lowest weighted sub-component (axis.dimension)
    "is_noise": false,
    "duration_s": 2.347,
    "asr": {"transcript": "...", "similarity": 100.0},
    "voice": {snr_db, f0_mean, f0_st_std, ...},
    "quality": {snr_db, contrast, edge_density, noise_sigma, blockiness, ...}
  }

Usage:
  python/venv/bin/python scripts/measure_ltx.py --mp4 output/X.mp4 \\
      --target "Time to create"
  python/venv/bin/python scripts/measure_ltx.py --mp4 X.mp4 \\
      --voice-weight 0 --quality-weight 1      # quality only
  python/venv/bin/python scripts/measure_ltx.py --mp4 X.mp4 --no-asr  # skip ASR
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys

import cv2
import numpy as np

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

from app.audio_noise_detect import is_audio_noise  # noqa: E402
from app.voice_metrics import analyze_voice  # noqa: E402
from app.quality_metrics import analyze_frame  # noqa: E402

DEFAULT_TARGET = "Time to create"
DEFAULT_ASR_MODEL = "mlx-community/whisper-small-mlx"


# ---------------------------------------------------------------------------
# Composite scoring (local, deterministic). Voice mirrors build_voice_review.
# ---------------------------------------------------------------------------

def _clip01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _voice_components(vm: dict, asr_sim: float | None) -> dict:
    """Normalized (0-1) voice sub-scores. Mirrors build_voice_review._voice_score."""
    return {
        "asr": _clip01((asr_sim or 0.0) / 100.0),
        "snr": _clip01((float(vm.get("snr_db", 0.0)) - 3.0) / 15.0),
        "f0": _clip01(float(vm.get("f0_st_std", 0.0)) / 3.0),
        "centroid": _clip01((float(vm.get("spectral_centroid_hz", 0.0)) - 800.0) / 2000.0),
        "dynamic_range": _clip01((float(vm.get("dynamic_range_db", 0.0)) - 6.0) / 12.0),
    }


def _voice_score(vm: dict, asr_sim: float | None) -> float:
    c = _voice_components(vm, asr_sim)
    w = {"asr": 0.40, "snr": 0.20, "f0": 0.15, "centroid": 0.15, "dr": 0.10}
    return 100.0 * (w["asr"] * c["asr"] + w["snr"] * c["snr"] + w["f0"] * c["f0"]
                    + w["centroid"] * c["centroid"] + w["dr"] * c["dynamic_range"])


def _quality_components(qm: dict) -> dict:
    """Normalized (0-1) quality sub-scores. Bounds calibrated to LTX-frame ranges."""
    return {
        "snr": _clip01((float(qm.get("snr_db", 0.0)) - 20.0) / 30.0),
        "contrast": _clip01((float(qm.get("contrast", 0.0)) - 20.0) / 60.0),
        "edge": _clip01((float(qm.get("edge_density", 0.0)) - 10.0) / 50.0),
        "noise": _clip01(1.0 - (float(qm.get("noise_sigma", 0.0)) - 0.5) / 4.0),
        "block": _clip01(1.0 - (float(qm.get("blockiness", 0.0)) - 5.0) / 35.0),
    }


def _composite_quality_score(qm: dict) -> float:
    c = _quality_components(qm)
    w = {"snr": 0.30, "contrast": 0.20, "edge": 0.20, "noise": 0.20, "block": 0.10}
    return 100.0 * (w["snr"] * c["snr"] + w["contrast"] * c["contrast"]
                    + w["edge"] * c["edge"] + w["noise"] * c["noise"]
                    + w["block"] * c["block"])


def _normalize_text(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return " ".join(s.split())


def _similarity(transcript: str, target: str) -> float:
    """0-100 sequence-match ratio vs the target phrase (mirrors build_voice_review)."""
    return difflib.SequenceMatcher(None, _normalize_text(transcript),
                                   _normalize_text(target)).ratio() * 100.0


def _run_asr(mp4: str, target: str, model: str) -> dict:
    try:
        import mlx_whisper
    except Exception as e:
        return {"transcript": "", "similarity": None, "error": f"mlx_whisper unavailable: {e}"}
    try:
        res = mlx_whisper.transcribe(mp4, path_or_hf_repo=model,
                                     language="en", initial_prompt=target)
        text = (res.get("text") or "").strip()
        return {"transcript": text, "similarity": _similarity(text, target)}
    except Exception as e:
        return {"transcript": "", "similarity": None, "error": str(e)}


def _quality_metrics(mp4: str, n_frames: int) -> dict:
    """Average analyze_frame() over n_frames evenly-spaced frames."""
    cap = cv2.VideoCapture(mp4)
    if not cap.isOpened():
        raise RuntimeError("cannot open video")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        cap.release()
        raise RuntimeError("no frames reported")
    idxs = [min(total - 1, int((i + 0.5) * total / n_frames)) for i in range(n_frames)]
    qms: list[dict] = []
    for idx in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, idx))
        ok, bgr = cap.read()
        if not ok or bgr is None:
            continue
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)
        qms.append(analyze_frame(gray, bgr))
    cap.release()
    if not qms:
        raise RuntimeError("no decodable frames")
    return {k: float(np.mean([q[k] for q in qms])) for k in qms[0]}


def _weakest(vc: dict | None, qc: dict | None, vw: float, qw: float) -> str:
    """Name of the lowest weighted sub-component across active axes
    ('voice.snr' / 'quality.noise' / ...). Weighted so an inactive axis never wins."""
    cands: list[tuple[float, str]] = []
    if vc is not None and vw > 0:
        cands += [(vw * v, f"voice.{k}") for k, v in vc.items()]
    if qc is not None and qw > 0:
        cands += [(qw * v, f"quality.{k}") for k, v in qc.items()]
    if not cands:
        return ""
    return min(cands, key=lambda t: t[0])[1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mp4", required=True)
    ap.add_argument("--target", default=DEFAULT_TARGET, help="expected spoken phrase")
    ap.add_argument("--asr-model", default=DEFAULT_ASR_MODEL)
    ap.add_argument("--no-asr", action="store_true", help="skip ASR (asr_sim=0)")
    ap.add_argument("--voice-weight", type=float, default=0.5)
    ap.add_argument("--quality-weight", type=float, default=0.5)
    ap.add_argument("--quality-frames", type=int, default=4,
                    help="frames to sample for quality metrics (default 4)")
    args = ap.parse_args()

    if not os.path.exists(args.mp4):
        json.dump({"mp4": args.mp4, "error": "file not found"}, sys.stdout)
        print()
        sys.exit(2)

    vw, qw = args.voice_weight, args.quality_weight

    # --- voice axis ---
    vm = analyze_voice(args.mp4)
    is_noise, nm = is_audio_noise(args.mp4)
    asr = {"transcript": "", "similarity": None} if args.no_asr else _run_asr(
        args.mp4, args.target, args.asr_model)
    vc = _voice_components(vm, asr.get("similarity")) if vw > 0 else None
    vscore = _voice_score(vm, asr.get("similarity")) if vw > 0 else None

    # --- quality axis ---
    qscore = None
    qc = None
    qm: dict = {}
    qerr = None
    if qw > 0:
        try:
            qm = _quality_metrics(args.mp4, args.quality_frames)
            qc = _quality_components(qm)
            qscore = _composite_quality_score(qm)
        except Exception as e:  # unreadable video → quality axis unavailable
            qerr = str(e)

    # --- weighted composite over available axes ---
    wsum = (vw if vscore is not None else 0.0) + (qw if qscore is not None else 0.0)
    if wsum <= 0:
        wsum = 1.0
    composite = ((vw if vscore is not None else 0.0) * (vscore or 0.0)
                 + (qw if qscore is not None else 0.0) * (qscore or 0.0)) / wsum

    out = {
        "mp4": args.mp4,
        "composite": round(composite, 2),
        "voice_score": None if vscore is None else round(vscore, 1),
        "quality_score": None if qscore is None else round(qscore, 1),
        "weakest": _weakest(vc, qc, vw if vscore is not None else 0, qw if qscore is not None else 0),
        "is_noise": bool(is_noise),
        "duration_s": vm.get("duration_s", 0.0),
        "asr": asr,
        "voice": vm,
        "quality": qm,
        "flatness": nm.get("spectral_flatness"),
        "zcr": nm.get("zcr"),
    }
    if qerr:
        out["quality_error"] = qerr
    print(json.dumps(out, ensure_ascii=False))

    # True measurement failure → non-zero so the caller self-fixes (re-roll seed).
    if vm.get("duration_s", 0.0) < 0.5:
        sys.exit(1)


if __name__ == "__main__":
    main()
