# Ticket 02 — pre-wire a non-reasoning vision model id in the provider catalog

- **Engineer:** task
- **Depends on:** none
- **Status:** closed

## Context

Verified on this LM Studio `:1234`: the only working vision model is `qwen/qwen3.8-27b`, and it
is **always-on-reasoning** — every client thinking-disable parameter is ignored
(`chat_template_kwargs.enable_thinking=false`, top-level `enable_thinking=false`,
`reasoning={effort:none}` all still burn 49–183 reasoning tokens even for a trivial ask). The
`reasoning:false` catalog flag is host metadata; the pi-ai adapter only emits a disable signal
inside branches gated on `model.reasoning` (`openai-completions.js:564-661`), so a
`reasoning:false` entry makes pi *treat* the model as non-reasoning but sends **no** disable
instruction and the server keeps thinking ON. No genuinely non-reasoning vision model is
installed (gemma-4-12b is also always-on-reasoning *and* fails to load on this machine).

So the catalog-change is a **pre-wire**, not a live fix: register the sibling id and wire
`capabilities.vision` to prefer it, so the moment a non-reasoning VLM is loaded, file2md uses it
and the server stops burning reasoning tokens — without breaking the working qwen fallback.

## Done-when

- [ ] `bun-apps/s2-agent/src/pre-load-providers.ts` §1 `lm-studio.models[]` gains a sibling
      vision entry with `reasoning: false` and `input: ["text","image"]` (registry-only change;
      the `HOW TO ADD A PROVIDER` contract — no other file changes, `--list-models` reflects it).
- [ ] The default `DEFAULT_MODEL_TIER_CONFIG` / `capabilities.vision` docs + a code comment state
      the intended target (prefer the non-reasoning id when available; the working
      `qwen/qwen3.8-27b` stays the fallback).
- [ ] `bun-apps/s2-agent/src/pre-load-providers.test.ts` (the existing multimodal assertion) adds
      a case asserting the sibling id: `reasoning:false`, `input` includes `image`.
- [ ] `bun run test` / `check` / `typecheck` in the touched packages stay green.

## Scope / verification

This is catalog + tests only. The live verification ("does it stop burning reasoning?") is
**Fog of war** — it only answers when a non-reasoning VLM is actually installed. The ticket
ships the mechanism and the assertion, not the model.

## Notes

- Do **not** claim the sibling id disables thinking today. It pre-wires the selection; a
  non-reasoning model is the prerequisite (see map Fog of war). `capabilities.vision` should
  still fall back to the working id.
