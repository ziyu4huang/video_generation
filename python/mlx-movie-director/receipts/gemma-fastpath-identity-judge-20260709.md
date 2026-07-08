# Receipt — gemma `reasoning_effort:"none"` fast path + identity-judge hardening

**Date:** 2026-07-09 · **Branch:** `feat/gemma-fastpath-identity-judge`
**Supersedes:** `receipts/storyboard-brain-hardening-20260708.md` (whose two
honest-negatives were built on a wrong knob — corrected here).

This is the Step-1 correction to PR #368. Both of #368's Step-1 honest-negatives
were disproven by direct measurement this cycle and are retired here.

## Premise 1 (WRONG → corrected): "gemma-4-26b is a thinking model; no fast decomp
brain is loaded."

The #366/#368 receipt used `enable_thinking:false` / `thinking` /
`chat_template_kwargs` — the WRONG knobs (LM Studio leaves `reasoning_content`
populated). The correct knob is **`reasoning_effort:"none"`** (OpenAI-style, which
LM Studio honors).

**Mechanism proof (localhost:1234, `google/gemma-4-26b-a4b-qat`):**
```
tiny JSON task: 0.29s, reasoning_content length 0, JSON parses cleanly
```

**`gemma_brain.decompose_story` change:** removed `_is_thinking_model` /
`_THINKING_MODEL_HINTS` name-guessing. Default path now sends
`reasoning_effort:"none"` + the small budget (2048) — the fast path — with ONE
defensive retry at the large budget (14000, no `reasoning_effort`) only when the
fast path produced no parseable JSON.

**Live certification (3-panel detective decomp):**
```
ELAPSED=40.4s PANELS=3   (fast path, single HTTP call, no retry)
```
~40s cold for the full `build_decompose_prompt` 3-panel decomp (<60s gate ✓; an
earlier optimistic 8.9s read was a warmer cache). Vs the **3-5min** thinking pass.
Gate **Step 1a certified**: decomposition runs via `reasoning_effort:"none"` on
gemma-4-26b, <60s. The "no fast brain loaded" negative is **retired**.

## Premise 2 (WRONG → corrected): "route the identity judge to Qwen3-VL."

The judge runs on the SAME local brain — **gemma-4-26b**. The #366 multi-image JSON
flakiness (1/4 parsed) was a prompt/parse/`reasoning_effort` problem, not a model
problem. Qwen3-VL unblock is **dropped**.

**Changes:**
- `image-storyboard.py`: `--identity-judge-model` default `qwen/qwen3-vl-4b` →
  `google/gemma-4-26b-a4b-qat`; `_resolve_identity_judge_model` resolves to gemma
  directly (no `qwen3-vl` token probe; falls back to `vlm_model`/brain resolver only
  if the configured id isn't loaded).
- `caption.py`: `_call_vlm_multi` gained a `reasoning_effort` kwarg.
- `image-profile.py`: `_vlm_verify_identity` sends `reasoning_effort:"none"` and
  hardens the parse via new `_parse_identity_json` (strict `json.loads` + balanced-
  `{...}` fallback that strips prose / ```json fences), with ONE retry on
  unparseable output.

**Live certification (4× multi-image identity judge, gemma-4-26b):**
```
call1: parsed=True same=True score=10 (1.8s)
call2: parsed=True same=True score=10 (0.9s)
call3: parsed=True same=True score=10 (1.0s)
call4: parsed=True same=True score=10 (1.0s)
PARSE_RATE=4/4     (was 1/4 in #366)
```
Same hero (t2i, seed 777) + i2i three-quarter variant (denoise 0.85, seed 1234) —
correctly judged same_identity. Gate **Step 1b certified**: identity judge on
gemma-4-26b (Qwen3-VL dropped), ≥3/4 verdicts → **4/4**. The negative is **retired**.

## Tests
- `app/tests/test_gemma_brain.py` rewritten (3 tests): fast-path sends
  `reasoning_effort:"none"` + small budget; no-JSON retry at large budget w/o
  reasoning_effort; reasoning_content fallback.
- `app/tests/test_identity_judge.py` (NEW, 5 tests): `_parse_identity_json` clean /
  dict / prose-fence-strip / rejects-missing-gate-key / rejects-unparseable.
- Full suite: **1177 passed, 35 skipped** (skips are GPU/model-dir gated).
- pyflakes clean on all changed files.

## Constraints (all held)
1. Generation = local MLX only ($0 cloud). 2. Brain = local gemma-4-26b on LM
   Studio (never a cloud LLM). 3. Vision = orchestrator calls the local VLM
   (`_vlm_verify_identity`), never its own native pixels. 4. Landed via PR SOP.
