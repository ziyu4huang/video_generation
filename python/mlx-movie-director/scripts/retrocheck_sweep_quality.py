#!/usr/bin/env python3
"""retrocheck_sweep_quality.py — retroactively run quality check on sweep cells that missed it.

Usage:
    python/venv/bin/python python/mlx-movie-director/scripts/retrocheck_sweep_quality.py \
        /path/to/sweep_dasiwa_params_YYYYMMDD_HHMMSS

Finds cells with mp4 but no quality_report.json, reads the prompt from the
t2i2v_manifest.json (at either the correct path or the legacy wrong path inside the repo),
and runs the full quality check (VLM + ASR + signal) for each missing cell.

Only run this after the main sweep has finished so the GPU is free for quality check VLM.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

# Allow importing from the mlx-movie-director package
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

# Legacy wrong-path sweep root (inside repo) that may have t2i2v_manifest.json
_WRONG_INNER_PREFIX = os.path.normpath(
    os.path.join(_ROOT, "..", "video_generation__output")
)


def _find_t2i2v_manifest(cell_t2i2v_dir: str, wrong_t2i2v_dir: str) -> dict:
    """Try to read t2i2v_manifest.json from either correct or wrong path."""
    for candidate in [
        os.path.join(cell_t2i2v_dir, "t2i2v_manifest.json"),
        os.path.join(wrong_t2i2v_dir, "t2i2v_manifest.json"),
    ]:
        if os.path.isfile(candidate):
            try:
                with open(candidate) as f:
                    return json.load(f)
            except (OSError, json.JSONDecodeError):
                pass
    return {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Retroactive quality check for sweep cells")
    parser.add_argument("sweep_root", help="Path to correct external sweep root dir")
    parser.add_argument("--dry-run", action="store_true", help="Print what would run, don't run")
    parser.add_argument("--cell", type=str, default=None, help="Only process this cell (e.g. s1_8_seed42)")
    args = parser.parse_args()

    sweep_root = os.path.abspath(args.sweep_root)
    if not os.path.isdir(sweep_root):
        print(f"ERROR: sweep_root not found: {sweep_root}", file=sys.stderr)
        sys.exit(1)

    # Derive the legacy wrong-path sweep root for t2i2v_manifest lookup
    sweep_name = os.path.basename(sweep_root)
    wrong_sweep_root = os.path.join(_WRONG_INNER_PREFIX, sweep_name)

    # Import quality stage (requires LM Studio for VLM, mlx_whisper for ASR)
    if not args.dry_run:
        import importlib
        import types
        _t2i2v = importlib.import_module("app.commands.video-t2i2v")
        _run_quality_stage = _t2i2v._run_quality_stage
        dummy_args = types.SimpleNamespace(
            quality_threshold=5.5,
            vlm_api_url=None,
        )

    cells = sorted(os.listdir(sweep_root))
    if args.cell:
        cells = [c for c in cells if c == args.cell]
    if not cells:
        print("No cells found.")
        sys.exit(0)

    done = 0
    skipped = 0
    for cell in cells:
        cell_dir = os.path.join(sweep_root, cell)
        if not os.path.isdir(cell_dir):
            continue

        # Find t2i2v_* subdirectory
        t2i2v_dirs = sorted(glob.glob(os.path.join(cell_dir, "t2i2v_*")))
        if not t2i2v_dirs:
            continue
        t2i2v_dir = t2i2v_dirs[-1]  # use latest if multiple

        # Check if quality_report.json already exists
        qr_path = os.path.join(t2i2v_dir, "quality_report.json")
        if os.path.isfile(qr_path):
            print(f"  ♻  {cell}: quality_report.json already exists — skipping")
            skipped += 1
            continue

        # Find mp4
        mp4s = sorted(glob.glob(os.path.join(t2i2v_dir, "*.mp4")))
        if not mp4s:
            print(f"  ⚠  {cell}: no mp4 found in {t2i2v_dir} — skipping")
            continue
        video_path = mp4s[-1]

        # Read prompt from t2i2v_manifest (correct or legacy wrong path)
        wrong_t2i2v_dir = os.path.join(wrong_sweep_root, cell, os.path.basename(t2i2v_dir))
        manifest = _find_t2i2v_manifest(t2i2v_dir, wrong_t2i2v_dir)
        prompt = manifest.get("stages", {}).get("i2v", {}).get("prompt", "")
        if not prompt:
            # Fallback: use known sweep FIXED_PROMPT
            prompt = (
                "Style: cinematic realism. Close-up of a young woman in a white floral dress "
                "with a simple pearl necklace, framed from the shoulders up against a softly "
                "blurred sunlit garden background. She smiles gently and says clearly, "
                "「你終於來了，我等你好久了。」"
                "Her voice is warm, unhurried, and naturally paced. "
                "Soft natural daylight from the left. No music."
            )

        print(f"\n>>> {cell}")
        print(f"    mp4: {os.path.relpath(video_path, sweep_root)}")
        print(f"    out: {t2i2v_dir}")
        if args.dry_run:
            print(f"    [dry-run] would run quality check")
            continue

        report = _run_quality_stage(dummy_args, video_path, prompt, t2i2v_dir)
        verdict = report.get("verdict", "?")
        print(f"    → {verdict}")
        done += 1

    print(f"\nDone: {done} scored, {skipped} already had reports")


if __name__ == "__main__":
    main()
