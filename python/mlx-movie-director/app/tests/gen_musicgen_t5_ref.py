#!/usr/bin/env python3
"""Generate MusicGen T5-base text-encoder reference tensors for Swift port
verification (Task 3 of docs/superpowers/plans/2026-07-28-musicgen-swift-
native-port.md).

Unlike FLUX.1-Kontext (a sharded checkpoint with a real `text_encoder_2/`
subfolder), `facebook/musicgen-small`'s HF snapshot is a SINGLE merged
`model.safetensors` at the snapshot root — no `text_encoder/` subfolder
exists (confirmed by listing the real cached snapshot: only
`config.json`/`model.safetensors`/`tokenizer.json`/`spiece.model`/etc at
root; `config.json` nests three sub-configs — `text_encoder`, `decoder`,
`audio_encoder` — under one top-level dict). `run.py import-musicgen`
already reproduces this by prefix-filtering `model.safetensors` for
`"text_encoder."` keys (see import-musicgen.py) rather than reading a
subfolder.

So instead of guessing a subfolder layout, this loads the real HF
`MusicgenForConditionalGeneration` wrapper (which handles the merged
checkpoint natively) and pulls out its real `.text_encoder` submodule
(a `T5EncoderModel` built from the nested `text_encoder` sub-config) --
guaranteed correct forward-pass semantics straight from the real model
class, no manual T5Config/state-dict reconstruction. The T5 tokenizer
files live at the snapshot root (not a subfolder), so `T5TokenizerFast.
from_pretrained("facebook/musicgen-small")` resolves directly.

Real HF `T5Stack.forward` applies the tokenizer's `attention_mask` as an
additive (-inf on padding) bias before softmax -- unlike flux2-image-director's
`KontextT5Encoder`/`gen_kontext_t5_ref.py`, which compare Swift against
mflux's own MLX T5Encoder (itself unmasked, so that comparison is
self-consistently unmasked on both sides). MusicGen's real prompts are short
(a few words) padded to MAX_LENGTH, so unmasked padding contamination is
large relative to Kontext's usage (long prompts closer to filling
max_length=512) -- confirmed by direct measurement: an unmasked Swift port
against this real masked HF reference scored cos=0.33, not >0.99. So this
reference also saves `attention_mask`, and the Swift port applies it as a
real additive mask (see MGT5SelfAttention in MusicGenT5Encoder.swift).

The Swift port loads the split flat checkpoint from `run.py import-musicgen`
and compares (cos > 0.99).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]

from transformers import T5TokenizerFast, MusicgenForConditionalGeneration
import torch

OUT_DIR = REPO / "swift" / "musicgen-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "facebook/musicgen-small"
PROMPT = "warm acoustic guitar, gentle, 90bpm"
MAX_LENGTH = 64

tokenizer = T5TokenizerFast.from_pretrained(MODEL_ID)
full_model = MusicgenForConditionalGeneration.from_pretrained(MODEL_ID)
text_encoder = full_model.text_encoder
text_encoder.eval()

enc = tokenizer(PROMPT, padding="max_length", max_length=MAX_LENGTH, truncation=True, return_tensors="pt")
with torch.no_grad():
    out = text_encoder(**enc).last_hidden_state

import mlx.core as mx
ref = {
    "input_ids": mx.array(enc["input_ids"].numpy()).astype(mx.int32),
    "attention_mask": mx.array(enc["attention_mask"].numpy()).astype(mx.int32),
    "prompt_embeds": mx.array(out.numpy()).astype(mx.float32),
}
out_path = OUT_DIR / "musicgen_t5_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"Saved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
