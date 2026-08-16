# Spec — wayfind architecture-deepening (dogfood #3 + #1)

**Date:** 2026-08-08
**Status:** COMPLETE — all items shipped: #1/#3 via #1113 (map.ts split + renderer unify); #4 ceremony dedup via #1150; #2 parser unification via #1152 (fs-free `markdown.ts`).
**Effort:** `2026-08-08-wayfind-architecture-deepening`
**Branch:** `feat/wayfind-architecture-deepening`
**Source finding:** `.planning/2026-08-08-improve-codebase-architecture/architecture-review-2026-08-08.md` (deliverable C's dogfood self-scan of `bun-apps/pi-agent-ext-wayfind/src/`)

## Context

Deliverable C (`improve-codebase-architecture` skill, PR #1105) scanned its own host package and surfaced 4 verified deepening candidates. This effort acts on the **two highest-leverage, lowest-risk** findings:

- **#3 — `map.ts` (524 lines) fuses store + lifecycle.** Largest source file in the package; the one-way dependency (lifecycle never calls store) makes a split mechanically safe.
- **#1 — the writing-plans "Settled vocabulary" renderer is triplicated.** A byte-identical glossary loop is copied across 3 emitters (`buildPlanSeed` in grill.ts; `flattenTicketsToPlan` + `seedFromDecisions` in chain.ts).

Findings **#2** (divergent section parsers — strict `extractSection` vs lenient `parseMapBody`) and **#4** (5× effort-resolution ceremony in commands.ts) are explicitly **out of scope** this cycle.

## Goal

Split `map.ts` into three files by the **fs-free vs fs-bearing** criterion — a pure `model.ts`, a store `map.ts`, and a lifecycle `lifecycle.ts` (design **A2**) — and collapse the 3 "Settled vocabulary" emitters into one pure helper in `grill.ts`. **Zero behavior change**: every existing test stays green and all emitted bytes are preserved.

## Target architecture

Split criterion: a symbol goes to `model.ts` iff it does **not** import `node:fs`. Everything fs-bearing is split between `map.ts` (store) and `lifecycle.ts` (status/move).

### `src/model.ts` (NEW — fs-free foundation)
Imports: `node:path` only. **No `node:fs`. No sibling imports.**

Contents (all currently in map.ts):
- **Consts:** `MAP_FM_RE`, `EFFORT_STATUSES`
- **Types:** `EffortMeta`, `EffortStatus`, `Ticket`, `MapDecision`, `WayfindMap`, `CompleteEffortResult` (plus any other pure model type found during extraction, e.g. `SetStatusResult` if present — confirm)
- **Pure parsers:** `parseMapBody`, `parseMapFrontmatter`, `parseDecisionLine`, `parseBulletList`, `parseTicketFile`
- **Pure serializers / model logic:** `serializeMapFrontmatter`, `serializeTicket`, `computeFrontier`, `validateEffortMap` (verify `validateEffortMap` is fs-free during extraction; if it reads files, it stays in map.ts)
- **Pure path/date helpers:** `today`, `deriveCreated`, `effortDir`, `doneDir`

### `src/map.ts` (store — fs-bearing)
Imports: `node:fs`, `node:path`, `./model.js`.

Contents (after extraction):
- **Store fs-ops:** `readMap`, `writeMap`, `writeTicket`, `appendDecision`, `closeTicket`, `touchEffortManifest`

`touchEffortManifest` stays here — it is fs-bearing and is called by the store ops above (`writeTicket`, `appendDecision`), so it belongs to the store.

### `src/lifecycle.ts` (NEW — status/move fs-ops)
Imports: `node:fs`, `node:path`, `./model.js`. **Does NOT import `./map.js`** (no store dependency — this is A2's key win).

Contents:
- **Lifecycle fs-ops:** `readEffortMeta`, `setEffortStatus`, `completeEffort`
- **Lifecycle-only types** (if any beyond `CompleteEffortResult`, which lives in model.ts)

### `src/grill.ts` (unchanged structure — stays fs-free)
New exported pure helper:

```ts
export function appendSettledVocabulary(
  lines: string[],
  glossary: GlossaryTerm[],
  heading = "## Settled vocabulary",
): void {
  if (glossary.length === 0) return;
  lines.push(heading, "");
  for (const g of glossary) lines.push(`- **${g.term}**: ${g.definition}`);
  lines.push("");
}
```

`buildPlanSeed` calls it with `heading = "## Settled vocabulary (from CONTEXT.md)"` (preserving the one cosmetic divergence).

### `src/chain.ts`
- `flattenTicketsToPlan` + `seedFromDecisions` call `appendSettledVocabulary` (imported from `./grill.js`, which chain.ts already imports).
- The `Ticket` type import moves from `./map.js` → `./model.js`; store ops (`appendDecision`, `closeTicket`, `readMap`) stay from `./map.js`.

### Dependency graph (target)

```
          model.ts   (fs-free foundation: types, parsers, serializers, pure path/date helpers)
           ↑   ↑
   map.ts ─┘   └── lifecycle.ts        grill.ts  (fs-free; owns appendSettledVocabulary + GlossaryTerm)
   (store)         (status/move)          ↑
        ↑              ↑                   ↑
        └─── chain.ts, commands.ts, wayfinder.ts, overlay.ts, index.ts ───┘
```

- `model ← {map, lifecycle}` — one-way.
- **No edge between `map.ts` and `lifecycle.ts`.** (A2 relocates the shared pure path helpers `effortDir`/`doneDir` into model.ts, so lifecycle needs nothing from the store. Cleaner than A1, which would have had lifecycle→map.)

## Symbol migration table (drives the plan)

| Symbol | Today | Target |
|---|---|---|
| `MAP_FM_RE`, `EFFORT_STATUSES` | map.ts | model.ts |
| Types: `EffortMeta`, `EffortStatus`, `Ticket`, `MapDecision`, `WayfindMap`, `CompleteEffortResult` | map.ts | model.ts |
| `parseMapBody`, `parseMapFrontmatter`, `parseDecisionLine`, `parseBulletList`, `parseTicketFile` | map.ts | model.ts |
| `serializeMapFrontmatter`, `serializeTicket`, `computeFrontier`, `validateEffortMap` | map.ts | model.ts (verify fs-free) |
| `today`, `deriveCreated`, `effortDir`, `doneDir` | map.ts | model.ts |
| `readMap`, `writeMap`, `writeTicket`, `appendDecision`, `closeTicket`, `touchEffortManifest` | map.ts | **map.ts (stays)** |
| `readEffortMeta`, `setEffortStatus`, `completeEffort` | map.ts | **lifecycle.ts** |
| `appendSettledVocabulary` (NEW) | — | **grill.ts** |

Every importer of `./map.js` splits its import by symbol: `chain.ts`, `commands.ts`, `wayfinder.ts` (`completeEffort` → lifecycle), `overlay.ts` (`readEffortMeta` → lifecycle), `effort-tool.ts`, `procedures.ts`, and the barrel `index.ts`. The plan enumerates each import statement.

## Behavior preservation

- **Output bytes unchanged.** `appendSettledVocabulary` produces exactly the lines the 3 emitters push today (verified identical across all three). The only divergence — grill's `(from CONTEXT.md)` heading suffix — is preserved via the `heading` parameter.
- **No logic change.** Code moves between files; public signatures unchanged; **no parser-tolerance change** (#2 is out of scope, so `extractSection` strict vs `parseMapBody` lenient stays exactly as-is).
- **fs-import discipline.** `model.ts` must not import `node:fs` — enforced by a purity-guard test.

## Test plan (TDD)

**Pre-fill gaps before extraction (safety net + characterization):**
1. `setEffortStatus` — direct unit test (currently untested).
2. `completeEffort` (and `doneDir`) — direct unit test (currently untested).
3. `appendSettledVocabulary` — unit test: empty glossary → no-op; non-empty → exact expected lines; custom heading.
4. **Purity-guard test:** assert the `src/model.ts` source contains no `node:fs` import (guards the fs-free invariant against regression).

**Keep green (characterization):** `map.test.ts`, `map-frontmatter.test.ts`, `grill.test.ts`, `chain.test.ts`, `plan-seed-contract.test.ts` — all must pass before and after the move.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Missed importer of a moved symbol → broken build | Plan enumerates every importer; `bun run typecheck` gate per task. |
| Barrel (`index.ts`) re-exports a stale path | Update index.ts re-exports; test the public surface. |
| `node:fs` accidentally pulled into model.ts | Purity-guard test (#4). |
| `touchEffortManifest` mis-placed → store↔lifecycle cycle | Stays in map.ts (store); documented. |
| Renderer output drift | Byte-identical by construction; existing emitter tests are the characterization net. |

## Out of scope

- **#2** — unify `extractSection`/`parseMapBody` into a fs-free `markdown.ts` (deferred; carries a real strict-vs-lenient decision).
- **#4** — 5× effort-resolution ceremony in commands.ts (low leverage; drive-by for a later cycle).
- Any change to parsing tolerance, status semantics, or on-disk file formats.

## Open questions to resolve in the plan

- Confirm the exact set of pure model types (does `SetStatusResult` exist? any others?).
- Confirm `validateEffortMap` is fs-free (if it touches the filesystem it stays in map.ts).
- Determine whether `index.ts` is the sole public barrel or whether command/tool layers import deep paths — governs how much importer rewire is needed.
