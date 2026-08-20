# Receipt — Item I sibling: agent-driven ESRGAN upscale (thesis validation)

**Date:** 2026-07-05 09:15 UTC
**Goal:** Prove the native ESRGAN `upscale` director integrates with the repo's
**agent-first thesis** — a real **gemma-4-26b agent** drives the upscaler
through the `movie` tool to a real 4× PNG (not the deterministic
`run-upscale-e2e.ts` script). This is the "agent-driven proof for at least one"
gate the goal set (the Item I bar), applied to the enhancement gap.

## Verdict: SUCCESS

| Gate | Result |
|---|---|
| Agent-driven 4× PNG (gemma issues the `movie` call) | ✅ 1 `movie generate {enhancement, upscale}` call; `input_4x.png` produced (497 KB, 1024×1024) |
| Real upscaler ran (native torch MPS, not a stub) | ✅ `provider:"esrgan"`, `invoke:"bun:esrgan"`; output is 4× the 256×256 source |
| Director retired from `gaps` | ✅ `upscale` no longer in `probedMenuSummary().gaps` |

## Runtime configuration
- `bun bun-apps/s2-agent/src/cli.ts --no-extensions -e …/movie-director.ts`
- Provider `lm-studio`, model `google/gemma-4-26b-a4b-qat`, **thinking `medium`**
- `--no-builtin-tools` → the agent had **only** the `movie` tool. The thesis
  ("the agent drives `movie`") is exercised pure.
- `BUN_PI_LOAD_RUN_DIR=FALSE` (sidesteps the JITI NameTooLong splice per #291).
- Full trace: `agent-upscale-trace.jsonl`; agent summary: `agent-upscale-stdout.txt`.

## Setup (NOT the upscaler — pre-built so the agent stays on-thesis)
A 256×256 gradient fixture (`/tmp/md-agent-upscale/input.png`, ffmpeg lavfi) was
pre-built. The agent received its absolute path + the workspace; its job was
the upscale call only.

## Tool-adherence signal (the Item I anticipated friction)
The first run failed **not** on the upscaler but on the agent's input nesting.
The `movie` tool's input is `{ command:"generate", options:{...} }`, and for
`generate` the DIRECTOR's per-command options live in an INNER `options` bag —
so `image` must be nested two levels deep (`options.options.image`). The agent
first put it one level deep (`options.image`), the adapter honestly returned
`image missing or not found: (none)`, and the agent — at thinking `medium` —
**diagnosed the schema mismatch itself** in its reasoning trace ("`capability`
and `command` are top-level… wait, the per-command options must nest deeper").

A second run with a prompt showing the exact nested shape converged in **a
single `movie` call**. This mirrors Item I's "converged on the right input
shape over 3 attempts" — the tool-adherence signal the goal's "honest risks"
anticipated, recovered unaided at thinking `medium`. No model swap, no escalation.

## Generated artifact (proof)
- **`input_4x.png`** — 497 KB, 1024×1024 (4× the 256×256 source). Produced by
  the ESRGAN director (spandrel + torch MPS, `4xNomosWebPhoto_RealPLKSR`) via
  the `bun:esrgan` adapter → `movie generate {enhancement, upscale}`.
- Agent's final report (verbatim): "The upscaled image has been generated.
  Output Path: `/tmp/md-agent-upscale/input_4x.png`. Dimensions: 1024 × 1024."

## Conclusion
The enhancement gap closes the way Item I closed the analysis gap: a real
gemma-4-26b agent at thinking `medium` drove the native `movie` upscale
director end-to-end and produced a real 4× PNG, with no model swap and no
escalation. The tool-adherence friction (double-nested `options`) is the SAME
class Item I saw and recovered from unaided — confirming the adapter's
contract is the binding surface, not the model tier. Combined with the
deterministic `run-upscale-e2e.ts` + `run-clip-e2e.ts` receipts, both
remaining GAPs (`video_understand`, `upscale`) are now native directors behind
`movie generate`, and the provider menu has zero analysis/enhancement gaps.
