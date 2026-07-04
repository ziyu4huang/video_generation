"""Dump a REAL whisper-large-v3-mlx decoder-block-0 reference.

Sibling of dump_whisper_real_encoder_block_reference.py — same "real
checkpoint, one real block" scope (mirrors
LTXModelRealCheckpointTests.testOneRealBlockProducesFiniteOutput), applied
to TextDecoder instead of AudioEncoder. Loads the actual cached
whisper-large-v3-mlx token/positional embeddings + decoder block-0 weights
(self-attn + cross-attn + MLP) and runs a real partial forward: embed a
handful of real special/text tokens, causal-mask self-attend, cross-attend
to REAL encoder output (reuses dump_whisper_real_encoder_block_reference.py's
own encoder-block-0 output as the "encoder features" — good enough to
exercise the cross-attention math; a full encoder run isn't needed to prove
decoder correctness).

Run from repo root (run dump_whisper_real_encoder_block_reference.py FIRST):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_real_decoder_block_reference.py
"""
import json
import os

import mlx.core as mx
import numpy as np
from safetensors.numpy import load_file, save_file

CHECKPOINT = os.path.expanduser(
    "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/"
    "snapshots/49e6aa286ad60c14352c404340ded53710378a11/weights.npz"
)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENCODER_REF = os.path.join(SCRIPT_DIR, "..", "test_refs", "whisper_real_encoder_block", "whisper_real_encoder_block.safetensors")
OUT_DIR = os.path.join(SCRIPT_DIR, "..", "test_refs", "whisper_real_decoder_block")


def gelu(x):
    return x * (1 + mx.erf(x / mx.sqrt(mx.array(2.0)))) / 2


def layer_norm(x, weight, bias, eps=1e-5):
    mean = x.mean(axis=-1, keepdims=True)
    var = ((x - mean) ** 2).mean(axis=-1, keepdims=True)
    return (x - mean) / mx.sqrt(var + eps) * weight + bias


def attention(x, w, prefix, n_head=20, kv=None, mask=None):
    b, n, d = x.shape
    kv_in = kv if kv is not None else x
    n_kv = kv_in.shape[1]
    head_dim = d // n_head
    scale = head_dim ** -0.25

    def linear(inp, wk, bk=None):
        out = inp @ w[wk].T
        if bk is not None:
            out = out + w[bk]
        return out

    q = linear(x, f"{prefix}.query.weight", f"{prefix}.query.bias")
    k = linear(kv_in, f"{prefix}.key.weight")
    v = linear(kv_in, f"{prefix}.value.weight", f"{prefix}.value.bias")

    q = (q.reshape(b, n, n_head, head_dim).transpose(0, 2, 1, 3)) * scale
    k = (k.reshape(b, n_kv, n_head, head_dim).transpose(0, 2, 3, 1)) * scale
    v = v.reshape(b, n_kv, n_head, head_dim).transpose(0, 2, 1, 3)

    qk = q @ k
    if mask is not None:
        qk = qk + mask[:n, :n]
    attn_w = mx.softmax(qk, axis=-1, precise=True)
    out = (attn_w @ v).transpose(0, 2, 1, 3).reshape(b, n, d)
    return linear(out, f"{prefix}.out.weight", f"{prefix}.out.bias")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    enc_ref = load_file(ENCODER_REF)
    encoder_output = mx.array(enc_ref["block0_output"]).astype(mx.float32)

    weights = mx.load(CHECKPOINT)
    token_embedding = weights["decoder.token_embedding.weight"].astype(mx.float32)
    positional_embedding = weights["decoder.positional_embedding"].astype(mx.float32)

    # A handful of real Whisper special tokens (SOT, language=zh, transcribe,
    # notimestamps — the standard zh-TW/zh-CN transcription prefix) plus a
    # couple of arbitrary real vocab ids, exercising real embedding lookups.
    tokens = mx.array([[50258, 50260, 50359, 50363, 1234, 5678]])  # (1, 6)
    text_len = tokens.shape[1]

    x = mx.take(token_embedding, tokens, axis=0) + positional_embedding[:text_len]

    causal = np.zeros((text_len, text_len), dtype=np.float32)
    for i in range(text_len):
        for j in range(i + 1, text_len):
            causal[i, j] = -np.inf
    causal_mask = mx.array(causal)

    w = {k[len("decoder.blocks.0."):]: v.astype(mx.float32) for k, v in weights.items() if k.startswith("decoder.blocks.0.")}

    residual = x
    attn_ln = layer_norm(x, w["attn_ln.weight"], w["attn_ln.bias"])
    self_attn_out = attention(attn_ln, w, "attn", mask=causal_mask)
    x = residual + self_attn_out

    cross_ln = layer_norm(x, w["cross_attn_ln.weight"], w["cross_attn_ln.bias"])
    cross_attn_out = attention(cross_ln, w, "cross_attn", kv=encoder_output)
    x = x + cross_attn_out

    mlp_ln = layer_norm(x, w["mlp_ln.weight"], w["mlp_ln.bias"])
    mlp_hidden = gelu(mlp_ln @ w["mlp1.weight"].T + w["mlp1.bias"])
    mlp_out = mlp_hidden @ w["mlp2.weight"].T + w["mlp2.bias"]
    block0_output = x + mlp_out
    mx.eval(block0_output)

    outputs = {
        "tokens": np.array(tokens, copy=False),
        "token_embedding_slice": np.array(mx.take(token_embedding, tokens, axis=0), copy=False),
        "positional_embedding_slice": np.array(positional_embedding[:text_len], copy=False),
        "encoder_output": np.array(encoder_output, copy=False),
        "block0_output": np.array(block0_output, copy=False),
    }
    for k, v in w.items():
        outputs[f"blocks.0.{k}"] = np.array(v, copy=False)

    save_file(outputs, os.path.join(OUT_DIR, "whisper_real_decoder_block.safetensors"))
    meta = {
        "checkpoint": CHECKPOINT, "tokens": tokens.tolist(),
        "block0_output_shape": list(block0_output.shape), "n_head": 20,
    }
    with open(os.path.join(OUT_DIR, "whisper_real_decoder_block.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("tokens", tokens.shape, "-> block0_output", block0_output.shape)
    print("done ->", OUT_DIR)
