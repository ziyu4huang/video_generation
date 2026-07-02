"""Dump Modality.split references for Swift parity testing.

Uses the SAME ltx_core_mlx.model.transformer.modality.Modality dataclass
this project's Python MLX pipeline runs. Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_modality_reference.py
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

from ltx_core_mlx.model.transformer.modality import Modality  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "modality")
os.makedirs(OUT_DIR, exist_ok=True)

if __name__ == "__main__":
    # Batch of 6 = guidance batching (cond=2, neg=3, ptb=1), the real use case.
    B, T, D = 6, 4, 8
    key = mx.random.key(101)
    latent = mx.random.normal((B, T, D), key=mx.random.split(key)[1])
    sigma = mx.random.normal((B,), key=mx.random.split(key)[1])
    timesteps = mx.random.normal((B, T), key=mx.random.split(key)[1])
    positions = mx.random.normal((B, 3, T), key=mx.random.split(key)[1])
    context = mx.random.normal((B, 5, D), key=mx.random.split(key)[1])

    modality = Modality(latent=latent, sigma=sigma, timesteps=timesteps, positions=positions, context=context)
    sizes = [2, 3, 1]
    parts = modality.split(sizes)
    mx.eval([p.latent for p in parts])

    out = {
        "latent": np.array(latent, copy=False), "sigma": np.array(sigma, copy=False),
        "timesteps": np.array(timesteps, copy=False), "positions": np.array(positions, copy=False),
        "context": np.array(context, copy=False),
    }
    for i, p in enumerate(parts):
        out[f"part{i}_latent"] = np.array(p.latent, copy=False)
        out[f"part{i}_sigma"] = np.array(p.sigma, copy=False)
        out[f"part{i}_timesteps"] = np.array(p.timesteps, copy=False)
        out[f"part{i}_positions"] = np.array(p.positions, copy=False)
        out[f"part{i}_context"] = np.array(p.context, copy=False)
    save_file(out, os.path.join(OUT_DIR, "split.safetensors"))

    meta = {"B": B, "T": T, "D": D, "sizes": sizes}
    with open(os.path.join(OUT_DIR, "split.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("split into", [p.latent.shape for p in parts])
    print("done ->", OUT_DIR)
