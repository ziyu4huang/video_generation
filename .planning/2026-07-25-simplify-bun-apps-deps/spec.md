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

### W2a — devDependency consistency
- `pi-agent-ext-wayfind/package.json`: add `"@types/bun": "^1.3.14"` to
  `devDependencies` (mirrors `superpowers`). No behavior change (Bun ships
  global types); purely consistency so the dev/runtime split reads identically
  across the two methodology packages.

### W2b — confirm `.planning/` unification (no code change)
Canonical planning artifacts are **already unified** under
`.planning/<effort>/`:
- **superpowers** specs/plans/sdd → redirected by `piBoundaryOverrides()`
  rules 1 + 3 in `src/superpowers.ts` (injected at runtime; does not fork
  upstream skill text).
- **wayfind** spec/tickets/map → native (skills already write `.planning/`).

### W2c — visual-companion mockup scratch (documented exception + gitignore)
- `start-server.sh` hardcodes `SESSION_DIR="${PROJECT_DIR}/.superpowers/brainstorm/"`
  with no override flag. It is **transient browser-mockup HTML**, not a planning
  artifact — categorically different from spec/plan/ticket/map/sdd.
- **Decision (approved):** treat as a documented exception. Do NOT patch the
  upstream script (ADR-0004). Instead:
  - add `.superpowers/` to repo `.gitignore` (currently absent → mockups leak
    into `git status`).
  - document the exception in the boundary section (W2d).

### W2d — boundary section in dep-tree PRD
Append a new section to
`bun-apps/pi-agent/docs/extension-dependency-tree.PRD.md`:
- parallel coexistence (decide-phase = wayfind; plan/execute = superpowers);
  no code edge between them; no skill/command name conflicts.
- the entry-path routing discriminator ("can I write a plan right now?").
- spec-output ownership (`to-spec` vs `brainstorming` — both converge on
  `.planning/<effort>/spec.md` via the bootstrap; they are separate entry
  paths, not a shared artifact).
- the dev/runtime dependency split table (peerDeps = runtime host contract;
  devDeps = tooling + peer-for-typecheck; zero third-party runtime deps).
- the `.planning/` unification map (what lives where) + the `.superpowers/`
  exception.

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

All changes are `package.json` edits + one `.gitignore` line + one doc section.
`git revert` the effort commit restores prior state. No data migration, no
runtime state.
