---
type: grilling
status: closed
blocked by:
  - 01-missing-config-contract
---

# 05 · De-hardcode test-isolation pattern

## Question

Which test-isolation pattern re-lands the de-hardcode (removing `DEFAULT_MODEL`) **CI-green**? The reverted de-hardcode made `resolveVisionLLM` throw when unconfigured, breaking 3 CI packages because CI is a clean env (no `~/.pi` config):

- `pi-agent-ext-file2md/__tests__/pipeline.test.ts` (real pipeline → resolveVisionLLM)
- `pi-agent-cli/src/__tests__/e2e/misc.e2e.test.ts` (runs `file2md -- -tricky.pdf`)
- a `pi-agent` test (typecheck/test path)

## Candidate patterns

- **(a) Per-test `mock.module(sessions.ts → {resolveVisionLLM, resolveLLM})`** — realm-safe; already used by `vlm-ask-tool`/`ask-io`/`classify-vlm` tests. Best for the file2md pipeline test.
- **(b) Shared `beforeAll` seeding** — `saveModelTierConfig({capabilities:{vision:...}})` into a temp HOME. **Caveat**: bun `mock.module` realm isolation — if the test mocks `vision-inference`, the mocked realm gets a SEPARATE `model-role-config` instance that can't see the seeded config. So (b) only works for NON-mocked tests; mocked ones need (a).
- **(c) `PI_MODEL` env** for subprocess/e2e tests (the misc.e2e spawn) — lets resolveVisionLLM fall through to env.

Likely a **mix**: (a) for mocked pipeline tests, (c) for the e2e subprocess. The pi-agent test needs its own diagnosis (was it a transitive resolve, or a typecheck? — re-confirm after 01).

## Dependency

**Blocked by 01**: the tests must ASSERT the contract chosen in 01 (throw / prompt / fallback). You can't write the assertions until the behavior is decided. Also consumes ticket 02's audit — if 02 finds more hardcodes, this ticket's scope grows.

## Acceptance

A decided isolation pattern per affected test + the de-hardcode re-landed (resolveLLM/resolveVisionLLM honoring contract 01, no `DEFAULT_MODEL`), all three packages green on clean CI.

## Resolution (2026-07-26)

**De-hardcode re-landed per contract 01; all 3 packages green on clean CI** (file2md 173, pi-agent-cli 361, pi-agent 310; all run with clean HOME + no PI_MODEL).

### Code — no hardcoded model ids remain in the file2md cluster
- `sessions.ts` `resolveLLM`: removed `DEFAULT_MODEL`; **throws** `No model configured` (actionable `/models-preset` pointer) when no opt + no env. `PI_MODEL` env stays the permanent deprecated escape (warns).
- `sessions.ts` `resolveVisionLLM`: fall-through cleaned — no config → `resolveLLM` (env-or-throw).
- `pipeline.ts`: removed `DEFAULT_VLM_MODEL`.
- `extensions/file2md.ts` + `pi-agent-cli/commands/file2md.ts`: removed `?? DEFAULT_VLM_MODEL` (+ CLI help text). Callers pass `params.model ?? PI_MODEL` (undefined → resolver handles config/env/throw).

### Isolation patterns (the ticket's core question)
- **(a) `mock.module(sessions → {resolveVisionLLM, resolveLLM})`** for the mocked-vision-inference I/O tests (`classify-vlm`, `ask-io`, `vlm-ask-tool`) + `pipeline.test.ts` — stable fake target, realm-safe.
- **(c) `PI_MODEL` env** for `misc.e2e` subprocess (`runCli([...], {env:{PI_MODEL}})`) — model resolution precedes the input-existence check, so the subprocess needs a model to reach the "Input not found" assertion.
- **`--isolate`** added to file2md's runner (package.json `test` script + CI matrix, mirroring `pi-agent-ext-archify`): the new sessions mock would otherwise leak into `sessions.test.ts` / `resolve-vision-llm.test.ts` (which need the REAL resolver) — `mock.module` is realm-scoped only under per-file isolation. (bunfig `isolate` key is NOT supported; the CLI flag / matrix `test-cmd` is the mechanism.)
- **`sessions.test.ts`**: "defaults" test → asserts the throw; thinking tests → provide `PI_MODEL` (a model is now required).
- **`resolve-vision-llm.test.ts`**: added the contract tests (throws when unconfigured; `PI_MODEL` env escape works).

### The "pi-agent test" (3rd package from #833)
Non-issue: pi-agent tests are unaffected (310 pass, typecheck clean). The #833 breakage was the transitive `resolveVisionLLM` throw, now handled by file2md-internal isolation. No pi-agent change needed.
