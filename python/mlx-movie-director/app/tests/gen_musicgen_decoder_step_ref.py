#!/usr/bin/env python3
"""Generate MusicGen LM-decoder single-step logits reference (Task 7 of
docs/superpowers/plans/2026-07-28-musicgen-swift-native-port.md).

Feeds a fixed, deterministic partial codebook history + real T5 text
conditioning through one forward pass of the real HF decoder and saves the
logits at the LAST position for each codebook. The Swift port
(MusicGenDecoder, Task 6) runs the SAME inputs through one
`callAsFunction(inputIds:encoderHiddenStates:)` call and compares
(cosine on the flattened last-step logits).

Like gen_musicgen_t5_ref.py/gen_musicgen_encodec_ref.py (Tasks 3/5), this
does NOT try to load individual `subfolder="decoder"` / `subfolder=
"text_encoder"` checkpoints directly -- `facebook/musicgen-small`'s real HF
snapshot is a single merged `model.safetensors` at the snapshot root with no
per-submodule subfolders (confirmed by both prior reference scripts), so
`from_pretrained(..., subfolder=...)` would not resolve. Instead this loads
the full `MusicgenForConditionalGeneration` wrapper and pulls out its real
`.text_encoder` and `.decoder` submodules, guaranteeing the exact same
weights the Swift side loads via run.py import-musicgen's split checkpoint.

IMPORTANT decoder input/output shape contract, confirmed by reading the
installed transformers (4.57.6)
`transformers.models.musicgen.modeling_musicgen` source directly (NOT
assumed) because the plan's draft got both wrong:
  - `MusicgenForCausalLM.forward`'s `input_ids` wants shape
    `(batch_size * num_codebooks, seq_len)` -- for batch_size=1 that's just
    `(num_codebooks, seq_len)`, i.e. the SAME 2D shape
    `MusicGenDecoder.callAsFunction` takes directly. No extra reshape needed
    on the way in for batch=1.
  - `MusicgenForCausalLM.forward`'s returned `.logits` is already reshaped
    to `(batch_size * num_codebooks, seq_len, vocab_size)` (see
    `lm_logits.reshape(-1, *lm_logits.shape[2:])` in modeling_musicgen.py) --
    NOT `(1, num_codebooks, seq_len, vocab_size)` as the draft assumed. For
    batch=1 this is just `(num_codebooks, seq_len, vocab_size)`, no leading
    batch dim to index past.
  - `enc_to_dec_proj` (768 -> 1024, with bias) is NOT part of
    `MusicgenForCausalLM`/`MusicgenModel`/`MusicgenDecoder` at all -- it only
    exists on the outer `MusicgenForConditionalGeneration` wrapper (confirmed:
    `grep enc_to_dec_proj` in modeling_musicgen.py shows it defined and
    applied only in `MusicgenForConditionalGeneration.forward`, line ~1808,
    BEFORE calling `self.decoder(...)`). Task 2's checkpoint export folded
    `enc_to_dec_proj.{weight,bias}` into decoder.safetensors anyway (see
    MusicGenWeights.swift), and MusicGenDecoder.swift applies it internally
    at the start of `callAsFunction`, taking the RAW (un-projected) T5
    output as input. To reproduce that exact composed behavior here, this
    script explicitly does `full_model.enc_to_dec_proj(raw_t5_hidden_states)`
    itself before calling `full_model.decoder(...)`, using the real
    `enc_to_dec_proj` submodule that ships on the same `full_model` instance
    (so it's numerically the identical weights Task 2 exported) --
    reproducing exactly what MusicGenDecoder.swift's callAsFunction does in
    one step, while `gen_musicgen_decoder_step_ref.py`'s own SAVED
    `encoder_hidden_states` stays the raw (1, tLen, 768) T5 output, matching
    the Swift contract that callers pass unprojected states in.

No padding: the tokenizer call below uses natural (unpadded) length, so
there's no attention_mask/encoder_attention_mask needed on either the T5 or
decoder cross-attention side -- side-steps MusicGenDecoder.swift's known
cross-attention padding-mask gap entirely (documented in that file's header)
rather than triggering it.

The fixed partial codebook history (5 raw steps, seeded PRNG over [0, 2048))
does not need to obey the real delay-pattern mask -- this is a single-step
logits test of the decoder's own numerics, not a real generation.

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py
"""
from pathlib import Path

import numpy as np
import torch
from transformers import MusicgenForConditionalGeneration, T5TokenizerFast

REPO = Path(__file__).resolve().parents[4]
OUT_DIR = REPO / "swift" / "musicgen-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "facebook/musicgen-small"
PROMPT = "warm acoustic guitar, gentle, 90bpm"

tokenizer = T5TokenizerFast.from_pretrained(MODEL_ID)
full_model = MusicgenForConditionalGeneration.from_pretrained(MODEL_ID)
full_model.eval()

text_encoder = full_model.text_encoder
decoder = full_model.decoder
enc_to_dec_proj = full_model.enc_to_dec_proj

enc = tokenizer(PROMPT, return_tensors="pt")   # natural length, no padding
with torch.no_grad():
    encoder_hidden_states = text_encoder(**enc).last_hidden_state   # (1, tLen, 768)

# Fixed deterministic partial history: 5 raw steps, seeded PRNG over the real
# vocab range [0, 2048) for the 4 codebooks -- single-step-logits test, not a
# real generation, so the history's exact values don't need to obey the
# delay-pattern mask.
rng = np.random.default_rng(42)
raw_ids = rng.integers(0, 2048, size=(4, 5)).astype(np.int64)
input_ids = torch.from_numpy(raw_ids)   # (num_codebooks=4, seq_len=5) == (batch=1 * num_codebooks, seq_len)

with torch.no_grad():
    projected_encoder_states = enc_to_dec_proj(encoder_hidden_states)   # (1, tLen, 1024)
    out = decoder(
        input_ids=input_ids,
        encoder_hidden_states=projected_encoder_states,
        use_cache=False,
    )
    logits = out.logits   # (num_codebooks, seq_len, vocab_size) for batch=1 -- see header note

print(f"decoder logits: {tuple(logits.shape)}")
assert logits.shape[0] == 4 and logits.shape[-1] == 2048, (
    f"unexpected decoder logits shape {tuple(logits.shape)} -- the batch=1 "
    "flattening assumption in this script's header comment may be wrong for "
    "this transformers version, re-check modeling_musicgen.py"
)

last_logits = logits[:, -1, :]   # (num_codebooks, vocab_size)

import mlx.core as mx
ref = {
    "input_ids": mx.array(raw_ids).astype(mx.int32),                                      # (4, 5)
    "encoder_hidden_states": mx.array(encoder_hidden_states.numpy()).astype(mx.float32),   # (1, tLen, 768) RAW, un-projected
    "last_logits": mx.array(last_logits.numpy()).astype(mx.float32),                       # (4, 2048)
}
out_path = OUT_DIR / "musicgen_decoder_step_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"Saved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
