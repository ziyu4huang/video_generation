#!/usr/bin/env python3
"""compare_kontext_e2e.py — sanity comparison between the Swift `flux2 kontext`
port and the Python `run.py image kontext` reference (Task 6 of
docs/superpowers/plans/2026-07-29-kontext-swift-native-port.md).

NOT a bit-exact numeric-parity gate: KontextTransformer/CLIP/T5/VAE are each
independently verified at cos>=0.99 (see swift/flux2-image-director's
verify-kontext-* commands), but a full 20-step denoise loop compounds
floating-point divergence between two independent implementations even when
every component matches. This checks both outputs are real, non-degenerate
images (not blank/noise) and LOGS (does not gate on) their pixel cosine
similarity as a diagnostic for a human to judge convergence quality.

Run from repo root (requires a built flux2 Swift binary, a working Python
mflux install, and Task 1's imported Kontext weights):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_kontext_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]
PROMPT = "the same person, now wearing a red jacket, studio lighting"
SEED = 42
STEPS = 20
SIZE = 1024


def load_rgb(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGB")).astype(np.float64)


def analyze(path: Path, label: str) -> np.ndarray:
    arr = load_rgb(path)
    mean = float(arr.mean())
    std = float(arr.std())
    print(f"\n[{label}] {path}")
    print(f"  shape={arr.shape}  mean={mean:.2f}  std={std:.2f}")
    # A blank/degenerate image has near-zero std; real photos have substantial
    # pixel variance. 5.0 (on a 0-255 scale) is a generous floor.
    ok = std > 5.0
    print(f"  {'PASS' if ok else 'FAIL'}: non-degenerate (std={std:.2f})")
    if not ok:
        sys.exit(1)
    return arr


def find_single_png(dir_path: Path) -> Path:
    """run.py image t2i/kontext have no --output flag — they write an
    auto-timestamped <base_name>.png (plus .run.json/.manifest.json sidecars)
    into the generation output dir. Point --gen-output-dir at an empty tmp
    dir per call so exactly one .png is ever present to find."""
    pngs = sorted(dir_path.glob("*.png"))
    if len(pngs) != 1:
        print(f"ERROR: expected exactly 1 .png in {dir_path}, found {len(pngs)}: {pngs}",
              file=sys.stderr)
        sys.exit(1)
    return pngs[0]


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        hero_dir = tmp_path / "hero"
        python_kontext_dir = tmp_path / "python_kontext"
        hero_dir.mkdir()
        python_kontext_dir.mkdir()
        swift_out = tmp_path / "swift.png"

        # Synthesize a deterministic hero portrait via the existing ZImage T2I
        # path (matches image-kontext.py's own _synth_hero pattern — a plain
        # solid-color placeholder is NOT representative of a real
        # identity-anchor use case, but is sufficient for a structural sanity
        # check; a fixed seed keeps it reproducible run-to-run).
        #
        # NOTE: `run.py image t2i` has no --output flag — it always writes an
        # auto-timestamped <base_name>.png into the generation output dir
        # (overridden per-call via the global --gen-output-dir flag, see
        # app/cli.py's _global_parser). Point it at an isolated tmp dir and
        # glob for the resulting file.
        print("[compare_kontext_e2e] synthesizing a hero portrait...")
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "t2i", "--prompt", "portrait photo of a young woman, neutral background, studio lighting",
             "--seed", "7", "--steps", "8", "--gen-output-dir", str(hero_dir)],
            check=True, cwd=REPO,
        )
        hero_path = find_single_png(hero_dir)
        print(f"[compare_kontext_e2e] hero: {hero_path}")

        print("[compare_kontext_e2e] running Swift flux2 kontext...")
        flux2_bin = REPO / "swift" / "flux2-image-director" / ".build" / "release" / "flux2"
        if not flux2_bin.exists():
            print(f"ERROR: {flux2_bin} not built — run: "
                  f"swift build -c release --package-path swift/flux2-image-director", file=sys.stderr)
            sys.exit(1)
        # Swift `flux2 kontext` DOES accept an explicit --output path
        # (KontextCommand.swift's `output` option, via OutputPathResolver).
        subprocess.run(
            [str(flux2_bin), "kontext", "--input", str(hero_path), "--prompt", PROMPT,
             "--seed", str(SEED), "--steps", str(STEPS), "--width", str(SIZE), "--height", str(SIZE),
             "--output", str(swift_out), "--no-artifacts"],
            check=True, cwd=REPO,
        )

        print("[compare_kontext_e2e] running run.py image kontext (Python reference)...")
        # Same --output caveat as t2i above: `run.py image kontext` has no
        # --output flag either — use --gen-output-dir + glob.
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "kontext", "--input", str(hero_path), "--prompt", PROMPT,
             "--seed", str(SEED), "--steps", str(STEPS), "--width", str(SIZE), "--height", str(SIZE),
             "--gen-output-dir", str(python_kontext_dir)],
            check=True, cwd=REPO,
        )
        python_out = find_single_png(python_kontext_dir)

        swift_arr = analyze(swift_out, "swift")
        python_arr = analyze(python_out, "python")

        if swift_arr.shape != python_arr.shape:
            # Diagnostic-only (see module docstring) — the pass/fail gate is
            # each analyze() call above, already satisfied independently. A
            # shape mismatch shouldn't happen given both invocations pass the
            # same --width/--height, but skip the dot product rather than let
            # np.dot raise an unguarded ValueError on mismatched 1-D lengths.
            print(f"\n[compare_kontext_e2e] shape mismatch swift={swift_arr.shape} "
                  f"python={python_arr.shape} — skipping cosine similarity diagnostic")
        else:
            flat_s, flat_p = swift_arr.flatten(), python_arr.flatten()
            cos = float(np.dot(flat_s, flat_p) / (np.linalg.norm(flat_s) * np.linalg.norm(flat_p) + 1e-12))
            print(f"\n[compare_kontext_e2e] pixel cosine similarity (diagnostic, not gated): {cos:.4f}")

    print("\n✅ both outputs are real, non-degenerate images")


if __name__ == "__main__":
    main()
