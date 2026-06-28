#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportMissingModuleSource=false
"""
dump_cfg_latent.py — Phase 5 CFG reference.

Runs the Python Z-Image denoise loop WITH classifier-free guidance (cfg=4.0),
fixed numpy-seed-99 noise, and a pre-dumped embedding (cap_feats + uncond_feats),
dumping per-step + final latents. The Swift `zimage verify-t2i --cfg-scale 4.0`
command compares against these.

Run from repo root:
  python/venv/bin/python swift/z-image-director/scripts/dump_cfg_latent.py \
      --embedding swift/z-image-director/.scratch/emb/portrait_cfg.safetensors
"""

import argparse
import json
import sys

import mlx.core as mx
import mlx.nn as nn

sys.path.insert(0, "python/mlx-movie-director")
from app.transformer import ZImageTransformerMLX  # noqa: E402
from app.pipeline import (  # noqa: E402
    MLXFlowMatchEulerScheduler,
    _detect_transformer_quant,
    calculate_shift,
    create_coordinate_grid,
)
from app.config import TRANSFORMER_DIR  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embedding", required=True)
    ap.add_argument("--ref-dir", default="swift/z-image-director/.scratch/ref")
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--cfg-scale", type=float, default=4.0)
    args = ap.parse_args()

    with open(TRANSFORMER_DIR + "/config.json") as f:
        cfg = json.load(f)
    qb, qgs = _detect_transformer_quant(TRANSFORMER_DIR)
    model = ZImageTransformerMLX(cfg)
    nn.quantize(model, bits=qb, group_size=qgs)
    model.load_weights(TRANSFORMER_DIR + "/model.safetensors")
    model.fuse_model()
    model.eval()

    noise = mx.load("swift/z-image-director/.scratch/ref/ref_seed99_noise.safetensors")[
        "noise"
    ].astype(mx.bfloat16)
    emb = mx.load(args.embedding)
    cap_feats = emb["cap_feats"]
    uncond_feats = emb["uncond_feats"]

    _, C, Hl, Wl = noise.shape
    Htok, Wtok = Hl // 2, Wl // 2
    total = cap_feats.shape[1]

    mu = calculate_shift(Htok * Wtok)
    sched = MLXFlowMatchEulerScheduler(shift=3.0, use_dynamic_shifting=True)
    sched.set_timesteps(args.steps, mu=mu)

    img_pos = mx.array(
        create_coordinate_grid((1, Htok, Wtok), (total + 1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    cap_pos = mx.array(
        create_coordinate_grid((total, 1, 1), (1, 0, 0)).reshape(-1, 3)[None]
    ).astype(mx.bfloat16)
    upos = mx.concatenate([img_pos, cap_pos], axis=1)
    cos, sin = model.prepare_rope(upos)
    cos = cos.astype(mx.bfloat16)
    sin = sin.astype(mx.bfloat16)

    @mx.compile
    def step_fn(x, t, feats):
        B, C, H, W = x.shape
        xr = (
            x.reshape(C, 1, 1, Htok, 2, Wtok, 2)
            .transpose(1, 2, 3, 5, 4, 6, 0)
            .reshape(1, -1, C * 4)
        )
        out = model(xr, t, feats, img_pos, cap_pos, cos, sin, cap_mask=None)
        return (
            -out.reshape(1, 1, Htok, Wtok, 2, 2, C)
            .transpose(6, 0, 1, 2, 4, 3, 5)
            .reshape(1, C, H, W)
        )

    latents = noise
    for i in range(args.steps):
        t_input = (1.0 - sched.timesteps[i])[None].astype(mx.bfloat16)
        cond = step_fn(latents, t_input, cap_feats)
        uncond = step_fn(latents, t_input, uncond_feats)
        noise_pred = uncond + args.cfg_scale * (cond - uncond)
        latents = sched.step(noise_pred, i, latents)
        mx.eval(latents)
        if i < 3:
            mx.save_safetensors(
                f"{args.ref_dir}/ref_t2i_cfg_step{i + 1}.safetensors",
                {"latent": latents.astype(mx.float32)},
            )
            print(f"  step {i + 1}: mean {float(mx.mean(latents)):.4f}")

    mx.save_safetensors(
        f"{args.ref_dir}/ref_t2i_cfg_latent.safetensors",
        {"final_latent": latents.astype(mx.float32)},
    )
    print(
        f"  final: mean {float(mx.mean(latents)):.4f}, saved ref_t2i_cfg_latent + step1-3"
    )


if __name__ == "__main__":
    main()
