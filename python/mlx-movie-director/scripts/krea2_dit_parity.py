"""DiT parity test: MLX Krea2DiT vs torch reference (krea-ai/krea-2/mmdit.py).

Isolates DiT port correctness from text-encoder/quantization. Builds a fixed
tiny input, runs BOTH forwards in bf16 (no quantization), compares. Run as 3
separate processes (mlx / torch / compare) to avoid MLX+torch Metal contention.

  python ...parity.py mlx
  python ...parity.py torch
  python ...parity.py compare
"""
import argparse, os, sys, re
HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
STAGE = "/Users/huangziyu/proj/video_generation__models/_staging_krea2"
WEIGHTS = os.path.join(STAGE, "turbo.safetensors")
DUMP = os.path.join(STAGE, "parity_dit")

# Tiny fixed input: 16 img tokens (latent 8x8, patch2 -> 4x4=16) + 64 text = 80 -> pad 256
B, NIMG, LTXT, PATCH = 1, 16, 64, 2
SEED = 7


def build_inputs_mlx():
    import mlx.core as mx
    mx.random.seed(SEED)
    cfg_features, txtlayers, txtdim = 6144, 12, 2560
    img = mx.random.normal((B, NIMG, 16 * PATCH * PATCH), dtype=mx.bfloat16) * 0.5
    context = mx.random.normal((B, LTXT, txtlayers, txtdim), dtype=mx.bfloat16) * 0.1
    t = mx.array([0.42], dtype=mx.bfloat16)
    # pos: text (64) at origin; img (16) at (0, h, w) for 4x4 grid
    idx = mx.arange(NIMG)
    imgpos = mx.stack([mx.zeros((NIMG,)), (idx // 4).astype(mx.float32), (idx % 4).astype(mx.float32)], axis=-1)[None]
    pos = mx.concatenate([mx.zeros((B, LTXT, 3)), imgpos], axis=1).astype(mx.bfloat16)
    mask = mx.ones((B, LTXT + NIMG), dtype=mx.bool_)
    # save as npy (cast to float32 — numpy can't buffer mlx bf16 directly)
    import numpy as np
    os.makedirs(DUMP, exist_ok=True)
    np.save(os.path.join(DUMP, "img.npy"), np.array(img.astype(mx.float32)))
    np.save(os.path.join(DUMP, "context.npy"), np.array(context.astype(mx.float32)))
    np.save(os.path.join(DUMP, "t.npy"), np.array(t.astype(mx.float32)))
    np.save(os.path.join(DUMP, "pos.npy"), np.array(pos.astype(mx.float32)))
    np.save(os.path.join(DUMP, "mask.npy"), np.array(mask))
    print("dumped inputs to", DUMP)
    return img, context, t, pos, mask


def run_mlx():
    import mlx.core as mx, mlx.nn as nn
    from app.krea2_transformer import Krea2DiT, Krea2DiTConfig
    img, context, t, pos, mask = build_inputs_mlx()
    model = Krea2DiT(Krea2DiTConfig())
    def to(k): return re.sub(r"^(tmlp|txtmlp|tproj)\.(\d+)\.", r"\1.layers.\2.", k)
    model.load_weights(list({to(k): v for k, v in mx.load(WEIGHTS).items()}.items()))
    # NO quantization — bf16 to match torch
    out = model(img.astype(mx.bfloat16), context.astype(mx.bfloat16), t, pos, mask)
    out32 = out.astype(mx.float32)
    mx.eval(out32)
    import numpy as np
    np.save(os.path.join(DUMP, "out_mlx.npy"), np.array(out32))
    print(f"MLX DiT out: {out32.shape} mean={float(out32.mean()):.4f} std={float(out32.std()):.4f}")


def run_torch():
    import numpy as np, torch
    sys.path.insert(0, STAGE)
    from mmdit_torch import SingleStreamDiT, SingleMMDiTConfig
    cfg = SingleMMDiTConfig(features=6144, tdim=256, txtdim=2560, heads=48, kvheads=12,
                            multiplier=4, layers=28, patch=2, channels=16,
                            txtlayers=12, txtheads=20, txtkvheads=20)
    with torch.device("meta"):
        model = SingleStreamDiT(cfg)
    # debug: check txtfusion shapes
    # (meta init can produce [0,...] if a derived shape underflows; fall back to real init)
    try:
        from safetensors.torch import load_file
        model.load_state_dict(load_file(WEIGHTS), strict=True, assign=True)
    except Exception:
        model = SingleStreamDiT(cfg)  # real init on CPU
        from safetensors.torch import load_file
        model.load_state_dict(load_file(WEIGHTS), strict=True, assign=True)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = model.to(device=dev, dtype=torch.bfloat16).eval()
    img = torch.from_numpy(np.load(os.path.join(DUMP, "img.npy"))).to(dev).bfloat16()
    context = torch.from_numpy(np.load(os.path.join(DUMP, "context.npy"))).to(dev).bfloat16()
    t = torch.from_numpy(np.load(os.path.join(DUMP, "t.npy"))).to(dev).bfloat16()
    pos = torch.from_numpy(np.load(os.path.join(DUMP, "pos.npy"))).to(dev).bfloat16()
    mask = torch.from_numpy(np.load(os.path.join(DUMP, "mask.npy"))).to(dev)
    with torch.no_grad():
        out = model(img=img, context=context, t=t, pos=pos, mask=mask)
    out32 = out.float().cpu().numpy()
    np.save(os.path.join(DUMP, "out_torch.npy"), out32)
    print(f"TORCH DiT out: {out32.shape} mean={out32.mean():.4f} std={out32.std():.4f}")


def compare():
    import numpy as np
    a = np.load(os.path.join(DUMP, "out_mlx.npy"))
    b = np.load(os.path.join(DUMP, "out_torch.npy"))
    diff = np.abs(a - b)
    print(f"MLX   shape={a.shape} mean={a.mean():.4f} std={a.std():.4f} range=[{a.min():.3f},{a.max():.3f}]")
    print(f"TORCH shape={b.shape} mean={b.mean():.4f} std={b.std():.4f} range=[{b.min():.3f},{b.max():.3f}]")
    print(f"PARITY max-abs-diff={diff.max():.4f}  mean={diff.mean():.5f}  p99={np.percentile(diff,99):.4f}")
    print("  rel error:", f"{(diff.mean()/np.abs(b).mean()*100):.2f}%")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "compare"
    {"mlx": run_mlx, "torch": run_torch, "compare": compare}[mode]()
