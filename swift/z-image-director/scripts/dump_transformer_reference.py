#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportMissingModuleSource=false
"""
dump_transformer_reference.py — Phase 2 verification scaffold.

Runs the real Python ZImageTransformerMLX (moody-pro-mix) on FIXED synthetic
inputs and dumps every intermediate tensor to safetensors. The Swift port loads
these via MLX.loadArrays and compares its own forward outputs layer-by-layer.

Why synthetic inputs: the transformer is a pure function of (x, t, cap_feats,
positions, cos, sin). Seeding numpy makes inputs reproducible in Swift without
needing the text encoder (Phase 3 deferred).

Outputs (written to swift/z-image-director/.scratch/ref/):
  - ref_inputs.safetensors         all forward() inputs
  - ref_intermediates.safetensors  per-module outputs (embedders, each block, final)
  - ref_config.json                the config + quant params used

Run from repo root:
  python/venv/bin/python swift/z-image-director/scripts/dump_transformer_reference.py
"""

import json
import os
import sys

import mlx.core as mx
import mlx.nn as nn
import numpy as np

# Repo-root imports (run from repo root).
sys.path.insert(0, "python/mlx-movie-director")
from app.transformer import ZImageTransformerMLX  # noqa: E402
from app.pipeline import _detect_transformer_quant  # noqa: E402
from app.config import TRANSFORMER_DIR  # noqa: E402

VARIANT = os.environ.get("ZIMAGE_VARIANT", "moody-pro-mix")
OUT_DIR = os.path.join("swift", "z-image-director", ".scratch", "ref")
os.makedirs(OUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# 1. Load model (quantized + fused, exactly as the pipeline does)
# ---------------------------------------------------------------------------
trans_path = os.path.join(os.path.dirname(TRANSFORMER_DIR), VARIANT)
print(f"[load] {trans_path}")
with open(os.path.join(trans_path, "config.json")) as f:
    config = json.load(f)
quant_bits, quant_gs = _detect_transformer_quant(trans_path)
print(f"[load] quant={quant_bits}-bit gs={quant_gs}")

model = ZImageTransformerMLX(config)
nn.quantize(model, bits=quant_bits, group_size=quant_gs)
model.load_weights(os.path.join(trans_path, "model.safetensors"))
model.fuse_model()
model.eval()

# ---------------------------------------------------------------------------
# 2. Build FIXED synthetic inputs (small spatial size to keep dumps tiny)
#    H_tok=2, W_tok=2  ->  N_img = 2*2*4 = 16 image tokens
#    N_cap = 4 caption tokens
# ---------------------------------------------------------------------------
np.random.seed(1234)
H_tok, W_tok = 2, 2
C = config["in_channels"]  # 16
N_img = H_tok * W_tok * 4  # patchify factor 4 (2x2)
N_cap = 4
cap_feat_dim = config["cap_feat_dim"]  # 2560
dim = config["dim"]  # 3840

x = mx.array(np.random.randn(1, N_img, C * 4).astype(np.float32) * 0.1)  # (1, 16, 64)
t = mx.array(np.array([0.5], dtype=np.float32))
cap_feats = mx.array(np.random.randn(1, N_cap, cap_feat_dim).astype(np.float32) * 0.1)

# Positions: img_pos (N_img, 3), cap_pos (N_cap, 3)
img_pos = mx.array(np.random.randn(1, N_img, 3).astype(np.float32))
cap_pos = mx.array(np.random.randn(1, N_cap, 3).astype(np.float32))

unified_pos_all = mx.concatenate([img_pos, cap_pos], axis=1)
cos, sin = model.prepare_rope(unified_pos_all)

# ---------------------------------------------------------------------------
# 3. Dump inputs
# ---------------------------------------------------------------------------
mx.save_safetensors(
    os.path.join(OUT_DIR, "ref_inputs.safetensors"),
    {
        "x": x,
        "t": t,
        "cap_feats": cap_feats,
        "img_pos": img_pos.astype(mx.float32),
        "cap_pos": cap_pos.astype(mx.float32),
        "cos": cos.astype(mx.float32),
        "sin": sin.astype(mx.float32),
    },
)
print(f"[dump] inputs  -> {OUT_DIR}/ref_inputs.safetensors")

with open(os.path.join(OUT_DIR, "ref_config.json"), "w") as f:
    json.dump(
        {
            "config": config,
            "quant_bits": quant_bits,
            "quant_gs": quant_gs,
            "H_tok": H_tok,
            "W_tok": W_tok,
            "N_img": N_img,
            "N_cap": N_cap,
        },
        f,
        indent=2,
    )
print(f"[dump] config  -> {OUT_DIR}/ref_config.json")

# ---------------------------------------------------------------------------
# 4. Run module-by-module, dumping intermediates (float32 for cross-check)
# ---------------------------------------------------------------------------
inter = {}

temb = model.t_embedder(t * model.t_scale)
inter["temb"] = temb.astype(mx.float32)

x_emb = model.x_embedder(x)
inter["x_embedder"] = x_emb.astype(mx.float32)

cap_e = model.cap_embedder.layers[1](model.cap_embedder.layers[0](cap_feats))
inter["cap_embedder"] = cap_e.astype(mx.float32)

# Noise refiners (image tokens)
cur = x_emb
cos_img = cos[:, : cur.shape[1]]
sin_img = sin[:, : cur.shape[1]]
for i, blk in enumerate(model.noise_refiner):
    cur = blk(cur, None, img_pos, temb, cos=cos_img, sin=sin_img)
    cos_img = cos[:, : cur.shape[1]]
    sin_img = sin[:, : cur.shape[1]]
    inter[f"noise_refiner.{i}"] = cur.astype(mx.float32)
x_after_nr = cur

# Context refiners (caption tokens)
cur_c = cap_e
for i, blk in enumerate(model.context_refiner):
    cur_c = blk(
        cur_c,
        None,
        cap_pos,
        None,
        cos=cos[:, x_after_nr.shape[1] :],
        sin=sin[:, x_after_nr.shape[1] :],
    )
    inter[f"context_refiner.{i}"] = cur_c.astype(mx.float32)

# Concatenate + main layers
x_len = x_after_nr.shape[1]
unified = mx.concatenate([x_after_nr, cur_c], axis=1)
inter["unified_pre_layers"] = unified.astype(mx.float32)
for i, blk in enumerate(model.layers):
    unified = blk(unified, None, unified_pos_all, temb, cos=cos, sin=sin)
    inter[f"layers.{i}"] = unified.astype(mx.float32)

final = model.final_layer(unified[:, :x_len, :], temb)
inter["final_layer"] = final.astype(mx.float32)

# Also dump the full model output (no-ControlNet path) for an end-to-end check.
full = model(x, t, cap_feats, img_pos, cap_pos, cos, sin, cap_mask=None)
inter["full_output"] = full.astype(mx.float32)

mx.save_safetensors(os.path.join(OUT_DIR, "ref_intermediates.safetensors"), inter)
print(
    f"[dump] inter   -> {OUT_DIR}/ref_intermediates.safetensors  ({len(inter)} tensors)"
)
print("[done] reference dump complete")
