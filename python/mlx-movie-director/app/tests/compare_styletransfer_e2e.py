#!/usr/bin/env python3
"""compare_styletransfer_e2e.py — sanity comparison between the Swift
`flux2 styletransfer` port and the Python `run.py image styletransfer`
reference (Task 4 of
docs/superpowers/plans/2026-07-30-styletransfer-swift-native-port.md).

NOT a bit-exact numeric-parity gate: two independent implementations of a
multi-step SDEdit denoise loop compound floating-point divergence even when
every underlying component (transformer/VAE/text-encoder) matches. This
checks both outputs are real, non-degenerate images (not blank/noise) and
LOGS (does not gate on) their pixel cosine similarity as a diagnostic for a
human to judge convergence quality.

Run from repo root (requires a built flux2 Swift binary and a working Python
mflux install):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_styletransfer_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]
CONTENT_PROMPT = (
    "a detective in a trench coat standing in a rainy noir alley, holding "
    "a magnifying glass, dramatic street lamp lighting, wet cobblestone, "
    "medium shot, detailed, high quality."
)
STYLE_PRESET = "watercolor"
SEED = 42
STEPS = 4
STRENGTH = 0.55
WIDTH = 768
HEIGHT = 1024


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
    """run.py image t2i/styletransfer have no --output flag — they write an
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
        content_dir = tmp_path / "content"
        python_out_dir = tmp_path / "python_styletransfer"
        content_dir.mkdir()
        python_out_dir.mkdir()
        swift_out = tmp_path / "swift.png"

        # Synthesize a deterministic content image (same fixture as
        # image-styletransfer.py's own --self-test _synth_content: fixed
        # prompt/seed/steps/size).
        #
        # NOTE: `run.py image t2i` has no --output flag — it always writes an
        # auto-timestamped <base_name>.png into the generation output dir
        # (overridden per-call via the global --gen-output-dir flag). Point
        # it at an isolated tmp dir and glob for the resulting file.
        print("[compare_styletransfer_e2e] synthesizing a content image...")
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "t2i", "--prompt", CONTENT_PROMPT,
             "--seed", "42", "--steps", "9", "--width", str(WIDTH), "--height", str(HEIGHT),
             "--gen-output-dir", str(content_dir)],
            check=True, cwd=REPO,
        )
        content_path = find_single_png(content_dir)
        print(f"[compare_styletransfer_e2e] content: {content_path}")

        print("[compare_styletransfer_e2e] running Swift flux2 styletransfer...")
        flux2_bin = REPO / "swift" / "flux2-image-director" / ".build" / "release" / "flux2"
        if not flux2_bin.exists():
            print(f"ERROR: {flux2_bin} not built — run: "
                  f"swift build -c release --package-path swift/flux2-image-director", file=sys.stderr)
            sys.exit(1)
        # Swift `flux2 styletransfer` DOES accept an explicit --output path
        # (StyleTransferCommand.swift's `output` option, via OutputPathResolver).
        subprocess.run(
            [str(flux2_bin), "styletransfer", "--input", str(content_path),
             "--style-preset", STYLE_PRESET, "--strength", str(STRENGTH),
             "--seed", str(SEED), "--steps", str(STEPS),
             "--width", str(WIDTH), "--height", str(HEIGHT),
             "--output", str(swift_out), "--no-artifacts"],
            check=True, cwd=REPO,
        )

        print("[compare_styletransfer_e2e] running run.py image styletransfer (Python reference)...")
        # Same --output caveat as t2i above: `run.py image styletransfer` has
        # no --output flag either — use --gen-output-dir + glob.
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "styletransfer", "--input", str(content_path),
             "--style-preset", STYLE_PRESET, "--strength", str(STRENGTH),
             "--seed", str(SEED), "--steps", str(STEPS),
             "--width", str(WIDTH), "--height", str(HEIGHT),
             "--gen-output-dir", str(python_out_dir)],
            check=True, cwd=REPO,
        )
        python_out = find_single_png(python_out_dir)

        swift_arr = analyze(swift_out, "swift")
        python_arr = analyze(python_out, "python")

        if swift_arr.shape != python_arr.shape:
            # Diagnostic-only (see module docstring) — the pass/fail gate is
            # each analyze() call above, already satisfied independently. A
            # shape mismatch shouldn't happen given both invocations pass the
            # same --width/--height, but skip the dot product rather than let
            # np.dot raise an unguarded ValueError on mismatched 1-D lengths.
            print(f"\n[compare_styletransfer_e2e] shape mismatch swift={swift_arr.shape} "
                  f"python={python_arr.shape} — skipping cosine similarity diagnostic")
        else:
            flat_s, flat_p = swift_arr.flatten(), python_arr.flatten()
            cos = float(np.dot(flat_s, flat_p) / (np.linalg.norm(flat_s) * np.linalg.norm(flat_p) + 1e-12))
            print(f"\n[compare_styletransfer_e2e] pixel cosine similarity (diagnostic, not gated): {cos:.4f}")

    print("\n✅ both outputs are real, non-degenerate images")


if __name__ == "__main__":
    main()
