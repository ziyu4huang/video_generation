> Archived 2026-08-16: design approved but never executed (superseded by inactivity). Resurrectable — copy back to .planning/ top level to re-prioritize.

# Spec — Simplify bun-apps dependencies + wayfind↔superpowers boundary

- **Effort:** `2026-07-25-simplify-bun-apps-deps`
- **Status:** design approved (all sub-decisions resolved)
- **Companion doc:** [`bun-apps/pi-agent/docs/extension-dependency-tree.PRD.md`](../../../bun-apps/pi-agent/docs/extension-dependency-tree.PRD.md) (already written; §7 records the observed debt this effort resolves)

## Problem

The `bun-apps/` workspace has two classes of unnecessary dependency and one
under-documented architectural boundary:

1. **Redundant / unused host dependencies** in 5 extension packages — declared
   but never imported (dead weight) or listed in both `dependencies` and
   `peerDependencies` (redundant, inconsistent with siblings).
2. **wayfind ↔ superpowers** — the relationship reads as a chain
   ("wayfinder → superpowers") but is in fact a *parallel coexistence*
   (ADR-0005). The boundary is designed but scattered across 4+ docs, and the
   `.planning/` artifact-home unification has one undocumented leak
   (`.superpowers/brainstorm/`), which is also not gitignored.

This effort resolves both, low-risk, and documents the boundary once.

## Non-goals

- No restructuring of the `pi-agent-ext-*` package set (no merges/splits).
- No moving `dependencies` → `peerDependencies` wholesale for packages with no
  existing peer section (e.g. `power-tool` stays deps-based; only its unused
  `pi-tui` is removed).
- No patching of upstream-verbatim skill bodies or scripts (ADR-0004).
- No change to runtime behavior of any extension.

## Workstream 1 — Dependency safe-cleanup (5 packages)

Every removal below was **re-verified by grepping the package source for the
specifier** (including type-only imports, which still contain the string). Each
"keep" was confirmed imported.

| Package | Remove from `dependencies` | Why | `dependencies` after |
|---------|-----------------------------|-----|----------------------|
| `pi-agent-ext-ltx` | `@earendil-works/pi-coding-agent`, `typebox` | both also in `peerDependencies` → redundant (siblings are peer-only) | `{}` |
| `pi-agent-ext-movie-director` | `@earendil-works/pi-ai` (unused), `@earendil-works/pi-coding-agent` + `typebox` (redundant w/ peer) | no import of `pi-ai`; pca/typebox already peers | keeps `flux2, krea2, ltx, workflow, ajv, ajv-formats, msedge-tts, yaml` |
| `pi-agent-ext-flux2` | `@earendil-works/pi-agent-core` | no import (uses `pi-ai` + `pi-coding-agent` only) | keeps `pi-ai, file2md` |
| `pi-agent-ext-krea2` | `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core` | neither imported (uses `pi-coding-agent` + `typebox` only) | `{}` |
| `pi-agent-ext-power-tool` | `@earendil-works/pi-tui` | no import (uses `pi-coding-agent` + `typebox`) | keeps `pi-coding-agent, @playwright/cli, js-yaml, typebox` |

**Not touched (intentional):** `pi-agent`'s 5 declared workspace deps — these
are runtime-loaded extensions (relative imports in `static-extensions.ts` +
`run-dir/manifest.json`), not `import "@repo/…"`. Removing them breaks the
bundle. (False-positive of the grep audit; documented in dep-tree PRD §6.)

## Workstream 2 — wayfind ↔ superpowers (keep two packages)

Direction approved: **keep the two packages** (ADR-0005 parallel coexistence is
correct). Cleanup + documentation only.

### W2a — devDependency consistency (already satisfied, no change)
- `pi-agent-ext-wayfind/package.json` **already** declares `"@types/bun": "^1.3.14"`
  in `devDependencies` (verified in HEAD) — mirroring `superpowers`. The initial
  audit flagged it as missing; re-check corrected that. No edit needed; both
  methodology packages now read identically on the dev/runtime split.

