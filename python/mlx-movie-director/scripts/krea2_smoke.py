"""Standalone Krea 2 Turbo T2I smoke test — end-to-end image generation.

Pure-MLX DiT + text encoder; VAE decode via diffusers-torch stopgap (to be
replaced by an MLX VAE port for the Swift-parity path). Validates that the
ported components produce a coherent image.

Run (from repo root):
  python/venv.../python python/mlx-movie-director/scripts/krea2_smoke.py \
      --prompt "..." --width 1024 --height 1024 --seed 42
"""
import argparse, math, os, re, sys, time

# Resolve package dir via script location (scripts/ -> mlx-movie-director/ holds app/).
HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)  # .../python/mlx-movie-director (contains app/)
sys.path.insert(0, PKG)

import mlx.core as mx
import mlx.nn as nn
import numpy as np

from app.krea2_transformer import Krea2DiT, Krea2DiTConfig
from app.krea2_encoder import Krea2TextEncoder

WEIGHTS = "/Users/huangziyu/proj/video_generation__models/_staging_krea2/turbo.safetensors"
VAE_DIR = "/Users/huangziyu/proj/video_generation__models/_staging_krea2/vae"


def load_dit() -> Krea2DiT:
    cfg = Krea2DiTConfig()
    model = Krea2DiT(cfg)

    def to_mlx_key(k):
        return re.sub(r"^(tmlp|txtmlp|tproj)\.(\d+)\.", r"\1.layers.\2.", k)

    raw = mx.load(WEIGHTS)
    model.load_weights(list({to_mlx_key(k): v for k, v in raw.items()}.items()))
    GS = 64
    nn.quantize(model, class_predicate=lambda p, m: isinstance(m, nn.Linear)
                and m.weight.shape[1] % GS == 0 and {"group_size": GS, "bits": 8} or False)
    mx.eval(model.parameters())
    return model, cfg


def prepare(noise_latent, txtlen, patch, txtmask):
    """Patchify latent + build pos/mask. Mirrors krea sampling.prepare."""
    b, c, h, w = noise_latent.shape
    h_, w_ = h // patch, w // patch
    imgids = mx.zeros((h_ * w_, 3))
    imgids[:, 1] = mx.repeat(mx.arange(h_), w_)
    imgids[:, 2] = mx.tile(mx.arange(w_), (h_,))
    imgpos = mx.broadcast_to(imgids, (b, h_ * w_, 3))
    imgmask = mx.ones((b, h_ * w_), dtype=mx.bool_)
    # patchify: (b,c,h,w) -> (b, h_*w_, c*patch*patch)
    img = noise_latent.reshape(b, c, h_, patch, w_, patch)
    img = img.transpose(0, 2, 4, 1, 3, 5).reshape(b, h_ * w_, c * patch * patch)
    txtpos = mx.zeros((b, txtlen, 3))
    mask = mx.concatenate([txtmask, imgmask], axis=1)
    pos = mx.concatenate([txtpos, imgpos], axis=1)
    return img, pos, mask


def timesteps(seq_len, steps, mu=1.15, sigma=1.0):
    ts = mx.linspace(1.0, 0.0, steps + 1)
    ts = math.exp(mu) / (math.exp(mu) + (1.0 / ts - 1.0) ** sigma)
    return ts.tolist()


def decode_vae_mlx(latent_nchw, vae_weights, vcfg):
    """Pure-MLX VAE decode. latent_nchw: (1,16,H/8,W/8) numpy. Returns (3,H,W) in [-1,1]."""
    import numpy as np
    from app.krea2_vae import decode as vae_decode
    mean = np.array(vcfg["latents_mean"], dtype=np.float32).reshape(1, 1, 1, 16)
    std = np.array(vcfg["latents_std"], dtype=np.float32).reshape(1, 1, 1, 16)
    lat_nhwc = np.transpose(latent_nchw, (0, 2, 3, 1)) * std + mean
    out = vae_decode(mx.array(lat_nhwc), vae_weights)          # (1,H,W,3)
    out_np = np.array(out)
    return np.transpose(out_np[0], (2, 0, 1))                  # (3,H,W)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", default="a fox walking in the snow, cinematic, detailed")
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--mu", type=float, default=1.15)
    ap.add_argument("--out", default="/Users/huangziyu/proj/video_generation__models/_staging_krea2/krea2_smoke.png")
    args = ap.parse_args()

    patch = 2
    compression = 8
    align = compression * patch  # 16
    W = ((args.width + align - 1) // align) * align
    H = ((args.height + align - 1) // align) * align
    Hl, Wl = H // compression, W // compression
    print(f"[krea2] {args.width}x{args.height} -> aligned {W}x{H} (latent {Wl}x{Hl}), steps={args.steps} mu={args.mu} seed={args.seed}")

    print("[1/4] text encoder...", end=" ", flush=True); t0 = time.time()
    instr_dir = os.path.join(os.path.dirname(WEIGHTS), "qwen3-4b-instruct")
    te_dir = instr_dir if os.path.exists(instr_dir) else None
    enc = Krea2TextEncoder(text_encoder_dir=te_dir) if te_dir else Krea2TextEncoder()
    txt, txtmask = enc.encode([args.prompt])
    mx.eval(txt, txtmask)  # force materialization (real timing)
    txtmask_b = txtmask.astype(mx.bool_)
    print(f"{time.time()-t0:.1f}s  context={tuple(txt.shape)}")

    print("[2/4] DiT...", end=" ", flush=True); t0 = time.time()
    model, cfg = load_dit()
    print(f"{time.time()-t0:.1f}s")

    print("[3/4] denoise...", end=" ", flush=True); t0 = time.time()
    key = mx.random.key(args.seed)
    noise = mx.random.normal((1, 16, Hl, Wl), key=key, dtype=mx.float32)
    img, pos, mask = prepare(noise, txt.shape[1], patch, txtmask_b)
    ts = timesteps(img.shape[1], args.steps, mu=args.mu)
    for i, (tcurr, tprev) in enumerate(zip(ts[:-1], ts[1:])):
        t = mx.array([tcurr], dtype=mx.float32)
        v = model(img=img, context=txt, t=t, pos=pos, mask=mask)
        img = img + (tprev - tcurr) * v
        mx.eval(img)  # force materialization each step (real timing + bounded memory)
        print(f"{i+1}/{len(ts)-1}({time.time()-t0:.1f}s)", end=" ", flush=True)
    print()

    # unpatchify
    Ht, Wt = Hl // patch, Wl // patch
    lat = img.reshape(1, Ht, Wt, 16, patch, patch).transpose(0, 3, 1, 4, 2, 5)
    lat = lat.reshape(1, 16, Hl, Wl)
    lat_np = np.array(lat, copy=False)
    print(f"[4/4] VAE decode (MLX)...", end=" ", flush=True); t0 = time.time()
    from app.krea2_vae import load_vae_weights
    vae_weights, vcfg = load_vae_weights(VAE_DIR)
    pixels = decode_vae_mlx(lat_np, vae_weights, vcfg)  # (3,H,W) in [-1,1]
    print(f"{time.time()-t0:.1f}s")

    arr = ((pixels * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)
    arr = np.transpose(arr, (1, 2, 0))  # HWC
    from PIL import Image
    Image.fromarray(arr).save(args.out)
    print(f"[done] saved {args.out} ({arr.shape})")


if __name__ == "__main__":
    main()
