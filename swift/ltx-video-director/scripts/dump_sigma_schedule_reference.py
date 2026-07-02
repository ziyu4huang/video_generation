"""Dump sigma schedule references for Swift parity testing.

Uses the SAME ltx_pipelines_mlx.scheduler (DISTILLED_SIGMAS/STAGE_2_SIGMAS/
ltx2_schedule) and mlx_arsenal.diffusion.dynamic_shift_schedule this
project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_sigma_schedule_reference.py
"""
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-pipelines-mlx/src"))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_pipelines_mlx.scheduler import DISTILLED_SIGMAS, STAGE_2_SIGMAS, ltx2_schedule  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "sigma_schedule")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    cases = {
        "distilled_sigmas": DISTILLED_SIGMAS,
        "stage_2_sigmas": STAGE_2_SIGMAS,
        # Real usage shapes: 8-step dev/HQ schedule at a realistic token count
        # (e.g. 241 frames @ small latent spatial dims -> a few thousand tokens),
        # and a small case for a quick sanity check.
        "ltx2_8step_4096tok": ltx2_schedule(8, num_tokens=4096),
        "ltx2_20step_1024tok": ltx2_schedule(20, num_tokens=1024),
        "ltx2_3step_2000tok_nostretch": ltx2_schedule(3, num_tokens=2000, stretch=False),
    }
    for name, sigmas in cases.items():
        print(name, sigmas)
    with open(os.path.join(OUT_DIR, "schedules.json"), "w") as f:
        json.dump(cases, f, indent=2)
    print("done ->", OUT_DIR)
