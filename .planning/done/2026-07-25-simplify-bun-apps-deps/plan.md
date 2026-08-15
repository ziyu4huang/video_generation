# Simplify bun-apps deps + unify .superpowers/ → .planning/ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant/unused deps from 5 extension packages and unify every `.superpowers/` artifact path under `.planning/<effort>/`, with the wayfind↔superpowers boundary documented.

**Architecture:** Two independent workstreams. W1 = `package.json` dependency trimming (verified import-free). W2 = make the SDD + brainstorm helper scripts effort-aware (`.planning/<effort>/` when `PI_PLANNING_EFFORT` is set, backward-compatible fallback otherwise), align the bootstrap override, gitignore, and document the boundary. Scripts are NOT ADR-0004-protected (only `SKILL.md` is) so they may be patched.

**Tech Stack:** Bun workspace, bash helper scripts, pi extension bootstrap (`src/superpowers.ts`), `bun:test`.

## Global Constraints

- **ADR-0004:** never edit any `SKILL.md` under `pi-agent-ext-superpowers/skills/**` (fidelity-pinned by `tests/skills-fidelity.test.ts`). Scripts and `src/*.ts` are OK.
- **Backward compat:** every script patch falls back to the original `.superpowers/` behavior when no effort is provided (arg `$1` or `$PI_PLANNING_EFFORT`).
- **Bootstrap test tokens:** `piBoundaryOverrides()` rule 3 must still contain `SDD workspace override`, `.superpowers/sdd/`, `.planning/<effort>/sdd/progress.md`, `sdd-workspace` (asserted by `tests/bootstrap.test.ts`).
- Shell discipline: never top-level `cd`; use `( cd … && … )` or absolute paths.
- English for all written artifacts; commit messages conventional.

---

## Task 1 — W1: trim dependencies in 5 packages

**Files (all `package.json`):**
- `bun-apps/pi-agent-ext-ltx/package.json` — `dependencies`: remove `@earendil-works/pi-coding-agent`, `typebox` → `{}`
- `bun-apps/pi-agent-ext-movie-director/package.json` — `dependencies`: remove `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`
- `bun-apps/pi-agent-ext-flux2/package.json` — `dependencies`: remove `@earendil-works/pi-agent-core`
- `bun-apps/pi-agent-ext-krea2/package.json` — `dependencies`: remove `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core` → `{}`
- `bun-apps/pi-agent-ext-power-tool/package.json` — `dependencies`: remove `@earendil-works/pi-tui`

Each removal was re-verified: the specifier appears in zero source files (incl. type-only imports). `peerDependencies` are left untouched.

- [ ] Step 1: edit the 5 `package.json` files (exact edits above)
- [ ] Step 2: `( cd bun-apps && bun install )` — expect clean install, smaller `bun.lock`
- [ ] Step 3: `for p in ltx movie-director flux2 krea2 power-tool; do ( cd bun-apps/pi-agent-ext-$p && bun test ) || break; done` — all green
- [ ] Step 4: `bun test bun-apps/pi-agent/src/__tests__/extension-contract.test.ts` — green (every extension still loads)
- [ ] Step 5: commit `refactor(deps): drop redundant/unused host deps from 5 ext packages`

## Task 2 — W2a: wayfind devDep consistency

**Files:** `bun-apps/pi-agent-ext-wayfind/package.json`
- [ ] Step 1: add `"@types/bun": "^1.3.14"` to `devDependencies` (mirror superpowers)
- [ ] Step 2: `( cd bun-apps/pi-agent-ext-wayfind && bun test )` — green
- [ ] Step 3: commit with Task 3 or standalone `chore(wayfind): add @types/bun devDep`

## Task 3 — W2b: patch `sdd-workspace` to be effort-aware

**Files:** `bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/scripts/sdd-workspace`
- Resolve `EFFORT="${1:-${PI_PLANNING_EFFORT:-}}"`.
- If `EFFORT` non-empty → `dir="$root/.planning/$EFFORT/sdd"`; else `dir="$root/.superpowers/sdd"` (fallback).
- When using `.planning/`, do NOT write the blanket `*\n` `.gitignore` (planning sdd briefs/reports/reviews are committed; only `progress.md` is transient and already ignored by repo `.gitignore`). Keep writing the self-ignore only in the `.superpowers/` fallback path.
- `task-brief` / `review-package`: unchanged (delegate to `sdd-workspace`, pick up env).

