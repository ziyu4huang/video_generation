"""Definitive test with REAL text-encoder features: does the Lens UNet denoise?

Loads the 13GB GPT-OSS-20B TE, encodes a real prompt, then runs the UNet at
sigma=1.0 (full noise) and measures corr(v, noise). A working model predicts
v ~= noise - x0, so corr(v, noise) should be >0.5.
Also runs 5 Euler steps to check whether z denoises (std should fall).
"""
from __future__ import annotations
import os, sys, time
import mlx.core as mx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)) + "/..", "vendor", "mflux", "src"))

from app.lens_model import LensTransformer, _lens_position_ids
from app.lens_pipeline import _patchify, _depatchify

UNET = "models/lens-unet-int4/model.safetensors"
PROMPT = "a cute corgi puppy sitting in a sunny garden, highly detailed"

def _norm(x): return mx.sqrt(mx.sum(x.astype(mx.float32) ** 2) + 1e-30)
def _corr(a, b):
    a = a.reshape(-1).astype(mx.float32); b = b.reshape(-1).astype(mx.float32)
    a = a - a.mean(); b = b - b.mean()
    return float(mx.sum(a * b) / (_norm(a) * _norm(b) + 1e-12))

def unet_forward(model, latents, context, mask, t_val):
    """Call the model directly (now returns patchified [B,128,h,w])."""
    timestep = mx.array([t_val], dtype=latents.dtype)
    return model(latents, timestep, context, mask)  # [B, 128, H, W] patchified

def main():
    from app.lens_text_encoder import LensGptOssEncoder
    from app.lens_pipeline import LensPipeline, _render_chat
    from tokenizers import Tokenizer

    # --- load TE + encode ---
    t0 = time.time()
    te = LensGptOssEncoder.from_pretrained("models/text_encoder/gpt-oss-20b/model.safetensors")
    tok = Tokenizer.from_file("models/text_encoder/gpt-oss-20b/tokenizer.json")
    print(f"[diag] TE loaded in {time.time()-t0:.1f}s")

    ids = tok.encode(_render_chat(PROMPT), add_special_tokens=False).ids[:512]
    seq = max(len(ids), 1)
    id_arr = mx.array([ids + [199999]*(seq-len(ids))][:1])
    mask = mx.array([[1]*len(ids) + [0]*(seq-len(ids))], dtype=mx.bool_)
    features, tmask = te.encode(id_arr, mask)
    mx.eval(features, tmask)
    print(f"[diag] features {features.shape}  std={float(mx.std(features.astype(mx.float32))):.4f}  "
          f"absmax={float(mx.max(mx.abs(features.astype(mx.float32)))):.2f}")

    # --- load UNet ---
    model = LensTransformer.from_pretrained(UNET)

    H = W = 16
    mx.random.seed(7)
    z = mx.random.normal((1, 32, H*2, W*2)).astype(mx.bfloat16)
    latents = _patchify(z)
    mx.eval(z, latents)

    # --- single forward at sigma=1 (t=1000) ---
    v = unet_forward(model, latents, features, tmask, 1000.0)   # [B,128,H,W] patchified
    mx.eval(v)
    c_pack = _corr(v, latents)             # patchified-space corr (model native)
    v_dep = _depatchify(v)                 # -> [B,32,H*2,W*2]
    mx.eval(v_dep)
    c_dep = _corr(v_dep, z)               # depatchified corr (what VAE sees path)
    print(f"\n[diag] sigma=1.0 (t=1000):")
    print(f"  v_pack std={float(mx.std(v.astype(mx.float32))):.4f}")
    print(f"  corr(v_patch, latents_patch) = {c_pack:+.4f}   (model native space)")
    print(f"  corr(v_depatch, z)           = {c_dep:+.4f}   (>0.5 = denoising)")

    # --- 5 Euler steps in PATCHIFIED space: does z denoise? ---
    print("\n[diag] 5-step Euler in patchified space (shift=1.829):")
    sigmas = mx.linspace(1.0, 0.0, 6)[:-1]
    sigmas_shifted = 1.829 * sigmas / (1.0 + 0.829 * sigmas)
    sig_next = mx.concatenate([sigmas_shifted[1:], mx.array([0.0])])
    cur = latents
    for i, (s, sn) in enumerate(zip(sigmas_shifted.tolist(), sig_next.tolist())):
        vv = unet_forward(model, cur, features, tmask, s * 1000.0)
        mx.eval(vv)
        cur = cur + vv * (sn - s)          # euler in patchified space
        mx.eval(cur)
        zn = _depatchify(cur)
        print(f"  step {i+1}: sigma={s:.3f}->{sn:.3f}  v_std={float(mx.std(vv.astype(mx.float32))):.3f}  "
              f"z_std={float(mx.std(zn.astype(mx.float32))):.4f}")

if __name__ == "__main__":
    main()
