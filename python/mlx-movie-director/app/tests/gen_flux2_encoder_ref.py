#!/usr/bin/env python3
"""Generate Flux2 text encoder reference tensors for Swift port verification.

Loads qwen3-8b via mflux, tokenizes a test prompt (chat template), runs the
encoder, and saves input_ids + attention_mask + prompt_embeds for Swift
comparison (cos > 0.99).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_encoder_ref.py
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))

import mlx.core as mx
from mlx import nn
from mlx.utils import tree_unflatten
from transformers import AutoTokenizer

from mflux.models.flux2.model.flux2_text_encoder.qwen3_text_encoder import Qwen3TextEncoder

TE_DIR = REPO / "python" / "mlx-movie-director" / "models" / "text_encoder" / "qwen3-8b"
TOK_DIR = REPO / "python" / "mlx-movie-director" / "models" / "tokenizer" / "qwen3-klein"
OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 1. Load text encoder weights (8-bit quantized attention linears only).
te = Qwen3TextEncoder()
all_w = {}
for shard in sorted(TE_DIR.glob("*.safetensors")):
    if shard.name.startswith("._"):
        continue
    all_w.update(mx.load(str(shard)))
nn.quantize(te, class_predicate=lambda path, m: hasattr(m, "to_quantized"), bits=8)
te.update(tree_unflatten(list(all_w.items())), strict=False)
mx.eval(te.parameters())
print(f"Loaded {len(all_w)} text encoder weights (qwen3-8b)")

# 2. Tokenize a test prompt via the Qwen3 chat template (enable_thinking=False).
hf_tok = AutoTokenizer.from_pretrained(str(TOK_DIR))
prompt = "a woman in a garden, professional photo, sharp focus"
formatted = hf_tok.apply_chat_template(
    [{"role": "user", "content": prompt}],
    tokenize=False, add_generation_prompt=True, enable_thinking=False,
)
print(f"Chat-formatted prompt:\n{formatted}")
tokens = hf_tok(
    [formatted], padding="max_length", max_length=512, truncation=True,
    add_special_tokens=True, return_tensors="np",
)
input_ids = mx.array(tokens["input_ids"])          # (1, 512)
attention_mask = mx.array(tokens["attention_mask"])  # (1, 512)
mx.eval(input_ids, attention_mask)
print(f"input_ids: {input_ids.shape}, attention_mask: {attention_mask.shape}")
seq_len = int(attention_mask.sum())
print(f"effective seq_len (non-pad): {seq_len}")

# 3. Run the encoder → prompt_embeds (stack layers 9, 18, 27).
prompt_embeds = te.get_prompt_embeds(
    input_ids=input_ids, attention_mask=attention_mask,
    hidden_state_layers=(9, 18, 27),
)
mx.eval(prompt_embeds)
print(f"prompt_embeds: {prompt_embeds.shape}, dtype: {prompt_embeds.dtype}")

# 4. Save reference (cast to float32 for stable comparison).
ref = {
    "input_ids": input_ids.astype(mx.int32),
    "attention_mask": attention_mask.astype(mx.int32),
    "prompt_embeds": prompt_embeds.astype(mx.float32),
    "chat_formatted": mx.array([ord(c) for c in formatted[:2000]], dtype=mx.uint32),
}
# Truncate chat_formatted to actual length for reconstruction.
out_path = OUT_DIR / "flux2_encoder_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"\nSaved reference tensors to: {out_path}")

# Also save the formatted prompt as text for the Swift tokenizer port.
(OUT_DIR / "flux2_chat_formatted.txt").write_text(formatted)
print(f"Saved chat-formatted prompt to: flux2_chat_formatted.txt")
