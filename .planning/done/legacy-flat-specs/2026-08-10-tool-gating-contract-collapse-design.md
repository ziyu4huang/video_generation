# tool-gating contract collapse — design

**Date**: 2026-08-10
**Status**: approved (design), not implemented
**Scope**: Spec A of three (see [Follow-up specs](#follow-up-specs))

## Problem

`tool-gating.d.ts` — the module augmentation that lets a tool's `ToolDefinition`
carry an owner-declared `gating` field — exists as **11 local copies** across
`bun-apps/`, plus the canonical one in `@repo/pi-agent-ext-core-interface`.

Nine of the copies are byte-identical (md5 `f147a79b4f5348a15f36ce1b8444ebd1`).
The two variants (`pi-agent-ext-hermes-memory`, `pi-agent`) differ **only in
comments** and a trailing `export {}` — the declared types are identical in all
12 files.

`@repo/pi-agent-ext-core-interface` was created to end this duplication; its own
file header states the copies are "now collapsed into" it. That collapse is
half-done: only `tool-gate`, `core-task`, and `power-tool` consume the shared
augmentation. `hermes-memory` and `knowledge-card` depend on the package for
runtime symbols (`publishSeam` / `readSeam`) yet **still carry a local copy** of
the augmentation.

No test asserts the copies agree. The "drift-guard test" referenced in the file
comments guards owner-declared `gating` *declarations*
(`pi-agent-ext-tool-gate/extensions/drift-guard.test.ts`), not the `.d.ts`
copies. The structural-agreement test those comments describe no longer exists,
so today the duplication is unguarded.

## Goal

Reduce the local copies to zero within this spec's ten migration units
(excluding the `pi-agent` host copy, migrated separately in a follow-up task —
see below), so the tool-gating type contract has exactly one source of truth.

**This is a pure type-level migration. No runtime behavior changes.** The
verification section requires proving that.

## Non-goals

- Changing any tool's `gating` declaration, keywords, or `requires`.
- Reducing schema-token cost.
- Re-triaging which tools are `core: true`.
- Typing the seven `unknown` entries in `SeamImplMap`.
- Fixing the pre-existing typecheck errors surfaced in the baselines (see
  [Verification](#verification)).

## Migration units

Ten packages migrate. All ten currently declare `compilerOptions.types: ["bun"]`
with no `extends`, so the tsconfig edit is identical in each.

| # | Package | Copy location | `gating` declared in | Notes |
|---|---|---|---|---|
| 1 | `pi-agent-ext-flux2` | `src/` | `extensions/flux2.ts` | — |
| 2 | `pi-agent-ext-krea2` | `src/` | `extensions/krea2.ts` | — |
| 3 | `pi-agent-ext-file2md` | `src/` | `extensions/file2md.ts` | — |
| 4 | `pi-agent-ext-research-tool` | `extensions/` | `extensions/research-tool.ts` | copy sits in `extensions/`, not `src/` |
| 5 | `pi-agent-ext-obsidian` | `src/` | `extensions/obsidian.ts` | — |
| 6 | `pi-agent-ext-movie-director` | `src/` | `extensions/movie-director.ts` | spike target; proven |
| 7 | `pi-agent-ext-wayfind` | `src/` | `src/effort-tool.ts` | tsconfig `include` omits `extensions/` |
| 8 | `pi-agent-ext-subagent` | `src/` | `src/subagent-tool.ts`, `src/subagents-tool.ts` | 2 declaring files |
| 9 | `pi-agent-ext-workflow` | `src/` | `src/workflow-tool.ts`, `src/workflow-control-tool.ts` | 2 declaring files |
| 10 | `pi-agent-ext-hermes-memory` | `src/` | 8 files under `src/tools/` | **already** declares the dep (`dependencies`, runtime consumer) — skip step 1 |

### The `pi-agent` host copy: migrated in a follow-up

`bun-apps/pi-agent/src/tool-gating.d.ts` was originally **not** migrated as
part of this spec's ten units. Its header documented a distinct purpose: it
was believed to make the augmentation visible to the monorepo-wide typecheck,
which follows imports into every extension's `src/` — the one copy whose
removal could break a compile context no per-package typecheck covers.

A final review disproved that. Deleting the host copy and re-running
`( cd bun-apps/pi-agent && bunx tsc --noEmit )` produces **0 errors, 0 gating
errors** — the augmentation is not lost. It arrives transitively:
`hermes-memory` and `knowledge-card` import `@repo/pi-agent-ext-core-interface`
at runtime, both packages are statically imported by
`bun-apps/pi-agent/src/static-extensions.ts`, and the package's
`exports["."].types` resolves into `src/types.d.ts`, which itself references
`tool-gating.d.ts`. A positive control (injecting a bogus property beside a
`gating` declaration in `pi-agent-ext-wayfind/src/effort-tool.ts`) confirmed the
checker is genuinely live and the augmentation genuinely arrives — this is not
a case of the typecheck silently failing to cover extension sources.

The host copy has since been deleted (in a follow-up task) and replaced with an
explicit edge: `compilerOptions.types: ["bun", "@repo/pi-agent-ext-core-interface"]`
in `pi-agent/tsconfig.json`, plus a matching `devDependencies` entry in
`pi-agent/package.json`. This is deliberate insurance, not a load-bearing fix —
the transitive path above would keep the augmentation working even without it —
but it means the augmentation no longer silently depends on `hermes-memory` /
`knowledge-card` continuing to import `core-interface` at runtime.

One accepted gap: `dep-guard`'s invariant checking `compilerOptions.types`
entries against `package.json` (invariant 2, see [Extending `dep-guard`](#extending-dep-guard)
below) only scans packages matching `pi-agent-ext-*` (`EXTS` in
`bun-apps/tests/dep-guard.test.ts`). `pi-agent` is the host, not an extension,
so this new edge is not covered by that invariant — an accepted, documented
gap rather than an oversight.

## Design

### Mechanism: tsconfig `types` array

Each migrating package gets three edits:

1. **`package.json`** — add to `devDependencies`:
   `"@repo/pi-agent-ext-core-interface": "workspace:*"`
   (skip for `hermes-memory`, which already declares it in `dependencies`)
2. **`tsconfig.json`** — `compilerOptions.types`:
   `["bun"]` → `["bun", "@repo/pi-agent-ext-core-interface"]`
3. **delete** the local `tool-gating.d.ts`

Resolution works because `@repo/pi-agent-ext-core-interface` declares
`exports["."].types = "./src/types.d.ts"`, and that file carries
`/// <reference path="./tool-gating.d.ts" />`.

#### Why `types` array over the triple-slash directive

The in-repo precedent (`tool-gate`, `core-task`, `power-tool`) uses
`/// <reference types="@repo/pi-agent-ext-core-interface" />` on the entry file.
That works, but the augmentation is **program-wide**, so exactly one directive
per package suffices — which forces an arbitrary choice of *which* file hosts it.
For `hermes-memory` (8 declaring files) and `subagent` / `workflow` (2 each),
that placement is unexplainable to a reader and fragile: deleting the chosen
file breaks the whole package.

The `types` array has no such choice to make, adds no file, and leaves zero
residue. It was **empirically verified** (see below) rather than assumed — the
package's own `src/types.d.ts` header records a prior trap in this area (a `.ts`
types entry resolves but its augmentation silently does not apply), so this path
was spiked before being chosen.

Existing triple-slash consumers are left as they are. Converting them is
cosmetic and out of scope.

#### Dependency field convention

The five current adopters look inconsistent (3 `devDependencies`, 1
`dependencies`, 1 `peerDependencies`), but the split is coherent:

- **types-only consumers** → `devDependencies`
- **runtime consumers** (import `publishSeam` / `readSeam` / `SEAM_KEYS`) →
  `dependencies` / `peerDependencies`

All ten migrating packages except `hermes-memory` are types-only, so they use
`devDependencies`. The rule is recorded in the doc comment of the new
`dep-guard` invariant below — the place it is enforced, and the only location
that cannot drift away from the check. `pi-agent-ext-core-interface` has no
`README.md` today; creating one is out of scope. The existing five adopters are
not retro-edited.

### Spike evidence

Run on `pi-agent-ext-movie-director`, fully reverted afterward (tree clean, no
lockfile drift):

| Step | Total `error TS` | `gating`-related |
|---|---|---|
| Baseline (copy present) | 19 | **0** |
| Negative control (copy deleted, no fix) | 23 | **4** |
| Option (c) (dep + `types` array, copy deleted) | 19 | **0** |

The negative control confirms the measurement is sensitive: deleting the copy
produces `TS2353: 'gating' does not exist in type 'ToolDefinition'`. Option (c)
restores the exact baseline.

### Extending `dep-guard`

`bun-apps/tests/dep-guard.test.ts` invariant 1 ("every `@repo` import is declared
in the importing package's `package.json`") scans source for `from "@repo/X"`
and `import("@repo/X")`. A tsconfig `types` entry is invisible to it.

After this migration, ten packages depend on `core-interface` through an edge
the guard cannot see. Someone removing the `package.json` entry would break the
typecheck while `dep-guard` stayed green.

**Add an invariant**: for each `pi-agent-ext-*` package, every `@repo/*` entry in
`tsconfig.json`'s `compilerOptions.types` must be declared in that package's
`package.json` (any dependency field).

Its doc comment also records the dependency-field convention stated above
(types-only → `devDependencies`; runtime consumers → `dependencies` /
`peerDependencies`), so the convention lives next to its check.

The acyclicity invariant (6) is unaffected: `core-interface` declares no
`@repo/*` dependencies, so it stays a leaf and the ten new edges introduce no
cycle.

## Verification

The spike surfaced two conclusions that constrain how this must be verified.

### 1. "Typecheck passes" is not a usable criterion

`movie-director`'s isolated typecheck has **19 pre-existing errors** at baseline,
all from sibling packages pulled into its program via relative imports
(`../pi-agent-ext-ltx/*`, `../pi-agent-ext-subagent/*`). Other packages are
likely similar. Fixing those is a non-goal.

Per-package acceptance is therefore:

- `gating`-related errors in the `tsc` output: **0**
- total `error TS` count: **equal to that package's recorded pre-migration
  baseline**

Baselines must be captured **before** any edit, into a scratch directory outside
the repo (never into the working tree):

```bash
( cd bun-apps/pi-agent-ext-<pkg> && bunx tsc --noEmit -p tsconfig.json ) \
  > "$SCRATCH/baseline-<pkg>.txt" 2>&1
```

Recorded for `movie-director` by the spike: 19 total, 0 `gating`. The other nine
baselines are captured during implementation.

### 2. Mid-migration green is not evidence

The negative control showed `movie-director`'s program pulls
`../pi-agent-ext-subagent/src/*` in through relative imports — and those files
lost their `gating` too. The programs of these ten packages overlap heavily.

Consequence: **while any copy remains reachable in a package's program, that
package can pass for the wrong reason.** A per-package "edit, typecheck, green,
next" loop can report success for a package that is in fact still leaning on a
neighbour's copy.

Therefore:

> Apply all ten migrations, then verify. Intermediate per-package greens are
> not evidence and must not be recorded as acceptance.

### 3. Proving zero runtime change

Because this is a pure type migration, the runtime numbers must be **identical**,
not merely healthy. Values below are measured on this branch's base
(`origin/main` @ `6debb26e`, 68 tools captured):

```bash
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa:savings
#   OFF baseline: 21,124 tok/req
#   ON at start:  10,113 tok/req
#   SAVED:        11,011 tok/req (52.1%)
#   enable_tool:  243 tok/req

bun run --cwd bun-apps/pi-agent-ext-tool-gate qa:gate-recall
#   PASS — 0 failing gate(s), 0 uncovered
```

Both must be byte-for-byte unchanged after the migration. Any drift means the
migration altered a `gating` declaration — a defect, not an improvement.

Additionally:

```bash
( cd bun-apps/pi-agent-ext-<pkg> && bun test )   # each of the 10
bun run --cwd bun-apps test:deps                 # incl. the new invariant
bun run --cwd bun-apps test:seam
bun run --cwd bun-apps/pi-agent-ext-tool-gate test   # drift-guard
```

`bun install` must be run from `bun-apps/` (never the repo root), and
`bun-apps/bun.lock` must be reviewed for drift before committing.

## Risks and rollback

| Risk | Mitigation |
|---|---|
| A package's program does not resolve the `types` entry (unproven for 9 of 10) | Verified per package by the "0 gating errors + baseline-equal total" criterion, applied after all deletions |
| A package is only passing via a neighbour's copy | Addressed by verification rule 2 — verify only in the all-deleted state |
| Removing the host copy breaks the monorepo-wide typecheck | Disproven by final review (0 errors after deletion) plus a positive control; the copy was migrated to an explicit `types` edge, not left dangling |
| A `gating` declaration is edited by accident | `qa:savings` and `qa:gate-recall` must be numerically identical |
| `bun.lock` drift blocks CI | Review the lockfile diff before committing |

Rollback is `git revert` of a single commit: the change is ten deletions plus
twenty small edits, with no runtime surface.

## Follow-up specs

This is Spec A. Two further efforts were identified during the same
investigation and are deliberately **not** in scope here:

- **Spec B — movie-director gating hygiene.** The `gating` object is duplicated
  verbatim between `movie` and `movie_help` (16 keywords, 10 nouns, 11 verbs);
  `tool-gate`'s `gatesWithSameGating` relies on fingerprint equality, so editing
  one side silently breaks sibling co-activation. Separately, the `cost` tool
  (`extensions/movie-director-cost.ts`) declares no `gating` and is absent from
  `run-dir/manifest.json` — an unregistered prototype confirmed not loaded at
  runtime.
- **Spec C — always-active core re-triage.** The always-active set is 31 tools /
  **10,113 tok/req**, over half of it in eight tools: `zk_ingest` 934, `zk_ask`
  765, `todo` 737, `ask_user_question` 700, `wayfind_effort` 617, `web_search`
  593, `skill_manage` 578, `fetch_content` 570. Several are owner-declared
  `core: true` without an apparent cost audit — `zk_ingest` is a batch
  vault-convergence operation present in every request. Demoting any of them to
  gated requires authoring keywords plus recall probes, which absorbs most of the
  "harden the probes" work.

### Corrected premise (recorded so it is not repeated)

`src/dispatch.ts:320` states that `movie` "is consistently the #1 schema-cost
tool". That was true before the routing-description reduction; it is now stale.
Measured: `movie` = **371 tok** (rank ~25), `movie_help` = **83 tok**, together
2.1% of the 21,124-token total — and both are gated, so their cost at rest is
**zero**. Optimizing movie-director's schema cost has near-zero value; the
comment should be corrected as part of Spec B.
