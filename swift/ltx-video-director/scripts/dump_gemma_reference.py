"""Dump Gemma-3-12b encode reference for Swift parity testing.

Goes straight to the vendor GemmaLanguageModel (the same class the pipeline
uses) and captures the verifiable contract for the atomic first unit of the
Gemma port: tokenizer + embed_tokens + sqrt(hidden) scaling + first Gemma-3
decoder block. Capturing all 49 layers would be ~24 MB fp16 — too big to
commit and premature (each layer is verified once the block port exists).

Keeps max_length small (64) so h0/h1 are ~490 KB each (fp16, committed).

Run from repo root (loads the 7.5 GB model from HF cache, ~2 min):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_gemma_reference.py
"""
import json
import os
import sys

import mlx.core as mx

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_core_mlx.text_encoders.gemma.encoders.base_encoder import GemmaLanguageModel  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "gemma")
os.makedirs(OUT_DIR, exist_ok=True)

MODEL_ID = "mlx-community/gemma-3-12b-it-4bit"
MAX_LENGTH = 64

# Minimal valid Gemma-3 chat turn (the format the pipeline feeds). Short,
# deterministic content so token_ids are reproducible.
PROMPT = "<start_of_turn>user\nA woman waves on a city street.<end_of_turn>\n<start_of_turn>model\n"

print(f"loading {MODEL_ID} (7.5 GB, ~2 min)…", flush=True)
enc = GemmaLanguageModel(MODEL_ID)
enc.load()

print("tokenizing…", flush=True)
token_ids, attn_mask = enc.tokenize(PROMPT, max_length=MAX_LENGTH)

print("forward pass (capturing h0 + h1)…", flush=True)
states = enc.get_all_hidden_states(token_ids, attention_mask=attn_mask)
# states[0] = embedding output (post sqrt-scaling)
# states[1] = output of transformer layer 0

arrays = {
    "token_ids": token_ids.astype(mx.int32),
    "attention_mask": attn_mask.astype(mx.int32),
    "h0_embedding": states[0].astype(mx.float16),
    "h1_layer0": states[1].astype(mx.float16),
}
mx.save_safetensors(os.path.join(OUT_DIR, "ref.safetensors"), dict(arrays))
mx.eval(arrays)

with open(os.path.join(OUT_DIR, "meta.json"), "w") as f:
    json.dump({
        "model_id": MODEL_ID,
        "max_length": MAX_LENGTH,
        "num_hidden_states_total": len(states),
        "hidden_dim": int(states[0].shape[-1]),
        "prompt": PROMPT,
    }, f, indent=2)

print(f"wrote {len(arrays)} tensors (h0/h1 fp16) to {OUT_DIR}")
print(f"  hidden_dim={states[0].shape[-1]}, num_states={len(states)}")
