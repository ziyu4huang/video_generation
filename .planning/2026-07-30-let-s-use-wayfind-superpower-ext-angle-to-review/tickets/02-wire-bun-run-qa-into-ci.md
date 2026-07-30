## Question

Wire `bun run qa` (savings + coverage) into CI so savings/coverage regressions
are caught automatically — today the QA harness exists and encodes its verdict
(`SAVINGS_FLOOR`, `taskBreakingGates` strict logic in `qa/run.ts` +
`qa/evaluate.ts`) but runs only on demand; nothing enforces it.

**Shape decision (small, inline):** a new determinism-style CI job (e.g.
`qa · pi-agent-ext-tool-gate`) running `qa:savings` + `qa:coverage` with the
encoded thresholds, OR extend the existing `regression gates` bucket. Prefer the
dedicated job (mirrors the `determinism · <pkg>` pattern) so a qa failure is
legible on its own line, not buried in regression-gates.

**Deliverable:** a CI step + the package wired so `bun run qa` is the gate; a
green run on the PR that adds it. Note the live `--l2` tier stays opt-in (needs a
model) — only the deterministic tier (`qa:savings` + `qa:coverage`) is the CI
gate, matching the prior QA's "deterministic verified, live armed" split.

**type:** task
**claimed:** wayfind-session (2026-07-30) — ✅ CLOSED

## Resolution — done: tool-gate in the CI matrix + the qa gate

Added `pi-agent-ext-tool-gate` to the `tests` matrix — it was **missing entirely** (its 8 test files never ran in CI) — with `test-cmd: "bun test && bun run qa"`. The entry runs the unit tests **and** the encoded QA verdict (`qa/run.ts`: savings floor ≥15%+2k ∧ L1 intended-behavior; exits non-zero on regression), gated by `changed_packages` like every matrix entry. Live A/B (`--l2 --model`) stays opt-in (needs a model); only the deterministic tier is the CI gate. **Also fixed a test-hermeticity gap** surfaced by this work: the telemetry-emit test was non-hermetic to `TOOL_GATE_LOG_PATH` (the live harness exports it → `emitToolGateLog` writes a file, not stderr → flake); added a `beforeEach`/`afterEach` snapshot/delete/restore (matching hermes `config.test.ts` PR #938). Verified: `bun test` 222/0, `bun run qa` PASS.
