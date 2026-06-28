#!/usr/bin/env python3
"""benchmark_swift_vs_python.py — head-to-head: Swift zimage t2i vs Python run.py.

Same prompt/seed/steps/dims for both. Measures wall-clock, peak RSS, output size,
and (optionally) VLM quality score. Emits a JSON report + markdown summary table.

Usage:
    python/venv/bin/python swift/z-image-director/scripts/benchmark_swift_vs_python.py \
        --steps 4 9 --dims 640x960 832x1216 [--quality] [--runs 1]

Requires: the Swift binary built (`swift build` in swift/z-image-director),
the mlx.metallib copied to .build/debug/, and run.py's venv.
"""
# pyright: reportMissingImports=false, reportMissingModuleSource=false

from __future__ import annotations

import argparse
import json
import resource
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Resolve repo root: script → scripts → z-image-director → swift → repo
SCRIPT = Path(__file__).resolve()
REPO = SCRIPT.parents[3]
SWIFT_DIR = REPO / "swift" / "z-image-director"
SWIFT_BIN = SWIFT_DIR / ".build" / "debug" / "zimage"
PYTHON = REPO / "python" / "venv" / "bin" / "python"
RUN_PY = REPO / "python" / "mlx-movie-director" / "run.py"
OUT_DIR = REPO.parent / "video_generation__bench"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def peak_rss_mb() -> float:
    """Peak RSS of child processes (macOS bytes, Linux KB).

    NOTE: RUSAGE_CHILDREN accumulates across all waited children — only the
    FIRST measurement after a subprocess run is accurate. Prefer the
    `/usr/bin/time`-based measurement in run_swift/run_python for accuracy.
    """
    ru = resource.getrusage(resource.RUSAGE_CHILDREN)
    if sys.platform == "darwin":
        return ru.ru_maxrss / (1024 * 1024)
    return ru.ru_maxrss / 1024


def _parse_timemaxrss(stderr: str) -> float:
    """Extract peak RSS (MB) from `/usr/bin/time -l/-v` output."""
    for line in stderr.splitlines():
        low = line.strip().lower()
        # macOS `-l`: "maximum resident set size" in bytes.
        if "maximum resident set size" in low:
            parts = low.split()
            for tok in parts:
                if tok.isdigit():
                    return int(tok) / (1024 * 1024)
        # Linux `-v`: "Maximum resident set size (kbytes): 12345"
        if "maximum resident set size (kbytes)" in low:
            parts = low.split(":")
            if len(parts) == 2 and parts[1].strip().isdigit():
                return int(parts[1].strip()) / 1024
    return 0.0


def _wrap_with_time(cmd: list[str]) -> list[str]:
    """Wrap cmd with /usr/bin/time for peak-RSS capture."""
    flag = "-l" if sys.platform == "darwin" else "-v"
    return ["/usr/bin/time", flag] + cmd


def run_swift(
    prompt: str, seed: int, steps: int, width: int, height: int, out_png: Path
) -> dict:
    """Run the Swift binary and capture timing/memory/output."""
    cmd = _wrap_with_time(
        [
            str(SWIFT_BIN),
            "t2i",
            "--prompt",
            prompt,
            "--seed",
            str(seed),
            "--steps",
            str(steps),
            "--width",
            str(width),
            "--height",
            str(height),
            "--output",
            str(out_png),
        ]
    )
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
    elapsed = time.time() - t0
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr[-500:], "elapsed": elapsed}
    size = out_png.stat().st_size if out_png.exists() else 0
    rss = _parse_timemaxrss(proc.stderr)
    return {
        "ok": True,
        "elapsed": round(elapsed, 3),
        "peak_rss_mb": round(rss, 1) if rss > 0 else round(peak_rss_mb(), 1),
        "output_bytes": size,
        "output_path": str(out_png),
    }


def run_python(
    prompt: str, seed: int, steps: int, width: int, height: int, out_png: Path
) -> dict:
    """Run run.py and capture timing/memory/output."""
    out_dir = out_png.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = _wrap_with_time(
        [
            str(PYTHON),
            str(RUN_PY),
            "image",
            "t2i",
            "--prompt",
            prompt,
            "--seed",
            str(seed),
            "--steps",
            str(steps),
            "--width",
            str(width),
            "--height",
            str(height),
            "--output",
            str(out_png),
            "--no-quality",
        ]
    )
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
    elapsed = time.time() - t0
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr[-500:], "elapsed": elapsed}
    size = out_png.stat().st_size if out_png.exists() else 0
    rss = _parse_timemaxrss(proc.stderr)
    return {
        "ok": True,
        "elapsed": round(elapsed, 3),
        "peak_rss_mb": round(rss, 1) if rss > 0 else round(peak_rss_mb(), 1),
        "output_bytes": size,
        "output_path": str(out_png),
    }


