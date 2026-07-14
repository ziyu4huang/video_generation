#!/usr/bin/env python3
"""Generate FLUX.1-Kontext-dev CLIP text-encoder reference tensors for Swift
port verification (kontext epic phase 4b, see
output/next-goal-20260714_212213.md).

Loads mflux's real `CLIPEncoder` MLX class directly from the raw HF
`text_encoder/` checkpoint via `FluxWeightMapping.get_clip_encoder_mapping()`
(an identity mapping — HF key names equal the MLX module's attribute names,
confirmed by reading the mapping source), tokenizes a fixed prompt with the
real HF `CLIPTokenizer`, runs the real forward pass, and saves input_ids +
pooled_output as safetensors. The Swift port loads the SAME raw HF safetensors
directly (no separate MLX conversion step needed, same strategy as
`KontextTransformer.swift`) and compares (cos > 0.99) against this reference.

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_clip_ref.py
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
from transformers import CLIPTokenizer

from mflux.models.flux.model.flux_text_encoder.clip_encoder.clip_encoder import CLIPEncoder
from mflux.models.flux.weights.flux_weight_mapping import FluxWeightMapping

OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "black-forest-labs/FLUX.1-Kontext-dev"
PROMPT = "a photo of an astronaut riding a horse on the moon"

# 1. Load the real HF CLIP text-encoder checkpoint.
root = Path(snapshot_download(repo_id=MODEL_ID, allow_patterns=["text_encoder/*.safetensors", "text_encoder/*.json"]))
enc_dir = root / "text_encoder"
all_w = {}
for shard in sorted(enc_dir.glob("*.safetensors")):
    if shard.name.startswith("._"):
        continue
    all_w.update(mx.load(str(shard)))
print(f"Loaded {len(all_w)} raw HF CLIP weights from {enc_dir}")

# 2. Apply FluxWeightMapping.get_clip_encoder_mapping() (identity naming).
mappings = FluxWeightMapping.get_clip_encoder_mapping()


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


expansion_ranges = {"block": list(range(12))}

key_map = {}
for m in mappings:
    for from_pat in m.from_pattern:
        from_keys = _expand_pattern(from_pat, expansion_ranges)
        to_keys = _expand_pattern(m.to_pattern, expansion_ranges)
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
        print(f"[gen-kontext-clip-ref] unmapped source key: {k}")
print(f"Mapped {mapped}/{len(all_w)} weights")

# 3. Build + load. Assert nothing silently dropped (the discipline that
#    caught real bugs in the transformer and VAE ports).
clip = CLIPEncoder()
model_keys = {k for k, _ in tree_flatten(clip.parameters())}
missing = model_keys - set(renamed_w.keys())
extra = set(renamed_w.keys()) - model_keys
assert not missing, f"weight loading would leave {len(missing)} params unset: {sorted(missing)[:5]}"
if extra:
    print(f"[gen-kontext-clip-ref] {len(extra)} mapped keys unused by CLIPEncoder: {sorted(extra)[:5]}")
clip.update(tree_unflatten(list(renamed_w.items())), strict=False)
mx.eval(clip.parameters())

# 4. Tokenize with the real HF CLIPTokenizer (max_length=77, matches Kontext).
tok_dir = snapshot_download(repo_id=MODEL_ID, allow_patterns=["tokenizer/*"])
tokenizer = CLIPTokenizer.from_pretrained(str(Path(tok_dir) / "tokenizer"))
enc = tokenizer(
    PROMPT, padding="max_length", max_length=77, truncation=True, return_tensors="np"
)
input_ids = mx.array(enc["input_ids"])
print(f"Tokenized prompt -> input_ids shape {input_ids.shape}")

# 5. Forward pass -> pooled_output (1, 768).
pooled = clip(input_ids)
mx.eval(pooled)
print(f"pooled_output shape: {pooled.shape}, dtype: {pooled.dtype}")

# 6. Save.
ref = {
    "input_ids": input_ids.astype(mx.int32),
    "pooled_output": pooled.astype(mx.float32),
}
out_path = OUT_DIR / "kontext_clip_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"\nSaved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
