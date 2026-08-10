# Task 3 Report — Extract `lifecycle.ts` from `map.ts`

**Branch:** `feat/wayfind-architecture-deepening`
**Parent HEAD:** `234469b3` → **Task-3 commit:** `bff08671`
**Commit msg:** `refactor(wayfind): extract lifecycle.ts (readEffortMeta/setEffortStatus/completeEffort) from map.ts`

## What moved (map.ts → lifecycle.ts), verbatim

Four functions moved with ZERO behavior/signature change:

1. `readEffortMeta(cwd, effort): EffortMeta | null` — exported, reads only map.md front-matter.
2. `deriveCreated(slug): string | undefined` — **kept private** in lifecycle.ts (only `setEffortStatus` uses it).
3. `setEffortStatus(cwd, effort, status): SetStatusResult` — exported, writes `status:` in place.
4. `completeEffort(cwd, effort): CompleteEffortResult` — exported, status:complete + move into `.planning/done/`.

Relative order preserved (readEffortMeta → deriveCreated → setEffortStatus → completeEffort); the `// ─── lifecycle status (D1: …) ───` divider was retained as the section header above deriveCreated/setEffortStatus/completeEffort.

`map.ts` now contains ONLY store ops: `touchEffortManifest`, `readMap`, `writeMap`, `writeTicket`, `appendDecision`, `closeTicket`.

## lifecycle.ts imports (from `./model.js`)

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CompleteEffortResult,
  doneDir,
  type EffortMeta,
  type EffortStatus,
  effortDir,
  parseMapFrontmatter,
  type SetStatusResult,
  serializeMapFrontmatter,
  today,
} from "./model.js";
```

Every imported symbol is used (verified against the 4 bodies). `join` is used by all three exported fns; `doneDir`/`mkdirSync`/`renameSync` by completeEffort.

## map.ts final import list + dropped symbols

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  effortDir,
  type MapDecision,
  parseBulletList,
  parseDecisionLine,
  parseMapBody,
  parseMapFrontmatter,
  parseTicketFile,
  serializeMapFrontmatter,
  serializeTicket,
  type Ticket,
  today,
  type WayfindMap,
} from "./model.js";
```

**Dropped symbols** (only the moved lifecycle fns used them):
- node:fs: **`renameSync`** (only completeEffort used it).
- model.js: `doneDir`, `type CompleteEffortResult`, `type EffortMeta`, `type EffortStatus`, `type SetStatusResult`.

`readdirSync` stays (readMap's ticket scan). Header doc-comment updated to point readers at `./lifecycle.ts` for the status/move ops (comment-only, no behavior change).

## grep results — every importer found + rewired

Command: `grep -rn "readEffortMeta\|setEffortStatus\|completeEffort" bun-apps/pi-agent-ext-wayfind/src bun-apps/pi-agent-ext-wayfind/tests`

| File | Symbol(s) | Before → After |
|---|---|---|
| `src/map.ts` | (definitions) | definitions removed |
| `src/wayfinder.ts:17` | `completeEffort` | moved to `./lifecycle.js` (import block split) |
| `src/overlay.ts:14` | `readEffortMeta` | `./map.js` → `./lifecycle.js` |
| `tests/map-frontmatter.test.ts` | `readEffortMeta` | moved to `../src/lifecycle.js` (kept store symbols on `../src/map.js`) |
| `tests/lifecycle.test.ts:7` | `completeEffort, setEffortStatus` | `../src/map.js` → `../src/lifecycle.js` (`doneDir` stayed on `../src/model.js`); stale "SUT still lives in map.ts" comment removed |
| **`tests/wayfinder.test.ts:6`** | `completeEffort, readEffortMeta, setEffortStatus` | **ADDITIONAL importer not in the expected list** — split: lifecycle trio → `../src/lifecycle.js`; `readMap, writeMap` stayed on `../src/map.js` |

Cross-package sanity grep: **no references outside the wayfind package**, and no barrel/index re-export of the moved symbols. (`tests/wayfinder.test.ts` was the one importer the task's expected list omitted; rewired per the "verify, don't assume exhaustive" instruction.)

## Gate output

`bun run check` → clean (Biome: "Checked 44 files. No fixes applied.").
`bunx tsc --noEmit` → clean (zero diagnostics).
`bun test` → **308 pass, 1 skip, 0 fail, 627 expect() calls, 20 files** (676 ms).

Biome auto-fixed 3 import-ordering/formatting nits on first run (lifecycle.ts sort, wayfinder.ts import order, map-frontmatter.test.ts collapse) — cosmetic convergence only; re-applied via `bunx biome check --write .` then re-gated green.

Task 1's characterization tests now exercise `lifecycle.ts` (e.g. `tests/lifecycle.test.ts`, the `setEffortStatus + completeEffort (D1 lifecycle status)` block in `tests/wayfinder.test.ts`, `readEffortMeta` block in `tests/map-frontmatter.test.ts`) and all still pass — proving the move is behavior-preserving.

## Commit

- sha: `bff0867152cea47960c0a3c5c5b35723f71d83f1`
- 7 files changed, +102 / −91; `create src/lifecycle.ts`.
- Staged paths (package code only; NOTHING under `.planning/` — verified `git show --stat` `.planning` file count = 0):
  - `src/lifecycle.ts` (new), `src/map.ts`, `src/wayfinder.ts`, `src/overlay.ts`
  - `tests/map-frontmatter.test.ts`, `tests/lifecycle.test.ts`, `tests/wayfinder.test.ts`

## Deviations

- One additional importer rewired beyond the task's expected list: `tests/wayfinder.test.ts` (imported `completeEffort, readEffortMeta, setEffortStatus`). Added to the `git add` list as permitted ("If step 3's grep found additional code files needing rewire, add them"). Code-only, same package.
- Comment-only header doc refresh in `map.ts` (points at `./lifecycle.ts`); no code/behavior change.
- This report is LOCAL SCRATCH — not committed (per discipline rule).
