# Solution-Extension Simplification: wayfind ↔ superpowers full merge + archify relocation

- **Date:** 2026-08-16
- **Status:** Approved-in-principle (user locked: FULL MERGE dedup; RELOCATE architecture-render to archify)
- **Scope:** `bun-apps/pi-agent-ext-wayfind`, `bun-apps/pi-agent-ext-superpowers`, `bun-apps/pi-agent-ext-archify`
- **ADR citations:** ADR-wayfind-0003, ADR-wayfind-0004, ADR-superpowers-0008 (full IDs per repo rule — bare numbers banned)

---

## 1. Motivation

Two parallel methodology vocabularies exist today:

- **wayfind `skills/`** — 22 skills, 1,456 lines (verified: 22 dirs, `wc -l skills/*/SKILL.md` = 1,456)
- **superpowers `skills/`** — 14 skills

**10 wayfind skills re-express 8 superpowers skills** (grill family counted as one re-expression; router pair counted separately — see overlap map in §2b). Consequence: an agent may pick either router for debug/review/plan tasks, and we maintain two half-true versions of the same methodology.

Compounding `src/` hotspots in wayfind:

- `commands.ts` — 625 lines
- `effort-tool.ts` — 502 lines, mixing 5 concerns
- `architecture-render.ts` — 329 lines of docs tooling misplaced in an agent extension

