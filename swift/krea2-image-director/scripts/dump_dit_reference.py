"""Dump Krea 2 DiT references for Swift parity testing.

Uses app/krea2_transformer.Krea2DiT at a SMALL config (features=128, 1 layer)
with random weights -- this verifies the block MATH (SingleStreamBlock +
TextFusionTransformer + timestep + last layer) matches the Swift port, not the
real 12B weights. The GELU discrepancy (python was `precise`/erf, torch ref +
Swift use tanh-approx) is fixed in app/krea2_transformer.py before this dump.

Dumps: (a) full DiT forward, (b) TextFusionTransformer in isolation (the
Krea-specific component with no Flux/Z-Image analogue). Run from repo root:

    ../video_generation__venv/bin/python swift/krea2-image-director/scripts/dump_dit_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import mlx.nn as nn
import mlx.utils
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO_ROOT, "python/mlx-movie-director"))

from app.krea2_transformer import Krea2DiT, Krea2DiTConfig, TextFusionTransformer  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(SCRIPT_DIR, "..", "test_refs", "dit")
os.makedirs(OUT_DIR, exist_ok=True)


def to_np(x):
    return np.array(x, copy=False)


def flat_weights(module):
    """tree_flatten with mlx.nn.Sequential keys remapped to torch convention.

    mlx.nn.Sequential produces 'tmlp.layers.0.weight' but the real turbo
    checkpoint (and the Swift port) use torch-style 'tmlp.0.weight'.
    """
    flat = mlx.utils.tree_flatten(module.parameters())
    return [(k.replace(".layers.", "."), v) for k, v in flat]


def randomize(module, seed, scale=0.1):
    key = mx.random.key(seed)
    flat = mlx.utils.tree_flatten(module.parameters())
    new_flat = []
    for k, v in flat:
        key, sub = mx.random.split(key)
        new_flat.append((k, mx.random.normal(v.shape, key=sub) * scale))
    module.update(mlx.utils.tree_unflatten(new_flat))


# Small config — mirrors Swift Krea2Config(full init) parity test values.
CFG = Krea2DiTConfig(
    features=128, tdim=64, txtdim=64, heads=4, kvheads=2, multiplier=4,
    layers=1, patch=2, channels=4, theta=1e3, txtlayers=4, txtheads=4, txtkvheads=4,
)


def dump_full_dit():
    mx.random.seed(101)
    dit = Krea2DiT(CFG)
    randomize(dit, 101)

    B, Ltext, Nimg = 1, 5, 4
    img = mx.random.normal((B, Nimg, CFG.patch * CFG.patch * CFG.channels), key=mx.random.key(31))
    context = mx.random.normal((B, Ltext, CFG.txtlayers, CFG.txtdim), key=mx.random.key(32))
    t = mx.array([0.7])
    # pos: text at origin, image at (0, h, w)
    pos_img = []
    for r in range(2):
        for c in range(2):
            pos_img.append([0, r, c])
    pos = mx.concatenate(
        [mx.zeros((B, Ltext, 3)), mx.array(pos_img)[None].astype(mx.float32)], axis=1
    ).astype(mx.float32)
    mask = mx.ones((B, Ltext + Nimg), dtype=mx.bool_)

    out = dit(img, context, t, pos, mask)
    mx.eval(out)

    # Capture intermediates by replaying the forward inline (diagnostic: lets
    # the Swift test pin down which stage diverges).
    from app.krea2_transformer import temb
    cfg = dit.config
    ximg = dit.first(img)
    t_h = dit.tmlp(temb(t, cfg.tdim).reshape(t.shape[0], -1))
    tvec = dit.tproj(t_h)
    txtlen = context.shape[1]
    tm = mask[:, :txtlen]
    txtmask = tm[:, None, :, None] & tm[:, None, None, :]   # bool (True=attend)
    fused = dit.txtfusion(context, mask=txtmask)
    ctx = dit.txtmlp(fused)
    combined0 = mx.concatenate([ctx, ximg], axis=1)
    mx.eval(ximg, t_h, tvec, fused, ctx, combined0)

    weights_out = {k: to_np(v) for k, v in flat_weights(dit)}
    weights_out["img_in"] = to_np(img)
    weights_out["context_in"] = to_np(context)
    weights_out["t_in"] = to_np(t)
    weights_out["pos_in"] = to_np(pos)
    weights_out["mask_in"] = to_np(mask)
    weights_out["out"] = to_np(out)
    # intermediates:
    weights_out["diag_tH"] = to_np(t_h)
    weights_out["diag_tvec"] = to_np(tvec)
    weights_out["diag_fused"] = to_np(fused)
    weights_out["diag_ctx"] = to_np(ctx)
    weights_out["diag_combined0"] = to_np(combined0)
    save_file(weights_out, os.path.join(OUT_DIR, "full_dit.safetensors"))
    meta = {"config": CFG.__dict__, "weight_keys": [k for k, _ in flat_weights(dit)],
            "out_shape": list(out.shape)}
    with open(os.path.join(OUT_DIR, "full_dit.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("full_dit: img", img.shape, "ctx", context.shape, "->", out.shape,
          f"({len(meta['weight_keys'])} tensors)")


def dump_txtfusion():
    mx.random.seed(202)
    tf = TextFusionTransformer(CFG.txtlayers, CFG.txtdim, CFG.txtheads,
                               CFG.multiplier, False, CFG.txtkvheads)
    randomize(tf, 202)
    B, L, n, d = 1, 5, CFG.txtlayers, CFG.txtdim
    x = mx.random.normal((B, L, n, d), key=mx.random.key(41))
    mask_bool = mx.array([[True, True, True, False, False]])
    tm = mx.where(mask_bool[:, None, :, None] & mask_bool[:, None, None, :], 0.0, -1e4).astype(mx.float32)
    out = tf(x, mask=tm)
    mx.eval(out)

    # Prefix with `txtfusion.` so keys match what Krea2DiT.txtFusion() reads
    # (the standalone module flattens to `layerwise_blocks.*` without the prefix).
    weights_out = {f"txtfusion.{k}": to_np(v) for k, v in flat_weights(tf)}
    weights_out["x_in"] = to_np(x)
    weights_out["mask_in"] = to_np(tm)
    weights_out["out"] = to_np(out)
    save_file(weights_out, os.path.join(OUT_DIR, "txtfusion.safetensors"))
    print("txtfusion: x", x.shape, "->", out.shape)


def dump_gelu():
    """Isolated GELU(tanh) check — the prime suspect for any DiT diff.
    Python nn.GELU(approx='tanh') vs Swift MLXNN.geluApproximate."""
    mx.random.seed(303)
    x = mx.random.normal((4, 8), key=mx.random.key(51)) * 3.0
    y = nn.GELU(approx="tanh")(x)
    mx.eval(y)
    save_file({"x_in": to_np(x), "out": to_np(y)}, os.path.join(OUT_DIR, "gelu.safetensors"))
    print("gelu:", x.shape, "->", y.shape, "(tanh approx)")


if __name__ == "__main__":
    dump_full_dit()
    dump_txtfusion()
    dump_gelu()
    print("done ->", os.path.abspath(OUT_DIR))
