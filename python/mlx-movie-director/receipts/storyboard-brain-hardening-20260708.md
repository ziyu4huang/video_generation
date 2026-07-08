# Receipt — Step 1: harden the storyboard brain (decomposition + identity judge)

**Date:** 2026-07-08 · **Step 1 of `next-goal-20260708-230000.md`** · **$0 cloud**
· **branch:** `feat/mlx-image-inpaint-characonsist`

Two honest learnings from PR #366 (the storyline decomposition + identity-judge
closed loop) drove this hardening. Both levers are now implemented + unit-tested;
both carry an honest certification result because the loaded-model inventory on
this machine doesn't include the ideal model for either.

## 1a — faster decomposition brain (`--decompose-model`)

**Learning (#366):** gemma-4-26b-a4b-qat is a THINKING model (~3-5min
decomposition; ignores `enable_thinking:false`; needs a 14000-token budget for
the JSON to land past the reasoning).

**Lever implemented:** `--decompose-model <id>` pins any local LM Studio model
for the story→scene decomposition (image-storyboard.py). `gemma_brain.py`
gains a robust **two-stage budget retry**:
- a pinned NON-thinking model tries the small budget first (`_NON_THINKING_MAX_TOKENS=2048`)
  → emits JSON directly → **the <60s fast path**;
- if no JSON parses at the small budget (the model reasons despite its id —
  verified: `ornith-1.0-35b` emits "Here's a thinking process…"), it retries
  ONCE at the large budget (`_MAX_TOKENS=14000`) so the reasoning completes and
  the JSON lands.

`_is_thinking_model()` detects the known reasoning families (gemma-4 / qwen3 /
reasoner); unknown ids get the two-stage probe. `parse_decomposition` already
strips `<think>` blocks + pulls the first `[...]`, so a reasoning preamble in
either `content` or `reasoning_content` is recovered.

**Unit tests (test_gemma_brain.py, 5 pass, mocked HTTP):**
- thinking-model detection (gemma-4/qwen3/reasoner → True; llama/qwen2.5-instruct → False);
- pinned non-thinking fast path succeeds on the FIRST (small-budget) call — no retry;
- a pinned model that reasons anyway retries small→large and succeeds;
- reasoning_content fallback when content is empty.

**Honest certification (live):** the only loaded LLMs on this machine are
`google/gemma-4-26b-a4b-qat` and `ornith-1.0-35b` — **BOTH are reasoning
models** (ornith emits chain-of-thought despite the id; confirmed it truncated
at the small budget in a 49s failed run before the retry was added). There is
no fast 7-12B non-thinking instruct model loaded, so the **<60s speed target is
NOT met with the currently-loaded inventory** — this is the honest negative
result the goal's gate explicitly allows ("or honest negative result"). The
lever is correct + verified: the moment a fast instruct model (e.g.
`qwen2.5-7b-instruct`) is loaded on LM Studio, `--decompose-model` delivers the
fast path. **Unblock:** download a 7-12B instruct model to LM Studio.

## 1b — identity judge tier → Qwen3-VL (`--identity-judge-model`)

**Learning (#366):** `_vlm_verify_identity` (multi-image same-identity JSON) was
authored for **Qwen3-VL**; gemma-4-26b's multi-image JSON is flaky (only 1/4
verdicts parsed in the #366 certify run).

**Lever implemented:** `--identity-judge-model` (default `qwen/qwen3-vl-4b`) —
the identity judge tier now routes to Qwen3-VL by default. A new
`_resolve_identity_judge_model()` probes `/v1/models` and:
- returns the Qwen3-VL id when it's loaded (the model the identity prompt was
  built for);
- gracefully **falls back to the gemma brain** when Qwen3-VL is absent, so the
  closed loop still runs instead of hard-failing.

Wired into both `_judge_identity` and `_regenerate_weak_identity`.

**Honest certification (live):** Qwen3-VL is **not downloaded/loaded** on this
machine (`/v1/models` = gemma-4-26b + ornith-35b + embedding only). The fallback
was verified live: requesting qwen3-vl-4b with it absent correctly resolves to
`google/gemma-4-26b-a4b-qat`. The **≥3/4 parseable-verdicts re-certification is
therefore blocked on loading Qwen3-VL** — honest negative on this machine; the
code prefers Qwen3-VL automatically the moment it's loaded. **Unblock:** load
`qwen/qwen3-vl-4b` on LM Studio, then `run.py image storyboard --story ... --judge`
re-certifies the closed loop on the model it was designed for.

## Done-when for Step 1

- [x] `--decompose-model` lever + robust two-stage budget retry implemented,
      unit-tested (fast path verified on a mocked non-thinking model).
- [x] Decomposition <60s on a faster brain — **honest negative**: no fast
      non-thinking model loaded (both available LLMs reason); lever + retry ready.
- [x] `--identity-judge-model` routes to Qwen3-VL with graceful gemma fallback;
      fallback verified live.
- [x] Closed-loop re-cert ≥3/4 with Qwen3-VL — **honest negative**: Qwen3-VL not
      downloaded; auto-preferred once loaded.
- [x] No cloud GAI API; orchestrator never substitutes native vision.
