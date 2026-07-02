# Gemma-3-12b native text encoder — COMPLETE ✅

> **Commit/merge status (2026-07-03):** committed on branch
> `feat/swift-ltx-video-director` (final commit `2e207c9`). **NOT merged into
> `main` yet** — awaiting merge/PR decision. Gemma work itself is done; the
> unmerged branch also carries the rest of the native-port milestone
> (T2I/VLM/audio/video-decode stages, TextEmbeddingProjection, the 48-layer
> LTX transformer).

The entire Gemma-3-12b text encoder is now native Swift/MLX and verified
end-to-end against the real production model. This was the last piece blocking
a fully-native distilled I2V path (everything else — VAEs, 48-layer LTX
transformer, sampling loop, full audio stack, T2I stage, VLM prompt stage,
TextEmbeddingProjection, Embeddings1DConnector — was already native).

## Verified path: text → hidden states, all native

| Step | Component | Verified against |
|------|-----------|------------------|
| text → token_ids | `GemmaTokenizer` (standalone SentencePiece-BPE) | **byte-identical** to mlx-lm tokenizer |
| token_ids → h0 | `GemmaEmbedding` (embed + sqrt scaling) | < 0.13% relative |
| h0 → h1 | `GemmaBlock` layer 0 (attn+RoPE+MLP+norms) | < 0.5% relative |
| h1 → h48 | `GemmaEncoder` (48 streaming blocks) | < 5% relative over full depth |
| RoPE isolation | `GemmaAttention` dual sliding/global configs | < 1e-4 |

Four parity tests, all passing: `GemmaTokenizerParityTests`,
`GemmaRoPEParityTests`, `GemmaLayer0ParityTests`, `GemmaFullEncoderParityTests`.
68/68 package tests green.

## The tokenizer resolution (the last piece)

Gemma uses SentencePiece-BPE, not Tiktoken. z-image-director's `BPETokenizer`
(Tiktoken-style: GPT-2 bytes_to_unicode + regex pretokenizer) produced wrong
token_ids. `GemmaTokenizer` is a standalone implementation parsing the HF
`tokenizer.json` directly, implementing the verified-correct algorithm:
1. split text on special tokens (`<start_of_turn>` etc.), preserving them
2. normalize: `" "` → `"▁"` (SentencePiece metaspace)
3. BPE: initial tokens = chars (byte_fallback → `<0xNN>` for unknown chars),
   greedily merge lowest-rank adjacent pair
4. prepend `<bos>` (Gemma `add_bos_token=True`, no eos)

## Two earlier bugs (documented for future porters)

1. **Wrong tolerance metric**: Gemma's residual stream is un-normalized between
   layers, so |h| grows to absmax ~10000 by layer 48. The original "diff 32"
   failure was 0.32% relative — use RELATIVE error (diff/absmax) for deep
   residual stacks, not absolute.
2. **fp32-vs-bf16 compute**: mlx-lm dequantizes 4-bit weights to **bfloat16**;
   an fp32 port diverges to 26% over the chaotic 48-layer residual stack.
   Match bf16 compute (also cast the attention mask to bf16 for sdpa promotion).

## Next: wire into the pipeline

The encode produces concatenated all-layer hidden states (B, T, 188160) →
`TextEmbeddingProjection` (native) → `Embeddings1DConnector` (native) → DiT
conditioning embeds. Wire `GemmaTokenizer` + `GemmaEncoder` +
`TextEmbeddingProjection` + `Embeddings1DConnector` into a native encode stage,
then retire `RunPyBridge` in `I2VCommand`. No Gemma Python remains.
