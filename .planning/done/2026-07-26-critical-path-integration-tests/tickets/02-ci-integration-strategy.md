claimed: work-through-session (2026-07-26)

## Question

How do the new integration tests run in CI? Two sub-decisions:

1. **superpowers isn't in the CI matrix** — there is no `test · pi-agent-ext-
   superpowers` job (only subagent/wayfind/etc. ran on PR #832). The superpowers
   suite (125 tests) currently runs only locally. Add it to the ci.yml matrix?
   (wayfind is already there — `test · pi-agent-ext-wayfind` ran + caught the
   biome format fail.)
2. **real-pi probe-runner tests in CI** — probe-runner spawns real pi + calls a
   model (cost / network / time, exactly the saturation that flaked the earlier
   `pi_verify --tier high`). Are those CI-gated, or local-smoke-only with a
   lighter buntest proxy standing in for CI?

Decide the CI surface so the test-writing tickets know what must pass in CI vs
what stays a local check. Independent of which paths get tested (01).

type: grilling

---

**Status: closed** — resolved in work-through session (2026-07-26).

## Resolution

Both sub-decisions resolved:

**(a) superpowers joins the CI matrix.** It is the only `pi-agent-ext-*`
absent (`grep -c pi-agent-ext-superpowers .github/workflows/ci.yml` = 0) yet has
full script parity with wayfind (`"test": "bun run check && bun run build &&
bun run test:unit"` + `biome.json`). Add one matrix line, mirroring wayfind
exactly: `- { package: pi-agent-ext-superpowers, test-cmd: "bun run test" }`.
This is a ready-to-execute one-liner (not yet applied); it would have caught
the kind of regression wayfind's job caught (the biome format fail on PR #832).

**(b) real-pi is local-smoke-only; CI gates on deterministic buntest.**
probe-runner real-pi tests (fix-loop cross-round, skill-exclude under real pi)
run **on-demand / locally** (like the SDD fix-loop smoke), NOT in CI. CI gates
only on the **deterministic buntest proxies**: golden-output for the [D] paths
(routing table, sdd-workspace PLAN_FILE derivation) + mocked assertions for
skill-exclude. Rationale: real-pi under CI load is documented-flaky (the 5000ms
`pi_verify --tier high` timeout); per-PR real-pi would block merges on flake.
Matches the lean fidelity choice.

**Implication for 03 / test-writing:** every integration test targets EITHER
"deterministic buntest (CI-gated)" OR "real-pi probe-runner (local-smoke)" —
the [D]/[L] tags from 01 map directly: [D] → buntest/CI; [L] → real-pi/local.
03 confirms the queue + per-path assertion pattern on top of this split.