def vlm_score(png_path: Path) -> int | None:
    """Score an image with run.py caption --style score (needs LM Studio up)."""
    cmd = [
        str(PYTHON),
        str(RUN_PY),
        "caption",
        str(png_path),
        "--style",
        "score",
        "--lang",
        "en",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
    if proc.returncode != 0:
        return None
    cap = Path(str(png_path) + ".caption.json")
    if not cap.exists():
        return None
    try:
        data = json.loads(cap.read_text())
        return int(data.get("overall", 0))
    except (json.JSONDecodeError, ValueError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--prompt", default="a portrait of a woman, studio lighting, detailed"
    )
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, nargs="+", default=[4, 9])
    ap.add_argument(
        "--dims",
        nargs="+",
        default=["640x960"],
        help="WxH resolutions, e.g. 640x960 832x1216",
    )
    ap.add_argument("--runs", type=int, default=1, help="Repeats per config (avg).")
    ap.add_argument(
        "--quality",
        action="store_true",
        help="Also VLM-score each output (needs LM Studio).",
    )
    ap.add_argument("--only", choices=["swift", "python"], help="Run only one side.")
    args = ap.parse_args()

    if not SWIFT_BIN.exists():
        sys.exit(f"Swift binary not found: {SWIFT_BIN}. Run `swift build` first.")
    if not PYTHON.exists():
        sys.exit(f"Python venv not found: {PYTHON}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results = []
    print(f"[bench] output dir: {OUT_DIR}")

    for dim in args.dims:
        w_str, h_str = dim.lower().split("x")
        width, height = int(w_str), int(h_str)
        for steps in args.steps:
            for run_idx in range(args.runs):
                tag = f"{dim}_{steps}step_run{run_idx}"
                row = {
                    "dim": dim,
                    "width": width,
                    "height": height,
                    "steps": steps,
                    "run": run_idx,
                    "seed": args.seed,
                }
                if args.only != "python":
                    swift_png = OUT_DIR / f"swift_{tag}.png"
                    print(f"\n[swift] {dim} {steps}step run{run_idx}...")
                    row["swift"] = run_swift(
                        args.prompt, args.seed, steps, width, height, swift_png
                    )
                if args.only != "swift":
                    py_png = OUT_DIR / f"python_{tag}.png"
                    print(f"[python] {dim} {steps}step run{run_idx}...")
                    row["python"] = run_python(
                        args.prompt, args.seed, steps, width, height, py_png
                    )
                if args.quality:
                    if "swift" in row and row["swift"].get("ok"):
                        row["swift"]["vlm_overall"] = vlm_score(
                            Path(row["swift"]["output_path"])
                        )
                    if "python" in row and row["python"].get("ok"):
                        row["python"]["vlm_overall"] = vlm_score(
                            Path(row["python"]["output_path"])
                        )
                results.append(row)
                print(
                    f"  swift : {row.get('swift', {}).get('elapsed', '-')}s "
                    f"{row.get('swift', {}).get('peak_rss_mb', '-')}MB "
                    f"{row.get('swift', {}).get('output_bytes', '-')}B"
                )
                print(
                    f"  python: {row.get('python', {}).get('elapsed', '-')}s "
                    f"{row.get('python', {}).get('peak_rss_mb', '-')}MB "
                    f"{row.get('python', {}).get('output_bytes', '-')}B"
                )

    report = {
        "generated_at": now_iso(),
        "prompt": args.prompt,
        "seed": args.seed,
        "runs": args.runs,
        "results": results,
    }
    report_path = OUT_DIR / f"benchmark_{stamp}.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(f"\n[bench] report: {report_path}")

    # Markdown summary
    md = [
        "# Swift vs Python t2i benchmark",
        "",
        f"- prompt: `{args.prompt}`",
        f"- seed: {args.seed}",
        f"- generated: {now_iso()}",
        "",
    ]
    md.append(
        "| dim | steps | | swift time | swift RSS | swift KB | "
        "py time | py RSS | py KB | speedup |"
    )
    md.append(
        "|-----|-------|---|-----------|-----------|----------|"
        "---------|--------|--------|---------|"
    )
    for r in results:
        s, p = r.get("swift", {}), r.get("python", {})
        s_ok = s.get("ok", False)
        p_ok = p.get("ok", False)
        s_time = f"{s['elapsed']:.1f}s" if s_ok else "FAIL"
        p_time = f"{p['elapsed']:.1f}s" if p_ok else "FAIL"
        s_rss = f"{s['peak_rss_mb']:.0f}" if s_ok else "-"
        p_rss = f"{p['peak_rss_mb']:.0f}" if p_ok else "-"
        s_kb = f"{s['output_bytes'] // 1024}" if s_ok else "-"
        p_kb = f"{p['output_bytes'] // 1024}" if p_ok else "-"
        speedup = (
            f"{p['elapsed'] / s['elapsed']:.2f}x"
            if s_ok and p_ok and s["elapsed"] > 0
            else "-"
        )
        md.append(
            f"| {r['dim']} | {r['steps']} | | {s_time} | {s_rss} | {s_kb} | "
            f"{p_time} | {p_rss} | {p_kb} | {speedup} |"
        )
    if args.quality:
        md.append("")
        md.append("| dim | steps | swift vlm | py vlm |")
        md.append("|-----|-------|-----------|--------|")
        for r in results:
            s, p = r.get("swift", {}), r.get("python", {})
            md.append(
                f"| {r['dim']} | {r['steps']} | "
                f"{s.get('vlm_overall', '-')} | {p.get('vlm_overall', '-')} |"
            )
    md_path = OUT_DIR / f"benchmark_{stamp}.md"
    md_path.write_text("\n".join(md))
    print(f"[bench] summary: {md_path}")
    print("\n" + "\n".join(md))


if __name__ == "__main__":
    main()
