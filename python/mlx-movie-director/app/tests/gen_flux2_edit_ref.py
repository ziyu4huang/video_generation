#!/usr/bin/env python3
"""Generate Flux2 reference-conditioning reference tensors for Swift verification.

Replicates Flux2KleinEditHelpers.prepare_reference_image_conditioning:
  load → scale → to_array([-1,1]) → vae.encode → crop_even → patchify
  → bn_normalize → pack → grid_ids(t=10).
Saves image_latents + image_latent_ids + the input image for Swift comparison.
"""
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))

import mlx.core as mx
from mlx import nn
from mlx.utils import tree_unflatten
import numpy as np
from PIL import Image

from mflux.models.flux2.model.flux2_vae.vae import Flux2VAE
from mflux.models.flux2.latent_creator.flux2_latent_creator import Flux2LatentCreator
from mflux.models.flux2.variants.edit.flux2_klein_edit_helpers import _Flux2KleinEditHelpers
from mflux.utils.image_util import ImageUtil

VAE_DIR = REPO / "python" / "mlx-movie-director" / "models" / "vae" / "flux2-klein"
OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Load VAE.
vae = Flux2VAE()
all_w = {}
for s in sorted(VAE_DIR.glob("*.safetensors")):
    if not s.name.startswith("._"):
        all_w.update(mx.load(str(s)))
nn.quantize(vae, class_predicate=lambda p, m: hasattr(m, "to_quantized"), bits=8)
vae.update(tree_unflatten(list(all_w.items())), strict=False)
mx.eval(vae.parameters())
print(f"Loaded {len(all_w)} VAE weights")

# Deterministic reference image (512x512 RGB).
H, W = 512, 512
np.random.seed(123)
img_np = (np.random.rand(H, W, 3) * 255).astype(np.uint8)
img = Image.fromarray(img_np)
REF_IMG = OUT_DIR / "ref_image.png"
img.save(str(REF_IMG))
print(f"saved reference image: {REF_IMG}")

# Replicate prepare_reference_image_conditioning for a single image.
scaled = ImageUtil.scale_to_dimensions(img.convert("RGB"), target_width=W, target_height=H)
image_array = ImageUtil.to_array(scaled)  # (1, 3, H, W) in [-1,1]
print(f"image_array: {image_array.shape}, range=[{float(image_array.min()):.3f}, {float(image_array.max()):.3f}]")

encoded = vae.encode(image_array)
if encoded.ndim == 5 and encoded.shape[2] == 1:
    encoded = encoded[:, :, 0, :, :]
encoded = _Flux2KleinEditHelpers.crop_to_even_spatial(encoded)
encoded = Flux2LatentCreator.patchify_latents(encoded)
encoded = _Flux2KleinEditHelpers.bn_normalize_vae_encoded_latents(encoded, vae=vae)
packed = Flux2LatentCreator.pack_latents(encoded)
ids = Flux2LatentCreator.prepare_grid_ids(encoded, t_coord=10)
mx.eval(packed, ids)
print(f"image_latents: {packed.shape}, image_latent_ids: {ids.shape}")
print(f"  packed sum={float(packed.sum()):.3f} mean={float(packed.mean()):.5f}")

mx.save_safetensors(str(OUT_DIR / "flux2_edit_ref.safetensors"), {
    "image_latents": packed.astype(mx.float32),
    "image_latent_ids": ids.astype(mx.int32),
    "input_image": image_array.astype(mx.float32),
})
print(f"saved flux2_edit_ref.safetensors")
