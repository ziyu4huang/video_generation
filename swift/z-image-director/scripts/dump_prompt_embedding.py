#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportMissingModuleSource=false
"""
dump_prompt_embedding.py — Phase 3 embedding exchange.

Encodes a prompt (and optional unconditional) with the real Python text encoder
and dumps the cap_feats to safetensors. The Swift T2I pipeline loads these and
feeds them to the already-verified Swift transformer — deferring the text encoder
port while unblocking end-to-end generation.

Run from repo root:
  python/venv/bin/python swift/z-image-director/scripts/dump_prompt_embedding.py \
      --prompt "a cinematic portrait" --output .scratch/emb/prompt.safetensors
"""

import argparse
import os
import sys

import mlx.core as mx
import mlx.nn as nn
import numpy as np

sys.path.insert(0, "python/mlx-movie-director")
from app.text_encoder import TextEncoderMLX  # noqa: E402
from app.config import TEXT_ENCODER_DIR, TOKENIZER_DIR  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402


def encode(text_encoder, tokenizer, text: str) -> mx.array:
    msgs = [{"role": "user", "content": text}]
    try:
        fmt = tokenizer.apply_chat_template(
            msgs, tokenize=False, add_generation_prompt=True
        )
    except (TypeError, ValueError):
        fmt = text
    toks = tokenizer(
        fmt, padding="max_length", max_length=512, truncation=True, return_tensors="np"
    )
    embeds = text_encoder(mx.array(toks["input_ids"]))
    mx.eval(embeds)
    arr = np.array(embeds)
    # Pad to multiple of 32 (matches pipeline.py _encode_one).
    pad = (-arr.shape[1]) % 32
    if pad > 0:
        arr = np.concatenate([arr, np.repeat(arr[:, -1:, :], pad, axis=1)], axis=1)
    return mx.array(arr).astype(mx.bfloat16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument(
        "--output", default="swift/z-image-director/.scratch/emb/prompt.safetensors"
    )
    ap.add_argument(
        "--uncond", action="store_true", help="also dump empty-prompt embedding"
    )
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    te_config_path = os.path.join(TEXT_ENCODER_DIR, "config.json")
    import json

    with open(te_config_path) as f:
        te_config = json.load(f)
    text_encoder = TextEncoderMLX(te_config)
    quantized_weights_path = os.path.join(TEXT_ENCODER_DIR, "model.safetensors")
    nn.quantize(text_encoder, bits=4, group_size=32)
    text_encoder.load_weights(quantized_weights_path)
    text_encoder.eval()
    mx.eval(text_encoder)

    tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_DIR)

    cap_feats = encode(text_encoder, tokenizer, args.prompt)
    print(f"[encode] prompt cap_feats: {cap_feats.shape} {cap_feats.dtype}")

    out = {"cap_feats": cap_feats}
    if args.uncond:
        out["uncond_feats"] = encode(text_encoder, tokenizer, "")
        print(f"[encode] uncond  cap_feats: {out['uncond_feats'].shape}")

    mx.save_safetensors(args.output, out)
    print(f"[dump] {args.output}")


if __name__ == "__main__":
    main()
