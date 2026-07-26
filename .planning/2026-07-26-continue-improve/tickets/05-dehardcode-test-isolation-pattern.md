---
type: grilling
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
