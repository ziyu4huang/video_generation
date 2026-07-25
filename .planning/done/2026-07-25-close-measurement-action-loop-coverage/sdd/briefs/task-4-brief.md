## Task 4: document the coverage axis in README

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/README.md` (add a Coverage subsection alongside the existing Savings / Miss-rate QA docs)

**Interfaces:** none (docs only).

- [ ] **Step 1: Read the existing QA docs section**

Read `bun-apps/pi-agent-ext-tool-gate/README.md` and locate where `qa/savings.ts` / `qa/miss-rate.ts` are documented (the QA / verification section). The new subsection mirrors their shape.

- [ ] **Step 2: Add the Coverage subsection**

Add a `### Coverage` subsection alongside the savings/miss-rate docs, with this content (adapt heading level to match neighbors):
```markdown
### Coverage (`qa/coverage.ts`)

A third QA axis — **structural completeness** — alongside savings (amount) and
miss-rate (recall). It answers: *which registered tools are heavy (≥ threshold
tok/req) but NOT tracked by any gate — i.e. candidates the author forgot to gate?*

A forgotten gate is safe (fail-open keeps the tool always-active) but silently
degrades savings. This check closes the loop: schema-cost measures → coverage
finds the ungated heavy → author adds a gate → savings confirms the recovery.

\`\`\`bash
bun run qa:coverage                       # standalone, advisory (never fails)
bun run qa:coverage --coverage-threshold 200   # tighten the threshold for a run
bun run qa                                # coverage reported, non-gating by default
bun run qa --strict                       # ungated heavy tools → FAIL
\`\`\`

Default threshold **300 tok/req** (`--coverage-threshold` overrides). Builtins
are excluded (they cannot be gated). The verdict is **non-gating by default**;
under `--strict`, any ungated heavy tool fails the gate.
```
(Use real triple-backticks, not the escaped `\`\`\`` shown above.)

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/README.md
git commit -m "docs(tool-gate): document the coverage QA axis"
```

---

## Verification (whole plan)

```bash
# unit + integration
( cd bun-apps/pi-agent-ext-tool-gate && bun test )

# the new QA standalone
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa:coverage

# full QA gate still passes (coverage is non-gating by default)
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa

# --strict surfaces coverage as a gate (should still pass if repo is fully gated)
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa --strict
```

**Success =** all tests green + `qa:coverage` runs and reports a stable `gatedHeavy` count + `bun run qa` unchanged (non-gating) + `qa --strict` still passes (repo currently fully gated; if not, that is a real finding to surface, not a test failure).

## Out of scope (do NOT implement in this plan)

- Usage-aware auto-tuning (gate by call frequency, not just schema cost) — stays fog.
- Power-tool runtime nudge message ("consider gating / lazy-loading") — decoupled follow-up.
- Eliminating the `/ 4` heuristic duplication between tool-gate's `measureToolTokens` and power-tool's `estimateTokens` — separate follow-up; coverage is immune (uses `buildSchemaCostReport`).
- Changing the core pipeline (`updateSticky`/`filterActive`/`gateFires`) or the fail-open + sticky contract.
