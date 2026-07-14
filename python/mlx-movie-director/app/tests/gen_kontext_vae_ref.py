#!/usr/bin/env python3
"""Generate FLUX.1-Kontext-dev VAE reference tensors for Swift port
verification (kontext epic phase 4, see output/next-goal-20260714_200847.md).

Loads mflux's REAL Flux VAE class (`flux_vae.VAE`, the class
`Flux1Kontext` actually uses) directly from the raw HF checkpoint via
`FluxWeightMapping.get_vae_mapping()` — independent of the MLX-native weights
already produced by `convert_kontext_vae_to_mlx()` (which took a shortcut
through `ZImageWeightMapping`+`ZImageVAE`, justified by the two configs being
byte-identical; this script re-derives a reference from the authoritative
Flux-side path instead, so a bug shared between both mappings/scripts is less
likely to hide undetected).

Runs encode + decode on a fixed-seed random image, and saves the input image,
encoded latent, and decoded pixels as safetensors. The Swift port loads these
and compares (cos > 0.99) against `ZImageVAEEncoder`/`ZImageVAEDecoder` fed
the `convert_kontext_vae_to_mlx()` weights.

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_vae_ref.py
"""
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))
sys.path.insert(0, str(REPO.parent / "mflux" / "src"))

import mlx.core as mx
from mlx.utils import tree_flatten, tree_unflatten
from huggingface_hub import snapshot_download

from mflux.models.flux.model.flux_vae.vae import VAE as FluxVAE
from mflux.models.flux.weights.flux_weight_mapping import FluxWeightMapping

OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "black-forest-labs/FLUX.1-Kontext-dev"

# 1. Load the real HF VAE checkpoint.
root = Path(snapshot_download(repo_id=MODEL_ID, allow_patterns=["vae/*.safetensors", "vae/*.json"]))
vae_dir = root / "vae"
all_w = {}
for shard in sorted(vae_dir.glob("*.safetensors")):
    if shard.name.startswith("._"):
        continue
    all_w.update(mx.load(str(shard)))
print(f"Loaded {len(all_w)} raw HF VAE weights from {vae_dir}")

# 2. Apply FluxWeightMapping.get_vae_mapping() (identity naming + conv2d
#    transpose; quant_conv/post_quant_conv targets simply won't match any
#    source key since Kontext's VAE has use_quant_conv=false).
mappings = FluxWeightMapping.get_vae_mapping()


def _expand_pattern(pattern, expansion_ranges):
    placeholders = re.findall(r"\{(\w+)\}", pattern)
    if not placeholders:
        return [pattern]
    results = [pattern]
    for ph in placeholders:
        new_results = []
        for r in results:
            for val in expansion_ranges.get(ph, [0]):
                new_results.append(r.replace(f"{{{ph}}}", str(val)))
        results = new_results
    return results


expansion_ranges = {"block": [0, 1, 2, 3], "res": [0, 1], "i": [0, 1]}
decoder_expansion = dict(expansion_ranges, res=[0, 1, 2])

key_map = {}
for m in mappings:
    for from_pat in m.from_pattern:
        is_decoder_upblock = "decoder.up_blocks.{block}" in from_pat
        exp = decoder_expansion if is_decoder_upblock else expansion_ranges
        from_keys = _expand_pattern(from_pat, exp)
        to_keys = _expand_pattern(m.to_pattern, exp)
        for fk, tk in zip(from_keys, to_keys):
            key_map[fk] = (tk, m.transform)

renamed_w = {}
mapped = 0
for k, v in all_w.items():
    if k in key_map:
        new_key, transform = key_map[k]
        arr = v.astype(mx.float32)
        if transform is not None:
            arr = transform(arr)
        renamed_w[new_key] = arr
        mapped += 1
    else:
        print(f"[gen-kontext-vae-ref] unmapped source key (expected for "
              f"quant_conv/post_quant_conv, use_quant_conv=false): {k}")
print(f"Mapped {mapped}/{len(all_w)} weights")

# 3. Build + load. FluxVAE's own class attribute layout may differ from
#    FluxWeightMapping's to_pattern in the SAME way ZImageWeightMapping's did
#    for ZImageVAE (kontext epic phase 2 found a near-identical silent-skip
#    bug from an unrenamed-key mismatch) — assert nothing is silently dropped.
vae = FluxVAE()
model_keys = {k for k, _ in tree_flatten(vae.parameters())}
missing = model_keys - set(renamed_w.keys())
extra = set(renamed_w.keys()) - model_keys
assert not missing, f"weight loading would leave {len(missing)} params unset: {sorted(missing)[:5]}"
if extra:
    print(f"[gen-kontext-vae-ref] {len(extra)} mapped keys unused by FluxVAE "
          f"(expected: quant_conv/post_quant_conv): {sorted(extra)[:5]}")
vae.update(tree_unflatten(list(renamed_w.items())), strict=False)
mx.eval(vae.parameters())

# 4. Fixed-seed random image (1,3,128,128), [-1,1]-ish range.
SEED = 4242
mx.random.seed(SEED)
img = mx.random.normal((1, 3, 128, 128)).astype(mx.float32)
mx.eval(img)

# 5. Encode -> latent (1,16,1,16,16) (VAE.encode adds a temporal axis).
latent = vae.encode(img[:, :, None, :, :])
mx.eval(latent)
print(f"Encoded latent shape: {latent.shape}, dtype: {latent.dtype}")

# 6. Decode back -> pixels (1,3,1,128,128).
decoded = vae.decode(latent)
mx.eval(decoded)
print(f"Decoded pixels shape: {decoded.shape}, dtype: {decoded.dtype}")

latent_2d = latent[:, :, 0, :, :]
decoded_2d = decoded[:, :, 0, :, :]

# 7. Save.
ref = {
    "input_image": img.astype(mx.float32),
    "encoded_latent": latent_2d.astype(mx.float32),
    "decoded_pixels": decoded_2d.astype(mx.float32),
}
out_path = OUT_DIR / "kontext_vae_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"\nSaved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
