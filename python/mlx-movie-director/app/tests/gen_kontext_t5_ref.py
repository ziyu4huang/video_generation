#!/usr/bin/env python3
"""Generate FLUX.1-Kontext-dev T5 text-encoder reference tensors for Swift
port verification (kontext epic phase 4b, see
output/next-goal-20260714_212213.md).

Loads mflux's real `T5Encoder` MLX class directly from the raw HF
`text_encoder_2/` checkpoint via `FluxWeightMapping.get_t5_encoder_mapping()`
(identity naming for everything except `relative_attention_bias`, which is a
one-to-many broadcast of block 0's tensor into all 24 blocks — HF T5 only
stores/trains this bias once and shares it across layers; mflux's per-block
`T5SelfAttention.relative_attention_bias` module just gets the same array
copied into each block's in-memory weights at load time, confirmed by reading
the real mapping entry — see the max_blocks=24 target with a from_pattern
that has NO {block} placeholder), tokenizes a fixed prompt with the real HF
`T5Tokenizer` (max_length=512, Kontext's max_sequence_length override), runs
the real forward pass, and saves input_ids + prompt_embeds as safetensors.
The Swift port loads the SAME raw HF safetensors directly (no separate MLX
conversion step, same strategy as `KontextTransformer.swift`), broadcasts
block 0's relative_attention_bias into all 24 blocks itself, and compares
(cos > 0.99) against this reference.

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_t5_ref.py
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
from transformers import T5TokenizerFast

from mflux.models.flux.model.flux_text_encoder.t5_encoder.t5_encoder import T5Encoder
from mflux.models.flux.weights.flux_weight_mapping import FluxWeightMapping

OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "black-forest-labs/FLUX.1-Kontext-dev"
PROMPT = "a photo of an astronaut riding a horse on the moon"
MAX_LENGTH = 512

# 1. Load the real HF T5 text-encoder checkpoint (sharded).
root = Path(snapshot_download(
    repo_id=MODEL_ID, allow_patterns=["text_encoder_2/*.safetensors", "text_encoder_2/*.json"]))
enc_dir = root / "text_encoder_2"
all_w = {}
for shard in sorted(enc_dir.glob("*.safetensors")):
    if shard.name.startswith("._"):
        continue
    all_w.update(mx.load(str(shard)))
print(f"Loaded {len(all_w)} raw HF T5 weights from {enc_dir}")

# 2. Apply FluxWeightMapping.get_t5_encoder_mapping() (identity naming, except
#    the one-to-many relative_attention_bias broadcast).
mappings = FluxWeightMapping.get_t5_encoder_mapping()


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


expansion_ranges = {"block": list(range(24))}

renamed_w = {}
mapped = 0
for m in mappings:
    to_has_block = "{block}" in m.to_pattern
    from_has_block = any("{block}" in fp for fp in m.from_pattern)
    if to_has_block and not from_has_block:
        # One-to-many: single HF source key broadcast to every MLX block target
        # (relative_attention_bias). max_blocks caps how many targets to fill.
        max_blocks = m.max_blocks or 24
        src_key = m.from_pattern[0]
        assert src_key in all_w, f"missing broadcast source key: {src_key}"
        src_val = all_w[src_key].astype(mx.float32)
        if m.transform is not None:
            src_val = m.transform(src_val)
        for block_num in range(max_blocks):
            to_key = m.to_pattern.replace("{block}", str(block_num))
            renamed_w[to_key] = src_val
            mapped += 1
        continue
    for from_pat in m.from_pattern:
        from_keys = _expand_pattern(from_pat, expansion_ranges)
        to_keys = _expand_pattern(m.to_pattern, expansion_ranges)
        for fk, tk in zip(from_keys, to_keys):
            if fk not in all_w:
                print(f"[gen-kontext-t5-ref] source key not found (skipping): {fk}")
                continue
            arr = all_w[fk].astype(mx.float32)
            if m.transform is not None:
                arr = m.transform(arr)
            renamed_w[tk] = arr
            mapped += 1

print(f"Mapped {mapped} target weights")

# 3. Build + load. Assert nothing silently dropped.
t5 = T5Encoder()
model_keys = {k for k, _ in tree_flatten(t5.parameters())}
missing = model_keys - set(renamed_w.keys())
extra = set(renamed_w.keys()) - model_keys
assert not missing, f"weight loading would leave {len(missing)} params unset: {sorted(missing)[:5]}"
if extra:
    print(f"[gen-kontext-t5-ref] {len(extra)} mapped keys unused by T5Encoder: {sorted(extra)[:5]}")
t5.update(tree_unflatten(list(renamed_w.items())), strict=False)
mx.eval(t5.parameters())

# 4. Tokenize with the real HF T5Tokenizer (max_length=512, Kontext override).
tok_dir = snapshot_download(repo_id=MODEL_ID, allow_patterns=["tokenizer_2/*"])
tokenizer = T5TokenizerFast.from_pretrained(str(Path(tok_dir) / "tokenizer_2"))
enc = tokenizer(
    PROMPT, padding="max_length", max_length=MAX_LENGTH, truncation=True, return_tensors="np"
)
input_ids = mx.array(enc["input_ids"])
print(f"Tokenized prompt -> input_ids shape {input_ids.shape}")

# 5. Forward pass -> prompt_embeds (1, 512, 4096).
embeds = t5(input_ids)
mx.eval(embeds)
print(f"prompt_embeds shape: {embeds.shape}, dtype: {embeds.dtype}")

# 6. Save.
ref = {
    "input_ids": input_ids.astype(mx.int32),
    "prompt_embeds": embeds.astype(mx.float32),
}
out_path = OUT_DIR / "kontext_t5_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"\nSaved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
