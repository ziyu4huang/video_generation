# Caption + Self-Debug Generation — Plan

Goal: add LLM-driven image captioning and a self-debugging generation loop to
the **pure-Swift** `zimage` binary (no Python runtime). Mirrors `run.py caption`
+ the twosubject best-of-N / VLM-revise loop, but runs entirely in Swift.

## Why

User reports generated images look "bad". Root cause is NOT a port bug (parity
benchmark = 0.99995 at 4 steps). The real causes:

1. **Too few steps** — Z-Image turbo defaults to 4 steps, but high-detail prompts
   (complex-girl) need **step 9** for the non-turbo quality tier. Different
   models have different optimal step counts.
2. **No prompt enhancement** — raw user prompts skip the VLM/Gemma enrichment
   that `run.py`'s video pipeline applies (`_enhance_prompt`).

Both are fixable in pure Swift via a local OpenAI-compatible LLM (LM Studio).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  zimage caption <img> --style t2i|score|review|...       │  ← URLSession
│     → POST localhost:1234/v1/chat/completions            │
│     → <img>.caption.json                                 │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  zimage enhance "raw prompt"                             │  ← text-only LLM
│     → richer t2i prompt (Gemma/Qwen text model)          │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  zimage t2i --auto-debug  (the self-debug loop)          │
│   for round in 1..N:                                      │
│     for seed in 1..candidates:                           │
│       img = generate(enhanced_prompt, seed)              │
│       score = caption(img, style=score) → JSON           │
│       track best                                          │
│     if best.score.overall >= min_overall: break          │
│     else: diagnosis = caption(best, style=review)         │
│           enhanced_prompt = llm_rewrite(prompt, diagnos) │
└─────────────────────────────────────────────────────────┘
```

## Tasks

### 1. VLM HTTP client (`Sources/ZImageDirector/VLMClient.swift`)
- `VLMClient(apiURL:model:)` — `URLSession` POST to `/chat/completions`.
- `caption(imageURL:prompt:maxTokens:)` — JPEG → base64 → OpenAI vision payload.
- `complete(text:)` — plain text completion (for prompt enhancement).
- Strip `<think>...</think>` blocks (Qwen3/Gemma-4 reasoning).
- Defaults: `http://localhost:1234/v1`, `qwen/qwen3-vl-4b`.
- Image downscale to 1024px max (VLMs don't need bigger), JPEG quality 85.

### 2. Caption styles (`Sources/ZImageDirector/CaptionStyles.swift`)
- Port `_STYLE_PROMPTS` dict from `caption.py` (t2i, photography, score,
  review, style, profile, ltx_i2v, ...).
- `--lang en|zh` support (the `_LANG_INSTRUCTIONS` block).

### 3. `zimage caption <image>` subcommand
- `--style` (multi), `--api-url`, `--model`, `--lang`, `--output`.
- Output `<image>.caption.json` (mirrors Python multi-style cache format).

### 4. `zimage enhance <prompt>` subcommand
- Text-only LLM call → enriched t2i prompt.
- Template: "rewrite this into a detailed t2i prompt: ...".

### 5. Per-model step defaults (`Sources/ZImageDirector/ModelDefaults.swift`)
- moody-pro-mix (turbo): 4 steps (fast) / 9 steps (quality).
- Other variants: read from a known-good table or `--steps` override.
- `--quality fast|balanced|high` flag → maps to step count.

### 6. Self-debug generate loop (`zimage t2i --auto-debug`)
- `--candidates N` (best-of-N seeds), `--rounds N`, `--min-overall 8.0`.
- Generate → score (VLM) → if below threshold, diagnose + rewrite prompt.
- Save best image + a debug JSON (scores per candidate, rewrites applied).

## Key references (Python source of truth)
- `app/commands/caption.py` — `_call_vlm`, `_STYLE_PROMPTS`, `_DEFECT_BLOCK`.
- `app/commands/image-twosubject.py` — best-of-N + rounds + min-overall loop.
- `app/commands/video-generate.py:_enhance_prompt` — Gemma prompt enrichment.
- Defaults: `_DEFAULT_API_URL = http://localhost:1234/v1`, `_DEFAULT_MODEL = qwen/qwen3-vl-4b`.

## Verification
- `zimage caption <known-image>` output matches `run.py caption` text closely.
- `zimage t2i --auto-debug --self-test complex-girl` produces a higher-scoring
  image than plain `zimage t2i --self-test complex-girl`.
