"""Dump EulerDiffusionStep references for Swift parity testing.

Uses the SAME ltx_core_mlx.components.diffusion_steps.EulerDiffusionStep
class this project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_euler_step_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_core_mlx.components.diffusion_steps import EulerDiffusionStep  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "euler_step")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    step = EulerDiffusionStep()
    sigmas = mx.array([1.0, 0.75, 0.5, 0.25, 0.0])  # 4-step schedule, typical distilled shape
    num_steps = len(sigmas) - 1

    sample = mx.random.normal((1, 4, 8), key=mx.random.key(201))
    initial_sample = sample

    out = {}
    for step_index in range(num_steps):
        denoised = mx.random.normal((1, 4, 8), key=mx.random.key(210 + step_index))
        out[f"denoised_for_step{step_index}"] = np.array(denoised, copy=False)
        result = step.step(sample, denoised, sigmas, step_index)
        mx.eval(result)
        out[f"output_step{step_index}"] = np.array(result, copy=False)
        sample = result  # chain: next step's input is this step's output

    out["sigmas"] = np.array(sigmas, copy=False)
    out["initial_sample"] = np.array(initial_sample, copy=False)
    save_file(out, os.path.join(OUT_DIR, "chain.safetensors"))

    meta = {"sigmas": sigmas.tolist(), "num_steps": num_steps, "shape": [1, 4, 8]}
    with open(os.path.join(OUT_DIR, "chain.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("sigmas", sigmas.tolist(), "num_steps", num_steps)
    print("done ->", OUT_DIR)
