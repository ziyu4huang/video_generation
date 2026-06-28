#!/usr/bin/env python3
"""
compare_swift_vs_runpy.py — Swift T2I vs run.py T2I benchmark.

Runs BOTH pipelines on identical params (prompt, size, seed, steps) and reports:
  - runtime (wall clock, per-step)
  - peak memory (RSS via /usr/bin/time -l)
  - disk usage (output PNG size)
  - quality parity (pixel correlation, mean abs diff, match@5/@30)

The Swift binary and run.py use DIFFERENT RNG streams (MLXRandom vs numpy), so
the images are NOT bit-identical — they are structurally comparable. The
correlation number reflects "same prompt → similar image structure", not parity.
For true parity (same noise), use parity_bench.py instead.

Usage (from repo root):
  python/venv/bin/python swift/z-image-director/scripts/compare_swift_vs_runpy.py \\
      --prompt "a cinematic portrait of a woman" \\
      --width 640 --height 960 --steps 4 --seed 99

  # Use the built-in complex-girl preset:
  python/venv/bin/python swift/z-image-director/scripts/compare_swift_vs_runpy.py --preset complex-girl
"""
# pyright: reportMissingImports=false, reportMissingModuleSource=false

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SWIFT_BIN = REPO / "swift/z-image-director/.build/debug/zimage"
RUN_PY = REPO / "python/mlx-movie-director/run.py"
PY = REPO / "python/venv/bin/python"
OUT = REPO / "swift/z-image-director/.scratch/compare"
OUT.mkdir(parents=True, exist_ok=True)

PRESETS = {
    "portrait": {
        "prompt": (
            "photorealistic portrait of a young woman, sharp eyes with detailed "
            "irises, natural skin texture with fine pores, soft studio lighting, "
            "bokeh background, high detail, ultra sharp focus"
        ),
        "width": 640, "height": 960, "steps": 9, "seed": 99,
    },
    "complex-girl": {
        "prompt": (
            "a stunningly detailed portrait of a young woman with flowing auburn "
            "hair, intricate lace dress, freckles across her nose, green eyes "
            "catching golden hour sunlight, bokeh background of autumn forest, "
            "ultra realistic skin texture, professional cinematic photography, "
            "shallow depth of field, film grain"
        ),
        "width": 832, "height": 1216, "steps": 9, "seed": 77,
    },
}


def peak_rss_kb(child_cmd: list[str]) -> tuple[int, float]:
    """Run child under /usr/bin/time -l, return (peak_rss_kb, wall_seconds)."""
    # macOS /usr/bin/time -l prints max RSS in bytes to stderr on the
    # "maximum resident set size" line.
    t0 = time.time()
    proc = subprocess.run(
        ["/usr/bin/time", "-l"] + child_cmd,
        capture_output=True, text=True,
    )
    wall = time.time() - t0
    rss = 0
    for line in proc.stderr.splitlines():
        if "maximum resident set size" in line:
            # format: "1234567  maximum resident set size"
            rss = int(line.split()[0]) // 1024  # bytes -> KB
            break
    if proc.returncode != 0:
        print(f"[child failed rc={proc.returncode}]")
        print(proc.stderr[-800:])
    return rss, wall


def run_swift(params: dict) -> dict:
    out_png = OUT / "swift.png"
    cmd = [
        str(SWIFT_BIN), "t2i",
        "--prompt", params["prompt"],
        "--width", str(params["width"]),
        "--height", str(params["height"]),
        "--steps", str(params["steps"]),
        "--seed", str(params["seed"]),
        "--output", str(out_png),
    ]
    print(f"\n[Swift] {params['width']}x{params['height']} steps={params['steps']}")
    rss, wall = peak_rss_kb(cmd)
    size = out_png.stat().st_size if out_png.exists() else 0
    return {
        "engine": "swift",
        "wall_seconds": round(wall, 2),
        "per_step_seconds": round(wall / params["steps"], 2),
        "peak_rss_mb": round(rss / 1024, 1),
        "png_bytes": size,
        "png_path": str(out_png),
    }