**Supporting incident:** an orchestrator session saw subagent children fail on missing budgets. Proof that dispatch guardrails (budget/scope/tool-fit) must live in the **shared methodology layer** (superpowers), not inside one package (wayfind's `subagent-dispatch-discipline`).

---

## 2. Current state

### 2a. Solution-process spine

```
DECIDE   wayfind ~4.3k loc
         (/grill docs → CONTEXT.md+ADRs; /wayfind → .planning/<effort>/map.md + tickets/)
         → task_plan.md topo seed
DISCIPLINE superpowers ~350 loc
         (brainstorm→plan→TDD→debug→review, bootstrap injection)
EXECUTE   task ~24k (/goal cockpit, task_plan phases)
LABOR     subagent 7.5k / workflow 9.5k
SYNC      /wayfind sync closes tickets (reverse seam ADR-wayfind-0003)
SHIP      devops 6.2k / MEMORY hermes 30k
```

### 2b. Overlap map (10 wayfind skills re-express 8 superpowers skills)

```
grilling / grill-me / grill-me-with-docs  ↔  brainstorming
to-spec                                    ↔  brainstorming + writing-plans
to-tickets                                 ↔  writing-plans + subagent-driven-development
research                                   ↔  dispatching-parallel-agents
subagent-dispatch-discipline               ↔  dispatching-parallel-agents
code-review                                ↔  requesting-code-review / receiving-code-review
diagnosing-bugs                            ↔  systematic-debugging
prototype                                  ↔  brainstorming (prototype phase)
writing-for-agents                         ↔  writing-skills
ask-matt                                   ↔  using-superpowers   (routers)
```

**Wayfind-unique 12:** `codebase-design`, `domain-modeling`, `triage`, `teach`, `handoff`, `to-questionnaire`, `wizard`, `wait-what`, `improve-codebase-architecture`, `resolving-merge-conflicts`, + engine skills.

> Count note (verified against `ls skills/`): the map has 10 pair-rows spanning 12 wayfind skill dirs (the grill family is 3 dirs) and 9 distinct superpowers counterparts — 8 methodology skills + the `ask-matt ↔ using-superpowers` router pair. "10 re-express 8" counts the grill family once and treats the router pair as routing, not re-expression. The disposition table in §3 is the authoritative 22-dir accounting.

### 2c. Wayfind internals

```
extensions/wayfind.ts        32  static registration
src/commands.ts             625
src/effort-tool.ts          502  (5 concerns mixed)
src/effort-query.ts         391
src/wayfinder.ts            340
src/architecture-render.ts  329  (docs tooling, misplaced)
src/model.ts                320  (fs-free core — keep)
src/chain.ts                231
src/grill.ts                170
src/map.ts                  168

globalThis seams (no imports, ADR-wayfind-0004 — KEEP):
  __piPlan* (task), __piCoreTaskStatusWidget, __piHermesStaleCheck,
  webui:render, tool-gate GATE_DEFS
Only cross-pkg import: @repo/pi-agent-core-interface
```

Verified: all line counts match `wc -l`; external imports in `src/` are only `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@repo/pi-agent-core-interface`, `marked`, `typebox`, `node:*` — so `@repo/pi-agent-core-interface` is indeed the sole cross-package import.

---

## 3. Design — skill dedup (FULL MERGE)

**Principle:**

- **wayfind = pure decide/wayfinder ENGINE.** Artifact chain only: `CONTEXT.md → spec.md → tickets/ → task_plan.md`.
- **superpowers = single METHODOLOGY vocabulary.**

### 3.1 Disposition table (22 wayfind skills → 16 keep / 6 delete)

| # | Wayfind skill | Disposition | Target / note |
|---|---------------|-------------|---------------|
| 1 | `grilling` | KEEP as-is | engine |
| 2 | `grill-me` | KEEP as-is | engine |
| 3 | `grill-me-with-docs` | KEEP as-is | engine |
| 4 | `wait-what` | KEEP as-is | engine |
| 5 | `resolving-merge-conflicts` | KEEP as-is | unique |
| 6 | `handoff` | KEEP as-is | unique |
| 7 | `wizard` | KEEP as-is | unique |
| 8 | `to-questionnaire` | KEEP as-is | engine |
| 9 | `domain-modeling` | KEEP as-is | unique |
| 10 | `codebase-design` | KEEP as-is | unique |
| 11 | `improve-codebase-architecture` | KEEP as-is | unique |
| 12 | `triage` | KEEP as-is | unique |
| 13 | `teach` | KEEP as-is | unique |
| 14 | `to-spec` | KEEP trimmed | keep artifact contracts + chain wiring; defer interview/methodology prose to superpowers |
| 15 | `to-tickets` | KEEP trimmed | keep artifact contracts + chain wiring; defer interview/methodology prose to superpowers |
| 16 | `ask-matt` | KEEP trimmed | slim: routes wayfind family only; redirects methodology Qs to `using-superpowers` |
| 17 | `research` | DELETE → merge | → `dispatching-parallel-agents`; fold markdown-findings-artifact note |
| 18 | `prototype` | DELETE → merge | → `brainstorming`; pointer only |
| 19 | `subagent-dispatch-discipline` | DELETE → merge | MERGE budget/scope/tool-fit/tier guardrails + anti-patterns INTO `dispatching-parallel-agents` |
| 20 | `code-review` | DELETE → merge | → `requesting-code-review` + `receiving-code-review`; fold Standards-vs-Spec dual axis |
| 21 | `diagnosing-bugs` | DELETE → merge | → `systematic-debugging`; fold reproduction-loop engineering |
| 22 | `writing-for-agents` | DELETE → merge | → `writing-skills`; generalize to agent-consumed docs |

Totals: **DELETE 6 + KEEP as-is 13 + KEEP trimmed 3 = 22** ✓ (16 keep / 6 delete).

### 3.2 Migration

- `ask-matt` keeps **one-release redirect stubs** for the 6 deleted skills (name → superpowers counterpart).
- Update **ADR-superpowers-0008** interplay (`DEFAULT_SKILL_EXCLUDE` unchanged — verified at `pi-agent-ext-superpowers/src/superpowers.ts:46`: `["verification-before-completion", "using-superpowers"]`).
- Re-run the schema-cost canary after the merge (see §5 gates).

---

## 4. Design — src slimming

1. **Split `commands.ts` (625)** into per-command handler modules behind a thin dispatcher. Guards shared, not stacked per-handler.
2. **Extract from `effort-tool.ts` (502):** renderers + `webui:render` emit + hermes enrichment → separate modules; leave gate def + 5 actions.
3. **Relocate `architecture-render.ts` (329) + mermaid/tailwind vendoring → `pi-agent-ext-archify`** (typed-JSON-IR diagram package).
   - **[VERIFY → resolved] which wayfind commands import it:** none. Grep over `src/` + `extensions/` finds zero importers. Actual call sites:
     - `package.json` script: `"architecture:render": "bun run src/architecture-render.ts"` (CLI entry)
     - `tests/architecture-render.test.ts` and `tests/architecture-mermaid.test.ts` (import `renderReport`)
     - `scripts/vendor-mermaid.ts` (vendors `vendor/mermaid.min.js`)
     - `src/architecture-render.ts:312` reads `vendor/tailwind.css`
   - Because there are no in-package src importers, relocation needs **no src-level re-export for compat**; it must move the CLI script, the two test files (+ golden snapshots), and `vendor/mermaid.min.js` + `vendor/tailwind.css`. A compat `architecture:render` script alias in wayfind's `package.json` for one release is optional but recommended (see OPEN-1).
4. **Keep:** `model.ts` fs-free core, globalThis seams (ADR-wayfind-0004), static registration, `.planning/` state model.

---

## 5. Risks & gates

**Risks:**

| Risk | Mitigation |
|------|------------|
| Deleted-skill muscle memory | one-release redirect stubs in `ask-matt` |
| Archify relocation behavior drift | compat re-export / script alias; golden snapshots move with tests and must stay byte-identical |
| ADR citations must resolve | bare numbers banned; cite ADR-wayfind-NNNN / ADR-superpowers-NNNN |

**Gates:**

- wayfind: `bun run check && bun run typecheck && bun test` (biome is the `check`; tsc lives in `typecheck`)
- superpowers: `bun test`
- archify: its canonical test
- schema-cost canary: `bun-apps/pi-agent/src/cli/commands/schema-cost.ts` (path verified)
- `bun run test:adr` from `bun-apps/`

---

## 6. OPEN questions

1. **OPEN-1 — `architecture:render` compat surface:** after relocation, does archify expose the same CLI verb (`architecture:render`), or does wayfind keep a one-release script alias pointing at archify? No src importer blocks either choice; pick at implementation.
2. **OPEN-2 — golden snapshot ownership:** `tests/architecture-render.golden.html` moves to archify with the tests — confirm archify's snapshot/golden convention matches (byte-identical output is the acceptance bar).
3. **OPEN-3 — redirect-stub expiry:** "one release" needs a concrete wayfind release marker (see wayfind `docs/versioning.md`) to schedule stub deletion.

All [VERIFY] items from the drafting brief were resolved by grep (see §2c note, §3.2, §4.3); nothing remains unresolved.

---

## Appendix — verification log (2026-08-16)

| Claim | Check | Result |
|-------|-------|--------|
| wayfind 22 skills / 1,456 lines | `ls skills/ \| wc -l`; `wc -l skills/*/SKILL.md` | 22 / 1,456 ✓ |
| superpowers 14 skills | `ls skills/` | 14 ✓ |
| src line counts (625/502/391/340/329/320/231/170/168) | `wc -l src/*.ts` | all match ✓ |
| `extensions/wayfind.ts` = 32 static | `wc -l` | 32 ✓ |
| architecture-render importers | repo-wide grep | **zero src importers**; call sites = package.json CLI script, 2 test files, vendor script (§4.3) |
| mermaid/tailwind vendoring | `ls vendor/` | `mermaid.min.js`, `tailwind.css` ✓ |
| ADR-wayfind-0003 (reverse seam) | `docs/adr/0003-*.md` | exists; update records `/wayfind sync` closing tickets via `__piPlan*` from ext-task ✓ |
| ADR-wayfind-0004 (globalThis seams) | `docs/adr/0004-decouple-status-widget-via-global.md` | exists ✓ |
| ADR-0008 interplay | resolved to **ADR-superpowers-0008** `0008-default-skill-exclusion-policy.md`; `DEFAULT_SKILL_EXCLUDE` at `src/superpowers.ts:46` | ✓ |
| sole cross-pkg import | `grep -h "^import" src/*.ts` | only `@repo/pi-agent-core-interface` (rest are external pkgs + node) ✓ |
| schema-cost canary path | `ls bun-apps/pi-agent/src/cli/commands/schema-cost.ts` | exists ✓ |
| spine loc figures | spot `wc -l` | superpowers 347≈350 ✓; devops 6,250≈6.2k ✓; task+hermes 54,840 ≈ 24k+30k ✓; wayfind/src 3,938 (+ext/scripts) ≈4.3k ✓ |
| disposition sums to 22 | §3.1 totals | 6+13+3=22 ✓ |