### W2b — patch SDD path script (`.superpowers/sdd/` → `.planning/<effort>/sdd/`)
`skills/subagent-driven-development/scripts/sdd-workspace` is the single source
of truth for the SDD dir; `task-brief` + `review-package` delegate to it.
Scripts are NOT ADR-0004-protected (only `SKILL.md` is), so patch directly:
- Resolve effort from `$1` arg, else `$PI_PLANNING_EFFORT` env.
- `dir="$root/.planning/$EFFORT/sdd"` when effort known; **fallback**
  `$root/.superpowers/sdd` when neither is set (upstream-compatible).
- Drop the blanket `*\n` self-gitignore it writes — `.planning/<effort>/sdd/`
  briefs/reports/reviews are COMMITTED (repo `.gitignore` §"Planning
  artifacts"); only `progress.md` stays transient (already ignored by name).
- `task-brief` / `review-package`: NO change — they call `sdd-workspace`, which
  picks up the env. (They remain backward-compatible.)

### W2c — patch brainstorm server script (`.superpowers/brainstorm/` → `.planning/<effort>/brainstorm/`)
`skills/brainstorming/scripts/start-server.sh` hardcodes
`SESSION_DIR="${PROJECT_DIR}/.superpowers/brainstorm/${SESSION_ID}"` (+ port/token
files). Patch: when `$PI_PLANNING_EFFORT` is set, root under
`$root/.planning/$PI_PLANNING_EFFORT/brainstorm/$SESSION_ID` instead; else keep
current behavior. Brainstorm mockups stay transient scratch (gitignored).

### W2d — align bootstrap overrides (`src/superpowers.ts` `piBoundaryOverrides()`)
- Rule 3: update wording — `sdd-workspace` is now pi-aware (reads
  `PI_PLANNING_EFFORT`); the agent exports the effort, then may call the script
  or inline. **Preserve test-asserted tokens**: `SDD workspace override`,
  `.superpowers/sdd/`, `.planning/<effort>/sdd/progress.md`, `sdd-workspace`.
- Add rule 4: brainstorm convergence — set `PI_PLANNING_EFFORT` before starting
  the visual companion so mockups land under `.planning/<effort>/brainstorm/`.
- TDD gate: extend `tests/bootstrap.test.ts` to assert rule 4 BEFORE implementing
  (failing test → implement → green); keep all existing rule-1/2/3 assertions.

### W2e — `.gitignore` defense-in-depth
Add `.superpowers/` to repo `.gitignore` (catches any path that still slips).

### W2f — boundary section in dep-tree PRD
Append to `bun-apps/pi-agent/docs/extension-dependency-tree.PRD.md`: parallel
coexistence; entry-path routing; spec-output ownership; dev/runtime split;
`.planning/` unification map (now including sdd + brainstorm — **no exception**).

## Verification

Per change, run from repo root:

```bash
# 1. lockfile reflects the removed deps
( cd bun-apps && bun install )

# 2. each edited package still typechecks/tests clean
for p in ltx movie-director flux2 krea2 power-tool wayfind; do
  ( cd bun-apps/pi-agent-ext-$p && bun test )
done

# 3. authoritative: every registered extension still loads + wires
bun test bun-apps/pi-agent/src/__tests__/extension-contract.test.ts

# 4. e2e (bundle/snapshot/standalone smoke)
bash bun-apps/pi-agent/run-test.sh high
```

Pass criteria: `bun install` succeeds with a smaller `bun.lock`; all package
tests green; `extension-contract.test.ts` green; `run-test.sh high` green.

## Rollback

Changes span: 6 `package.json` edits (W1 ×5 + W2a), 2 shell-script patches
(W2b, W2c), one bootstrap-prompt rewrite + test (W2d), one `.gitignore` line
(W2e), and one doc section (W2f). All are source edits — `git revert` the
effort commit(s) restores prior state. No data migration, no runtime state,
and the script patches are backward-compatible (fallback to `.superpowers/`
when no effort is provided).