def run_runpy(params: dict) -> dict:
    # run.py writes timestamped output_<TS>.png into --gen-output-dir.
    # Point it at our compare dir and pick the newest .png afterward.
    runpy_out_dir = OUT / "runpy"
    runpy_out_dir.mkdir(parents=True, exist_ok=True)
    # Clean stale PNGs so the newest one is unambiguous.
    for old in runpy_out_dir.glob("output_*.png"):
        old.unlink()
    cmd = [
        str(PY), str(RUN_PY), "image", "t2i",
        "--prompt", params["prompt"],
        "--width", str(params["width"]),
        "--height", str(params["height"]),
        "--steps", str(params["steps"]),
        "--seed", str(params["seed"]),
        "--gen-output-dir", str(runpy_out_dir),
        "--no-quality",  # skip VLM quality (we measure parity ourselves)
    ]
    print(f"\n[run.py] {params['width']}x{params['height']} steps={params['steps']}")
    rss, wall = peak_rss_kb(cmd)
    pngs = sorted(runpy_out_dir.glob("output_*.png"), key=lambda p: p.stat().st_mtime)
    out_png = pngs[-1] if pngs else None
    size = out_png.stat().st_size if out_png and out_png.exists() else 0
    return {
        "engine": "run.py",
        "wall_seconds": round(wall, 2),
        "per_step_seconds": round(wall / params["steps"], 2),
        "peak_rss_mb": round(rss / 1024, 1),
        "png_bytes": size,
        "png_path": str(out_png) if out_png else "",
    }


def compare_quality(swift_path: str, runpy_path: str) -> dict:
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        return {"note": "numpy/PIL unavailable — skipped quality comparison"}

    sw = np.asarray(Image.open(swift_path).convert("RGB"), dtype=np.float32)
    py = np.asarray(Image.open(runpy_path).convert("RGB"), dtype=np.float32)
    if sw.shape != py.shape:
        return {"note": f"shape mismatch {sw.shape} vs {py.shape}"}
    diff = np.abs(sw - py)
    corr = float(np.corrcoef(sw.flatten(), py.flatten())[0, 1])
    return {
        "correlation": round(corr, 5),
        "mean_abs_diff": round(float(diff.mean()), 3),
        "max_abs_diff": int(diff.max()),
        "match_at_5_pct": round(float((diff < 5).mean()) * 100, 1),
        "match_at_30_pct": round(float((diff < 30).mean()) * 100, 1),
        "note": "different RNG streams → structural comparison, not parity",
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Swift vs run.py T2I benchmark")
    ap.add_argument("--preset", choices=list(PRESETS), help="built-in param preset")
    ap.add_argument("--prompt", default="a cinematic portrait of a woman")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=960)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--seed", type=int, default=99)
    args = ap.parse_args()

    if args.preset:
        params = PRESETS[args.preset]
    else:
        params = dict(prompt=args.prompt, width=args.width,
                      height=args.height, steps=args.steps, seed=args.seed)

    print(f"=== Compare: {params['width']}x{params['height']} "
          f"steps={params['steps']} seed={params['seed']} ===")
    print(f"prompt: {params['prompt'][:80]}...")

    if not SWIFT_BIN.exists():
        sys.exit(f"Swift binary not found: {SWIFT_BIN} (run `swift build` first)")

    sw = run_swift(params)
    rp = run_runpy(params)
    qual = compare_quality(sw["png_path"], rp["png_path"])

    print("\n" + "=" * 64)
    print(f"{'metric':<22} {'Swift':>18} {'run.py':>18}")
    print("-" * 64)
    print(f"{'wall (s)':<22} {sw['wall_seconds']:>18} {rp['wall_seconds']:>18}")
    print(f"{'per-step (s)':<22} {sw['per_step_seconds']:>18} {rp['per_step_seconds']:>18}")
    print(f"{'peak RSS (MB)':<22} {sw['peak_rss_mb']:>18} {rp['peak_rss_mb']:>18}")
    print(f"{'PNG size (KB)':<22} {sw['png_bytes']//1024:>18} {rp['png_bytes']//1024:>18}")
    print("-" * 64)
    print(f"{'correlation':<22} {qual.get('correlation', '-'):>18}")
    print(f"{'mean abs diff':<22} {qual.get('mean_abs_diff', '-'):>18}")
    print(f"{'match@5 %':<22} {qual.get('match_at_5_pct', '-'):>18}")
    print("=" * 64)

    report = {"params": params, "swift": sw, "runpy": rp, "quality": qual}
    out_json = OUT / "compare_report.json"
    out_json.write_text(json.dumps(report, indent=2))
    print(f"\nreport: {out_json}")


if __name__ == "__main__":
    main()
