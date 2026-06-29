#!/usr/bin/env python3
"""Generate Flux2 VAE reference tensors for Swift port verification.

Loads the Flux2 Klein VAE via mflux, runs encode + decode on a fixed-seed
random image, and saves the input image, encoded latent, and decoded pixels
as safetensors. The Swift port loads these and compares (cos > 0.99).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_vae_ref.py
"""
import sys
from pathlib import Path

# Ensure vendor/mflux is importable
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))

import mlx.core as mx
from mlx import nn
from mflux.models.flux2.model.flux2_vae.vae import Flux2VAE

VAE_DIR = REPO / "python" / "mlx-movie-director" / "models" / "vae" / "flux2-klein"
OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 1. Load VAE: quantize first (creates QuantizedLinear slots for attention
#    to_q/k/v/out), then load saved quantized weights (U32 + scales/biases).
#    This mirrors mflux's WeightApplier flow for stored_q=8.
#    CRITICAL: weights must be tree_unflatten'd before update() — update()
#    takes a nested dict, NOT a flat {dotted.key: array} dict.
from mlx.utils import tree_unflatten

vae = Flux2VAE()
all_weights = {}
for shard in sorted(VAE_DIR.glob("*.safetensors")):
    if shard.name.startswith("._"):
        continue
    all_weights.update(mx.load(str(shard)))

# Quantize all nn.Linear modules (only the attention to_q/k/v/out are Linear;
# convs are nn.Conv2d and untouched). bits=8 matches stored quantization_level.
nn.quantize(vae, class_predicate=lambda path, module: hasattr(module, "to_quantized"), bits=8)
# Load saved weights: tree_unflatten converts flat {"a.b.c": v} → nested tree,
# then update() traverses it into the model. strict=False skips unknown keys.
weight_tree = tree_unflatten(list(all_weights.items()))
vae.update(weight_tree, strict=False)
mx.eval(vae.parameters())
print(f"Loaded {len(all_weights)} VAE weight tensors (8-bit quantized attention)")

# 2. Fixed-seed random image (1,3,256,256) in a typical VAE input range [-1,1]-ish
mx.random.seed(777)
img = mx.random.normal((1, 3, 256, 256)).astype(mx.bfloat16)
mx.eval(img)

# 3. Encode → latent (1,32,32,32)
latent = vae.encode(img)
mx.eval(latent)
print(f"Encoded latent shape: {latent.shape}, dtype: {latent.dtype}")

# 4. Decode the latent back → pixels (1,3,256,256)
decoded = vae.decode(latent)
mx.eval(decoded)
print(f"Decoded pixels shape: {decoded.shape}, dtype: {decoded.dtype}")

# 5b. Dump intermediates for Swift debugging: post_quant_conv + conv_in outputs.
#     Access mflux's internal layers directly.
_lat = (latent.astype(mx.float32) / 1.0) + 0.0   # (1,32,32,32) NCHW
_lat_nhwc = mx.transpose(_lat, (0, 2, 3, 1))      # (1,32,32,32) NHWC
_pqc = vae.post_quant_conv(_lat_nhwc)            # nn.Conv2d on NHWC
_pqc_nchw = mx.transpose(_pqc, (0, 3, 1, 2))
mx.eval(_pqc_nchw)
_conv_in = vae.decoder.conv_in(_pqc_nchw)       # Flux2ConvIn: NCHW in/out
mx.eval(_conv_in)
print(f"post_quant_conv out: {_pqc_nchw.shape}, conv_in out: {_conv_in.shape}")
#    This exercises the bn + unpatchify path (T2I generation path).
packed = mx.random.normal((1, 128, 16, 16)).astype(mx.bfloat16)
mx.eval(packed)
decoded_packed = vae.decode_packed_latents(packed)
mx.eval(decoded_packed)
print(f"Decoded packed shape: {decoded_packed.shape}, dtype: {decoded_packed.dtype}")

# 6. Save all as safetensors (cast to float32 for stable cross-language comparison)
ref = {
    "input_image": img.astype(mx.float32),
    "encoded_latent": latent.astype(mx.float32),
    "decoded_pixels": decoded.astype(mx.float32),
    "packed_latent": packed.astype(mx.float32),
    "decoded_packed_pixels": decoded_packed.astype(mx.float32),
    "bn_running_mean": all_weights["bn.running_mean"].astype(mx.float32),
    "bn_running_var": all_weights["bn.running_var"].astype(mx.float32),
    "dbg_post_quant_conv": _pqc_nchw.astype(mx.float32),
    "dbg_conv_in": _conv_in.astype(mx.float32),
}
out_path = OUT_DIR / "flux2_vae_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"\nSaved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
