# Gemma-3-12b native port — status

## RESOLVED: encoder forward pass (the hard part) ✅

All Gemma-3-12b encoder components ported and verified end-to-end against real
production weights, in bf16 (matching mlx-lm's compute dtype):

| Component | Verified against |
|-----------|------------------|
| `GemmaConfig` | cached config.json + mlx-lm ModelArgs defaults |
| `GemmaRMSNorm` (`1.0 + weight`) | layer-0 intermediate dump |
| `GemmaMLP` (SwiGLU gelu_approx) | layer-0 intermediate dump |
| `GemmaAttention` (GQA + QK-norm + dual-RoPE SPLIT) | RoPE isolation test + layer-0 |
| `GemmaBlock` (4 layernorms + clip_residual) | layer-0 parity (< 0.5% rel) |
| `GemmaCheckpointLoader` (4-bit/group64 dequant → bf16) | embed h0 parity (< 0.13% rel) |
| `GemmaEmbedding` (embed + sqrt(hidden)) | h0 parity |
| `GemmaMask` (causal+padding, bf16) | full encoder |
| `GemmaEncoder` (48 streaming blocks → 49 hidden states) | **h48 parity < 5% rel over full depth** |

**Tests**: `GemmaRoPEParityTests`, `GemmaLayer0ParityTests`, `GemmaFullEncoderParityTests`
all pass. 67/67 package tests green.

### The key fix that unblocked it

Two real bugs, both found via the dump-real-reference methodology:

1. **Wrong tolerance metric** (the original "diff 32" failure): Gemma's residual
   stream is NOT re-normalized between layers, so |h| grows to absmax ~10048 by
   layer 48. An absolute diff of 32 is only **0.32% relative** — squarely in the
   bf16-vs-fp32 precision band. Fixed by switching the parity threshold to
   relative error (diff/absmax).

2. **fp32 vs bf16 compute mismatch** (the 26% divergence over 48 layers): the
   reference dequantizes 4-bit weights to **bfloat16** (mlx-lm's compute dtype);
   the first port used float32. An un-normalized 48-layer residual stack is
   chaotic — the dtype mismatch compounds to 26%. Matching the reference's bf16
   compute dtype bounds the full-depth error to < 5%. (Also required the mask to
   be bf16, since `sdpa` requires the mask to promote to the output dtype.)

## REMAINING: the tokenizer (text → token_ids) — needs Gemma SentencePiece

`GemmaTokenizer.swift` exists and does the left-padding correctly, but uses
z-image-director's `BPETokenizer` which is **Tiktoken-style** BPE. Gemma uses
**SentencePiece** (different merge algorithm) — so it produces wrong token_ids
(diff ~245237 on the test prompt). This is the sole remaining gap for a fully
native `text → hidden states` path.

Options:
- Port Gemma's SentencePiece tokenizer to Swift (the `tokenizer.json` HF format
  encodes the full SentencePiece model — a real but bounded port).
- Or bridge tokenization to Python (tiny, deterministic, no model load) and keep
  the 12B encoder native.

The encoder (the 7.5 GB, 48-layer, architecture-complex part) is fully native
and verified. The tokenizer is a CPU-only, ~16-token, no-weights step.

## After the tokenizer lands

Concatenate 49 hidden states → (B, T, 188160) → `TextEmbeddingProjection`
(already native) → video/audio embeds → DiT. Then wire into a native encode +
retire `RunPyBridge` in the i2v command.
