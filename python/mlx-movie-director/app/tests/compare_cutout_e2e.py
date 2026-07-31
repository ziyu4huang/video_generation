#!/usr/bin/env python3
"""compare_cutout_e2e.py — sanity comparison between the Swift `flux2
cutout` port and the Python `run.py image cutout` reference (Task 5 of
docs/superpowers/plans/2026-07-31-cutout-swift-native-port.md).

NOT a bit-exact numeric-parity gate: two independent SAM3-consuming
compositing paths can diverge slightly at mask edges even when both use the
same underlying SAM3 model/bridge. This checks both outputs are real
transparent cutouts (opaque subject core, transparent background corners)
and LOGS (does not gate on) their pixel cosine similarity as a diagnostic
for a human to judge convergence quality.

Run from repo root (requires a built flux2 Swift binary and a working
python/venv):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_cutout_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[4]
SUBJECT = "red balloon"
THRESHOLD = 0.3


def synth_source(path: Path) -> None:
    """Same deterministic fixture as image-cutout.py's own --self-test
    _synth_source: a sky gradient with a red circle ('balloon') — easy for
    SAM3 to segment, so the comparison isn't gated by segmentation quality."""
    w, h = 640, 480
    grad = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        t = y / max(1, h - 1)
        grad[y, :, 0] = int(135 * (1 - t) + 200 * t)
        grad[y, :, 1] = int(206 * (1 - t) + 230 * t)
        grad[y, :, 2] = int(235 * (1 - t) + 255 * t)
    src = Image.fromarray(grad, mode="RGB")
    draw = ImageDraw.Draw(src)
    cx, cy, r = int(w * 0.5), int(h * 0.5), 90
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(220, 40, 40))
    src.save(path)


def load_rgba(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGBA")).astype(np.float64)


def analyze(path: Path, label: str) -> np.ndarray:
    arr = load_rgba(path)
    H, W = arr.shape[:2]
    corners = [arr[0, 0, 3], arr[0, W - 1, 3], arr[H - 1, 0, 3], arr[H - 1, W - 1, 3]]
    center_alpha = arr[H // 2, W // 2, 3]
    print(f"\n[{label}] {path}")
    print(f"  shape={arr.shape}  corner alphas={corners} (expect ~0)  "
          f"center alpha={center_alpha:.1f} (expect >200)")
    ok = max(corners) <= 30.0 and center_alpha >= 180.0
    print(f"  {'PASS' if ok else 'FAIL'}: transparent background + opaque subject core")
    if not ok:
        sys.exit(1)
    return arr


def find_single_png(dir_path: Path) -> Path:
    """run.py image cutout has no --output flag — it writes an
    auto-timestamped <base_name>_cutout_<ts>.png (no sidecars, --save-mask
    not passed) into the generation output dir. Point --gen-output-dir at
    an empty tmp dir per call so exactly one .png is ever present."""
    pngs = sorted(dir_path.glob("*.png"))
    if len(pngs) != 1:
        print(f"ERROR: expected exactly 1 .png in {dir_path}, found {len(pngs)}: {pngs}",
              file=sys.stderr)
        sys.exit(1)
    return pngs[0]


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        content_path = tmp_path / "src.png"
        python_out_dir = tmp_path / "python_cutout"
        python_out_dir.mkdir()
        swift_out = tmp_path / "swift.png"

        print("[compare_cutout_e2e] synthesizing a segmentable source image...")
        synth_source(content_path)

        print("[compare_cutout_e2e] running Swift flux2 cutout...")
        flux2_bin = REPO / "swift" / "flux2-image-director" / ".build" / "release" / "flux2"
        if not flux2_bin.exists():
            print(f"ERROR: {flux2_bin} not built — run: "
                  f"swift build -c release --package-path swift/flux2-image-director", file=sys.stderr)
            sys.exit(1)
        subprocess.run(
            [str(flux2_bin), "cutout", "--input", str(content_path),
             "--subject", SUBJECT, "--sam-threshold", str(THRESHOLD),
             "--output", str(swift_out)],
            check=True, cwd=REPO,
        )

        print("[compare_cutout_e2e] running run.py image cutout (Python reference)...")
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "cutout", "--input", str(content_path),
             "--subject", SUBJECT, "--sam-threshold", str(THRESHOLD),
             "--gen-output-dir", str(python_out_dir)],
            check=True, cwd=REPO,
        )
        python_out = find_single_png(python_out_dir)

        swift_arr = analyze(swift_out, "swift")
        python_arr = analyze(python_out, "python")

        if swift_arr.shape != python_arr.shape:
            # Diagnostic-only (see module docstring) — the pass/fail gate is
            # each analyze() call above, already satisfied independently.
            print(f"\n[compare_cutout_e2e] shape mismatch swift={swift_arr.shape} "
                  f"python={python_arr.shape} — skipping cosine similarity diagnostic")
        else:
            flat_s, flat_p = swift_arr.flatten(), python_arr.flatten()
            cos = float(np.dot(flat_s, flat_p) / (np.linalg.norm(flat_s) * np.linalg.norm(flat_p) + 1e-12))
            print(f"\n[compare_cutout_e2e] pixel cosine similarity (diagnostic, not gated): {cos:.4f}")

    print("\n✅ both outputs are real transparent cutouts")


if __name__ == "__main__":
    main()