- [ ] Step 1: edit `sdd-workspace`
- [ ] Step 2: verify fallback — `bash …/sdd-workspace` (no env) prints `<repo>/.superpowers/sdd` and writes its `.gitignore`
- [ ] Step 3: verify effort path — `PI_PLANNING_EFFORT=test-effort bash …/sdd-workspace` prints `<repo>/.planning/test-effort/sdd`, no blanket gitignore written, dir created
- [ ] Step 4: verify delegation — `PI_PLANNING_EFFORT=test-effort bash …/task-brief <some-plan.md> 1` writes brief under `.planning/test-effort/sdd/`
- [ ] Step 5: clean up the test-effort dirs; commit `feat(superpowers): sdd-workspace resolves under .planning/<effort>/ when effort set`

## Task 4 — W2c: patch `start-server.sh` brainstorm root

**Files:** `bun-apps/pi-agent-ext-superpowers/skills/brainstorming/scripts/start-server.sh`
- Compute `BRAINSTORM_BASE`: if `$PI_PLANNING_EFFORT` set → `$root/.planning/$PI_PLANNING_EFFORT/brainstorm`; else `${PROJECT_DIR}/.superpowers/brainstorm` (current behavior; `$root` derived when effort set, PROJECT_DIR ignored in that branch).
- `SESSION_DIR`, `BRAINSTORM_PORT_FILE`, `BRAINSTORM_TOKEN_FILE` all root under `BRAINSTORM_BASE`.

- [ ] Step 1: edit `start-server.sh` (the 3 path lines + base resolution)
- [ ] Step 2: dry check — read the changed lines; confirm no-op when `PI_PLANNING_EFFORT` unset (logic path unchanged)
- [ ] Step 3: commit `feat(superpowers): brainstorm server roots under .planning/<effort>/ when effort set`

## Task 5 — W2d: bootstrap rule 3 reword + rule 4 (TDD)

**Files:**
- Test: `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts`
- Source: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` (`piBoundaryOverrides()`)

- [ ] Step 1: add failing test asserting rule 4 — payload contains `brainstorm` convergence + `.planning/<effort>/brainstorm/` + `PI_PLANNING_EFFORT`. Keep all existing assertions.
- [ ] Step 2: run `bun test …/bootstrap.test.ts` — expect the new assertion FAIL
- [ ] Step 3: update `piBoundaryOverrides()` — reword rule 3 (sdd-workspace now pi-aware; preserve tokens), add rule 4 (brainstorm: export `PI_PLANNING_EFFORT` before `start-server.sh`)
- [ ] Step 4: run `bun test …/bootstrap.test.ts` — all green
- [ ] Step 5: run `bun test` (whole superpowers package) + `skills-fidelity.test.ts` — green
- [ ] Step 6: commit `feat(superpowers): bootstrap rule 4 — brainstorm convergence under .planning/`

## Task 6 — W2e: `.gitignore` defense-in-depth

**Files:** `.gitignore`
- [ ] Step 1: add `.superpowers/` (with a one-line comment: legacy fallback scratch, now routed under .planning/ when effort set)
- [ ] Step 2: commit `chore: gitignore legacy .superpowers/ scratch`

## Task 7 — W2f: boundary section in dep-tree PRD

**Files:** `bun-apps/pi-agent/docs/extension-dependency-tree.PRD.md`
- Append a "wayfind ↔ superpowers boundary" section: parallel coexistence, entry-path routing, spec-output ownership, dev/runtime split table, `.planning/` unification map (specs/plans/tickets/map/sdd/brainstorm — no exception), and the `PI_PLANNING_EFFORT` knob.
- [ ] Step 1: append section
- [ ] Step 2: commit `docs(pi-agent): document wayfind↔superpowers boundary + .planning unification`

## Final verification

- [ ] `( cd bun-apps && bun install )` clean
- [ ] `bun test` green in: ltx, movie-director, flux2, krea2, power-tool, wayfind, superpowers
- [ ] `bun test bun-apps/pi-agent/src/__tests__/extension-contract.test.ts` green
- [ ] `bash bun-apps/pi-agent/run-test.sh high` green (bundle/snapshot/standalone smoke)
- [ ] `grep -rn "\.superpowers/" bun-apps/pi-agent-ext-superpowers/{skills,src}` — only the deliberate fallback references remain (scripts + verbatim SKILL.md + override descriptions)
