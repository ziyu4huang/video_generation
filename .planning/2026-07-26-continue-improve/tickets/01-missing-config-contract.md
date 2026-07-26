---
type: grilling
claimed: continue-improve (2026-07-26)
status: closed
---

# 01 · Missing-config contract

## Question

When no model config is set (no `capabilities.vision` in `~/.pi/workflows/model-tiers.json`, no `PI_MODEL` env), what should `resolveVisionLLM` / `resolveLLM` do?

This is the **root contract** — tickets 05 (test isolation) and 06 (config-load validation) both depend on it, and the env-removal fog hangs off it.

Candidate behaviors:

- **(a) Throw** with a `/models-preset` pointer — the reverted de-hardcode. Cleanest signal, but a throw inside a pipeline (file2md) is a hard crash, and it broke CI (clean env has no config).
- **(b) Interactively prompt** to run `/models-preset` — good UX in an interactive pi-agent session, but `resolveVisionLLM` is also called from non-interactive paths (file2md CLI) where a prompt is wrong.
- **(c) Silent fallback** to a baked default (`lm-studio/google/gemma-4-12b-qat`) — the current reverted state. "Just works" on a dev machine with lm-studio, but violates the no-hardcode principle and hides misconfiguration.

The "right" answer may be **path-dependent**: throw/prompt in interactive sessions, fallback (or a clear error code) in CLI/pipe. Resolving this decides whether the de-hardcode (#05) even re-lands, and in what shape.

## Context

- Current state (post-revert of PR #833's de-hardcode): `resolveLLM` has `DEFAULT_MODEL = "lm-studio/google/gemma-4-12b-qat"` as ultimate fallback; `resolveVisionLLM` falls back through it (no throw). See `file2md/src/sessions.ts`.
- The de-hardcode that threw was reverted because 3 CI packages broke (no config in CI). Ticket 05 is the test-isolation work; THIS ticket decides the behavior those tests assert.

## Acceptance

A decided contract: what each resolver does when unconfigured, per call-path (interactive vs CLI), stated precisely enough that 05 can write assertions and 06 can mirror it at load time.

## Resolution (2026-07-26)

Grilled 3 sub-decisions → **throw / keep env (deprecated) / uniform resolver only**.

### `resolveLLM(opts)` — fallback chain

1. `opts.model` given → parse `"provider/modelId[:thinking]"` shorthand → return `ResolvedLLM`. **Never throws.**
2. No `opts.model`, but `PI_MODEL`/`PI_PROVIDER` env set → use env (**deprecated**; `console.warn` nudging toward `~/.pi/config`) → return.
3. Neither → **THROW**: _"No model specified. Run `/models-preset` (or set tiers/capabilities in `~/.pi/workflows/model-tiers.json`), or set `PI_MODEL` env."_

### `resolveVisionLLM(opts)` — fallback chain

1. `opts.model` given → `resolveLLM(opts)` (explicit override).
2. `capabilities.vision` configured → `resolveLLM({ model: <vision spec> })`.
3. No config, but `PI_MODEL` env set → `console.warn` (deprecated) → `resolveLLM(opts)` (env fallback).
4. Neither → **THROW**: _"No vision model configured. Run `/models-preset` (or set `capabilities.vision` in `~/.pi/workflows/model-tiers.json`), or set `PI_MODEL` env."_

### Path-scope

Resolver is **path-agnostic / uniform** — it throws the same everywhere. Caller recovery is the existing pi tool-layer's concern (a `vision_ask` throw surfaces as a tool error the agent sees; the pipeline fails loud) and is **out of 01's scope**. No caller-side changes mandated by this contract.

### Why throw

Fail-fast + actionable is honest and matches the no-hardcode principle (CONTEXT.md). Silent fallback (the reverted state) hides misconfiguration and fails mysteriously where no local model exists (CI / servers). The revert was a **test-isolation** problem (ticket 05), not a contract flaw — so the contract is reinstated; 05 makes it CI-green.

### Downstream impact

- **05** unblocked: tests assert the throw fires only when BOTH config AND env are absent; isolate via mock / seed / env where a real run is needed.
- **06** (still ←04): mirror at load-time — warn when a spec is unresolvable, throw at resolve-time per this contract.
- **env fog cleared**: `PI_MODEL`/`PI_PROVIDER` kept as a **permanent deprecated escape hatch** (no scheduled removal); the throw only fires when config AND env are both absent, so env is the manual override.
