"""Dump layer-0 intermediate values to localize the Gemma block diff.

RoPE is verified correct (gemma_rope ref passes). This replicates the real
Gemma-3 layer-0 forward step by step, capturing every intermediate so the
Swift port can diff each and find the divergence point.

Run from repo root (loads 7.5 GB, ~2 min):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_gemma_layer0_intermediates.py
"""
import os
import sys

import mlx.core as mx
import mlx.nn as nn

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(
    REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src"))

from ltx_core_mlx.text_encoders.gemma.encoders.base_encoder import GemmaLanguageModel  # noqa: E402
from mlx_lm.models.gemma3_text import clip_residual  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "gemma_inter")
os.makedirs(OUT_DIR, exist_ok=True)

MODEL_ID = "mlx-community/gemma-3-12b-it-4bit"
MAX_LENGTH = 64
PROMPT = "<start_of_turn>user\nA woman waves on a city street.<end_of_turn>\n<start_of_turn>model\n"

print("loading…", flush=True)
enc = GemmaLanguageModel(MODEL_ID)
enc.load()

token_ids, attn_mask = enc.tokenize(PROMPT, max_length=MAX_LENGTH)
states = enc.get_all_hidden_states(token_ids, attention_mask=attn_mask)
h0 = states[0]
# Replicate base_encoder mask exactly.
T = token_ids.shape[1]
causal = mx.triu(mx.full((T, T), -1e9, dtype=mx.bfloat16), k=1)
pad = (1 - attn_mask[:, None, None, :].astype(mx.bfloat16)) * -1e9
mask = causal[None, None, :, :] + pad

# Navigate to the inner model + layer 0.
inner = enc._model
for attr in ("model", "language_model", "model"):
    if hasattr(inner, attr):
        inner = getattr(inner, attr)
    if hasattr(inner, "embed_tokens"):
        break
layer0 = inner.layers[0]

arrays = {"token_ids": token_ids.astype(mx.int32), "attention_mask": attn_mask.astype(mx.int32),
          "h0": h0.astype(mx.float16), "mask": mask.astype(mx.float16)}

# Step the layer-0 forward manually, capturing intermediates.
x = h0
ln1 = layer0.input_layernorm(x); arrays["post_input_layernorm"] = ln1.astype(mx.float16)
attn_out = layer0.self_attn(ln1, mask=mask, cache=None); arrays["attn_out"] = attn_out.astype(mx.float16)
h = clip_residual(x, layer0.post_attention_layernorm(attn_out)); arrays["post_attn_residual"] = h.astype(mx.float16)
ln3 = layer0.pre_feedforward_layernorm(h); arrays["post_pre_ff_layernorm"] = ln3.astype(mx.float16)
mlp_out = layer0.mlp(ln3); arrays["mlp_out"] = mlp_out.astype(mx.float16)
h1 = clip_residual(h, layer0.post_feedforward_layernorm(mlp_out)); arrays["h1"] = h1.astype(mx.float16)

# Also capture attention internals.
B, L = ln1.shape[0], ln1.shape[1]
sa = layer0.self_attn
q = sa.q_proj(ln1).reshape(B, L, sa.n_heads, -1).transpose(0, 2, 1, 3)
k = sa.k_proj(ln1).reshape(B, L, sa.n_kv_heads, -1).transpose(0, 2, 1, 3)
v = sa.v_proj(ln1).reshape(B, L, sa.n_kv_heads, -1).transpose(0, 2, 1, 3)
arrays["q_raw"] = q.astype(mx.float16)
arrays["k_raw"] = k.astype(mx.float16)
arrays["v_raw"] = v.astype(mx.float16)
qn = sa.q_norm(q); arrays["q_post_norm"] = qn.astype(mx.float16)
kn = sa.k_norm(k); arrays["k_post_norm"] = kn.astype(mx.float16)
qr = sa.rope(qn); arrays["q_post_rope"] = qr.astype(mx.float16)
kr = sa.rope(kn); arrays["k_post_rope"] = kr.astype(mx.float16)

mx.save_safetensors(os.path.join(OUT_DIR, "ref.safetensors"), dict(arrays))
mx.eval(arrays)
print(f"wrote {len(arrays)} tensors to {OUT_DIR}")
