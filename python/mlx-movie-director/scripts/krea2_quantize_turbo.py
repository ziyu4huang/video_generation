"""Quantize the Krea 2 Turbo DiT to MLX 8-bit (group_size=64).

Only quantizes 2D `.weight` tensors whose last dim is divisible by 64 -- these
are exactly the Linear weights the Swift `lin()` primitive reads (wq/wk/wv/wo/
gate/mlp/first/last.linear/tmlp/tproj/txtmlp/txtfusion). Excluded by construction:
  - `blocks.N.mod.lin`, `last.modulation.lin` (raw params, no `.weight` suffix,
    used additively -- must stay bf16)
  - `*.scale` / `*.gamma` (1D norms)
  - `txtfusion.projector.weight` (last dim 12, not %64)
  - all `.bias` (1D)

Output: turbo-q8.safetensors (mlx-8bit-g64, ~13 GB). Swift `lin()` auto-detects
quantized weights via the `<key>.scales` companion key and calls quantizedMM.

Run from repo root:
    ../video_generation__venv/bin/python python/mlx-movie-director/scripts/krea2_quantize_turbo.py
"""
import os
import sys

import mlx.core as mx

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STAGING = os.path.join(REPO_ROOT, "..", "video_generation__models/_staging_krea2")
SRC = os.path.join(STAGING, "turbo.safetensors")
DST = os.path.join(STAGING, "turbo-q8.safetensors")

BITS, GROUP = 8, 64


def should_quantize(key, shape):
    if not key.endswith(".weight"):
        return False
    if len(shape) != 2:
        return False
    return shape[-1] % GROUP == 0


def main():
    print(f"[1/3] loading {SRC} (mmap)...")
    w = mx.load(SRC)
    n_total, n_quant = len(w), 0
    bytes_in = sum(v.size * v.itemsize for v in w.values())
    print(f"      {n_total} tensors, {bytes_in / 1e9:.2f} GB raw")

    out = {}
    qbytes = 0
    for i, (k, v) in enumerate(w.items()):
        if should_quantize(k, v.shape):
            wq, scales, biases = mx.quantize(v, group_size=GROUP, bits=BITS)
            out[k] = wq
            out[f"{k}.scales"] = scales
            out[f"{k}.biases"] = biases
            n_quant += 1
            qbytes += wq.size * wq.itemsize + scales.size * scales.itemsize
            if biases is not None:
                qbytes += biases.size * biases.itemsize
        else:
            out[k] = v
        if (i + 1) % 50 == 0:
            print(f"      {i+1}/{n_total}...")
    mx.eval(list(out.values()))
    print(f"[2/3] quantized {n_quant}/{n_total} tensors")

    print(f"[3/3] saving {DST}...")
    mx.save_safetensors(DST, out)
    final = os.path.getsize(DST) / 1e9
    print(f"done: {final:.2f} GB (was {bytes_in / 1e9:.2f} GB, {final / (bytes_in / 1e9) * 100:.0f}%)")


if __name__ == "__main__":
    main()
