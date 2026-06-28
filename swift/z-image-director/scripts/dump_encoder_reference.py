#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportMissingModuleSource=false
"""
dump_encoder_reference.py — Phase 3 verification.

Runs the Python Qwen3 text encoder on sample input_ids and dumps intermediate
+ final hidden states for Swift verification. Also dumps the tokenized IDs
from a real prompt (for the tokenizer port verification later).

Run from repo root:
  python/venv/bin/python swift/z-image-director/scripts/dump_encoder_reference.py
"""

import json
import os
import sys

import mlx.core as mx
import mlx.nn as nn

sys.path.insert(0, "python/mlx-movie-director")
from app.text_encoder import TextEncoderMLX  # noqa: E402
from app.config import TEXT_ENCODER_DIR, TOKENIZER_DIR  # noqa: E402


def main():
    ref_dir = "swift/z-image-director/.scratch/ref"
    os.makedirs(ref_dir, exist_ok=True)

    with open(os.path.join(TEXT_ENCODER_DIR, "config.json")) as f:
        cfg = json.load(f)
    model = TextEncoderMLX(cfg)
    nn.quantize(model, bits=4, group_size=32)
    model.load_weights(os.path.join(TEXT_ENCODER_DIR, "model.safetensors"))
    model.eval()
    mx.eval(model)

    # 1. Fixed test input_ids for deterministic verification.
    test_ids = mx.array(
        [[1, 2, 3, 4, 5, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 50000]]
    )
    print(f"test input_ids shape: {test_ids.shape}")

    # Run the model — Python returns hidden_states[-2].
    output = model(test_ids)
    print(f"cap_feats output shape: {output.shape}, mean: {float(mx.mean(output)):.6f}")

    mx.save_safetensors(
        f"{ref_dir}/ref_encoder.safetensors",
        {
            "input_ids": test_ids.astype(mx.float32),
            "cap_feats": output.astype(mx.float32),
        },
    )

    # 2. Real prompt tokenization (for tokenizer port verification).
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_DIR)
    prompt = "a cinematic portrait of a woman, dramatic lighting, film grain"
    msgs = [{"role": "user", "content": prompt}]
    try:
        formatted = tokenizer.apply_chat_template(
            msgs, tokenize=False, add_generation_prompt=True
        )
    except (TypeError, ValueError):
        formatted = prompt
    enc = tokenizer(
        formatted,
        padding="max_length",
        max_length=512,
        truncation=True,
        return_tensors="np",
    )
    real_ids = mx.array(enc["input_ids"])
    print(
        f"real prompt tokenized: {real_ids.shape}, ids[:20]: {enc['input_ids'][0][:20]}"
    )

    # Run encoder on real prompt
    real_out = model(real_ids)
    print(f"real cap_feats: {real_out.shape}, mean: {float(mx.mean(real_out)):.6f}")

    mx.save_safetensors(
        f"{ref_dir}/ref_encoder_real.safetensors",
        {
            "input_ids": real_ids.astype(mx.int32).astype(mx.float32),
            "cap_feats": real_out.astype(mx.float32),
            "formatted_text": mx.array(
                [ord(c) for c in formatted[:1000]]
            ),  # first 1000 chars
        },
    )

    # Also dump the full formatted text and token IDs for tokenizer port
    with open(f"{ref_dir}/ref_tokenizer_sample.json", "w") as f:
        json.dump(
            {
                "prompt": prompt,
                "formatted": formatted,
                "token_ids": enc["input_ids"][0].tolist(),
                "length": len(enc["input_ids"][0]),
            },
            f,
            indent=2,
        )
    print(
        f"tokenizer sample saved (formatted len={len(formatted)}, tokens={len(enc['input_ids'][0])})"
    )
    print(f"\n✅ reference dumps saved to {ref_dir}/")


if __name__ == "__main__":
    main()
