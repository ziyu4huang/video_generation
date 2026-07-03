"""Dump qwen_image_vae decode + encode references for Swift parity testing.

Uses the SAME app/krea2_vae.py functional decoder/encoder this project's
Python MLX pipeline runs, against the REAL qwen_image_vae weights (so it
exercises the actual conv3d->2d slicing + L2 RMS-norm path). The VAE is
functional (weight-dict-driven) so we reuse the real weights rather than a
tiny random net -- this directly verifies the i2i ENCODER path, which the
Swift port only validated empirically (VLM scoring) and never numerically.

Dumps small input + output safetensors (the 484MB VAE weights are NOT
copied -- the Swift test loads them from the staging dir). Run from repo root:

    ../video_generation__venv/bin/python swift/krea2-image-director/scripts/dump_vae_reference.py
"""
import json
import os
import sys

import mlx.core as mx
import numpy as np
from safetensors.numpy import save_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO_ROOT, "python/mlx-movie-director"))

from app.krea2_vae import decode, encode, load_vae_weights  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(SCRIPT_DIR, "..", "test_refs", "vae")
os.makedirs(OUT_DIR, exist_ok=True)

VAE_DIR = os.path.join(REPO_ROOT, "mlx-models/vae/qwen-image-vae")


def to_np(x):
    return np.array(x, copy=False)


def dump_decode():
    """decode: latent (1, Hl, Wl, 16) -> pixels (1, H, W, 3)."""
    mx.random.seed(7)
    latent = mx.random.normal((1, 8, 8, 16)) * 2.0      # realistic latent magnitude
    raw, _ = load_vae_weights(VAE_DIR)
    out = decode(latent, raw)
    mx.eval(out)
    save_file({"latent_in": to_np(latent), "pixels_out": to_np(out)},
              os.path.join(OUT_DIR, "decode.safetensors"))
    meta = {"input_shape": list(latent.shape), "output_shape": list(out.shape),
            "vae_dir": VAE_DIR, "note": "loads real qwen_image_vae weights from vae_dir"}
    with open(os.path.join(OUT_DIR, "decode.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("decode:", latent.shape, "->", out.shape,
          f"(pixel range [{to_np(out).min():.3f}, {to_np(out).max():.3f}])")


def dump_encode():
    """encode: image (1, H, W, 3) in [-1,1] -> latent (1, H/8, W/8, 16) [mean/mode]."""
    mx.random.seed(11)
    image = mx.random.uniform(-1.0, 1.0, (1, 64, 64, 3))
    raw, _ = load_vae_weights(VAE_DIR)
    out = encode(image, raw)
    mx.eval(out)
    save_file({"image_in": to_np(image), "latent_out": to_np(out)},
              os.path.join(OUT_DIR, "encode.safetensors"))
    meta = {"input_shape": list(image.shape), "output_shape": list(out.shape),
            "vae_dir": VAE_DIR}
    with open(os.path.join(OUT_DIR, "encode.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("encode:", image.shape, "->", out.shape,
          f"(latent range [{to_np(out).min():.3f}, {to_np(out).max():.3f}])")


if __name__ == "__main__":
    dump_decode()
    dump_encode()
    print("done ->", os.path.abspath(OUT_DIR))
