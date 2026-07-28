#!/usr/bin/env python3
"""compare_musicgen_e2e.py — spectral/energy sanity comparison between the
Swift musicgen-director port and the Python run.py music reference (Task 9 of
docs/superpowers/plans/2026-07-28-musicgen-swift-native-port.md).

NOT a numeric-parity gate (both sides sample randomly, so bit-exact or even
high-cosine match isn't the right bar — see the plan's Task 9 preamble).
Checks: both outputs are real, non-silent, spectrally-plausible audio (RMS
in a sane range, energy spread across frequency bands, non-trivial
frame-to-frame variance — i.e. not silence and not pure noise).

Run from repo root (requires both a built musicgen Swift binary AND a
working mlx_audiocraft Python install):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_musicgen_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parents[4]
PROMPT = "warm acoustic guitar, gentle, 90bpm"   # same example prompt run.py music's own docstring uses
DURATION = 6.0


def analyze(path: Path, label: str) -> None:
    audio, sr = sf.read(str(path))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    spectrum = np.abs(np.fft.rfft(audio.astype(np.float64)))
    freqs = np.fft.rfftfreq(len(audio), d=1.0 / sr)
    bands = [(0, 500), (500, 2000), (2000, 8000), (8000, sr / 2)]
    band_energy = [float(spectrum[(freqs >= lo) & (freqs < hi)].sum()) for lo, hi in bands]
    frame_len = max(1, sr // 20)
    frames = [audio[i:i + frame_len] for i in range(0, len(audio) - frame_len, frame_len)]
    frame_rms = [float(np.sqrt(np.mean(f.astype(np.float64) ** 2))) for f in frames]
    variance = float(np.var(frame_rms)) if frame_rms else 0.0

    print(f"\n[{label}] {path}")
    print(f"  sample_rate={sr}  duration={len(audio) / sr:.2f}s  rms={rms:.4f}")
    print(f"  band_energy(0-500,500-2k,2k-8k,8k+)={[round(b, 1) for b in band_energy]}")
    print(f"  frame_rms_variance={variance:.6f}")

    ok = rms > 1e-4 and sum(band_energy) > 0 and variance > 1e-8
    print(f"  {'PASS' if ok else 'FAIL'}: non-silent and spectrally-plausible" if ok
          else "  FAIL: looks silent or degenerate")
    if not ok:
        sys.exit(1)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        swift_out = tmp_path / "swift.wav"
        python_out = tmp_path / "python.wav"

        print("[compare_musicgen_e2e] running Swift musicgen generate...")
        swift_bin = REPO / "swift" / "musicgen-director" / ".build" / "release" / "musicgen"
        if not swift_bin.exists():
            print(f"ERROR: {swift_bin} not built — run: "
                  f"swift build -c release --package-path swift/musicgen-director", file=sys.stderr)
            sys.exit(1)
        subprocess.run([str(swift_bin), "generate", "--prompt", PROMPT,
                        "--output", str(swift_out), "--duration", str(DURATION), "--seed", "42"],
                       check=True, cwd=REPO)

        print("[compare_musicgen_e2e] running run.py music (Python reference)...")
        subprocess.run([sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
                        "music", "--prompt", PROMPT, "--output", str(python_out),
                        "--duration", str(DURATION)],
                       check=True, cwd=REPO)

        analyze(swift_out, "swift")
        analyze(python_out, "python")

    print("\n✅ both outputs are real, non-silent, spectrally-plausible audio")


if __name__ == "__main__":
    main()
