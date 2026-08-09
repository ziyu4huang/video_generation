# Task 2 Report — Extract fs-free `model.ts` from `map.ts`

**Effort:** 2026-08-08-wayfind-architecture-deepening
**Task:** zk-spawn (Task 2 of 4)
**Branch:** feat/wayfind-architecture-deepening
**Base commit:** 70309460
**Refactor commit:** `0bc72acd841490fc017df31701fe12dc9c2439c1`
**Message:** `refactor(wayfind): extract fs-free model.ts (types/parsers/serializers/helpers) from map.ts`

---

## What was done

Extracted the pure (fs-free) data model out of the monolithic `src/map.ts` into a new
`src/model.ts`. Per the interim-state contract, the **lifecycle functions
(`readEffortMeta`, `setEffortStatus`, `completeEffort`, private `deriveCreated`) STAY in
`map.ts`** this task — Task 3 moves them. After Task 2, `map.ts` contains the store ops
+ lifecycle fns and imports the pure symbols it still needs from `./model.js`.

### 1. Created `src/model.ts` (fs-free foundation)

Header per spec (`import { join } from "node:path";` only — no `node:fs`).
Moved **verbatim** (exact source incl. leading `export`):

- **consts:** `MAP_FM_RE`, `EFFORT_STATUSES`
- **types:** `TicketType`, `TicketStatus`, `Ticket`, `MapDecision`, `EffortStatus`,
  `EffortMeta`, `WayfindMap`, `SetStatusResult`, `CompleteEffortResult`
- **parsers:** `parseMapBody`, `parseMapFrontmatter`, `parseDecisionLine`, `parseTicketFile`,
  `parseBulletList`
- **serializers/logic:** `serializeMapFrontmatter`, `serializeTicket`, `computeFrontier`,
  `validateEffortMap`
- **helpers:** `today`, `effortDir`, `doneDir`

No signature changes. No parser-tolerance changes. No runtime behavior change.

### 2. Stripped moved symbols from `src/map.ts`

`map.ts` now KEEPS only: store ops (`readEffortMeta`, `touchEffortManifest`, `readMap`,
`writeMap`, `writeTicket`, `appendDecision`, `closeTicket`) + lifecycle (`setEffortStatus`,
`completeEffort`, private `deriveCreated`), plus its `node:fs` + `node:path` (`join`) imports.
Header comment updated to describe the new role (fs/lifecycle layer over `model.ts`).

### 3–4. Rewired importers (store+lifecycle symbols → `./map.js`, pure symbols → `./model.js`)

- `src/effort-tool.ts`, `src/wayfinder.ts`, `src/chain.ts`
- `tests/map.test.ts`, `tests/map-frontmatter.test.ts`, `tests/chain.test.ts`

### 5. Added the purity-guard test to `tests/lifecycle.test.ts`

`describe("model.ts purity (fs-free invariant)")` — reads `src/model.ts` and asserts it
neither contains `from "node:fs"` nor `require(`. `node:path`/`node:url` imports merged
with the file's existing grouped imports.

---

## Final converged import list in `map.ts`

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CompleteEffortResult,
  doneDir,
  type EffortMeta,
  type EffortStatus,
  effortDir,
  type MapDecision,
  parseBulletList,
  parseDecisionLine,
  parseMapBody,
  parseMapFrontmatter,
  parseTicketFile,
  type SetStatusResult,
  serializeMapFrontmatter,
  serializeTicket,
  type Ticket,
  today,
  type WayfindMap,
} from "./model.js";
```

### Convergence deltas vs. the task's step-2 seed list

The task's seed import list was converged by `bunx tsc --noEmit` + `bun run check`:

- **Removed `computeFrontier`** — nothing remaining in `map.ts` references it (only the
  effort-tool / wayfinder callers use it, and those import it from `model.js` directly now).
- **Added `parseDecisionLine`** — `readMap` (staying) calls it on the "Decisions so far"
  block. The seed list omitted it; the task's own "store ops reference" enumeration also
  omitted it (oversight). tsc surfaced it.
- **Added `parseBulletList`** — see Deviation D1 below.
- `join` kept from `node:path` (the seed instruction dropped it; map.ts's store/lifecycle
  ops call `join` directly — e.g. `readMap`, `writeMap`, `writeTicket`, `appendDecision`,
  `setEffortStatus`, `completeEffort`). Added back; tsc surfaced 13 "Cannot find name 'join'".
- Biome `assist/source/organizeImports` re-sorted the named-import block (interleaving
  `type`-qualified and value imports alphabetically) — applied via `biome check --write`.

---

## Gate output (full)

```
( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )

$ biome check .            → Checked 43 files. No fixes applied.      (clean)
$ tsc --noEmit             → exit 0  (no errors)                       (clean)
$ bun test                 → 308 pass | 1 skip | 0 fail
                             627 expect() calls | 309 tests across 20 files
```

The single skip is the unrelated `architecture-render mermaid paint` headless-browser test
(always skipped in this environment). The purity guard passed:
`(pass) model.ts purity (fs-free invariant) > does not import node:fs [0.10ms]`.

Task 1's characterization tests still pass — now exercising `map.ts`, which still holds the
lifecycle fns (`completeEffort`, `setEffortStatus`, `doneDir`-via-model).

---

## Deviations

### D1 — `parseBulletList` is EXPORTED (not private) in `model.ts`

The partition lists `parseBulletList` → `model.ts` with parenthetical "(keep non-exported in
model.ts)", but `readMap` — which STAYS in `map.ts` this task — is its sole caller
(`parseBulletList(sections["Not yet specified"])`, `parseBulletList(sections["Out of scope"])`).

Keeping it module-private in `model.ts` is impossible without violating a harder constraint:
- A private `parseBulletList` in `model.ts` is unreachable from `map.ts`'s `readMap` → tsc
  "Cannot find name 'parseBulletList'" → broken build / behavior change.
- Duplicating it in both files violates single-source-of-truth and Biome's unused-symbol
  check (a private, never-called copy in `model.ts` would be flagged unused).

**Resolution:** honor the authoritative PARTITION LOCATION (`parseBulletList` → `model.ts`)
and make it the single source of truth, EXPORTED so `map.ts`'s `readMap` can import it. The
"non-exported" preference is superseded by the hard constraints (zero behavior change, green
gate, no duplication). The task's step-2 import seed and "store ops reference" enumeration
both omitted `parseBulletList` (an oversight re: the `readMap` dependency); convergence added
it to `map.ts`'s import. A JSDoc note on the function documents why it is exported.

### D2 — Three extra importers rewired beyond the task's explicit "split" list

The task's "CURRENT import statements you must split" enumerated 6 files, but the package
has **3 more** importers of pure (now-moved) symbols. Convergence (tsc) caught them; each got
the same store→`map.js` / pure→`model.js` split:

| File | Moved symbols (→ `model.js`) | Staying symbols (→ `map.js`) |
|---|---|---|
| `tests/effort-tool.test.ts` | `EffortMeta` | `readMap` |
| `tests/wayfinder.test.ts` | `parseMapFrontmatter`, `today` | `completeEffort`, `readEffortMeta`, `readMap`, `setEffortStatus`, `writeMap` |
| `tests/lifecycle.test.ts` | `doneDir` | `completeEffort`, `setEffortStatus` |

These two extra test files (`effort-tool.test.ts`, `wayfinder.test.ts`) were necessarily
included in the refactor commit (committed tree must build). `lifecycle.test.ts` was already
in the task's commit path list (for the purity guard). `src/overlay.ts` imports only
`readEffortMeta` (lifecycle, stays) — left untouched, as specified.

Importers confirmed unchanged (all-staying symbols): `tests/commands.test.ts`,
`tests/coordination.test.ts`, `tests/helpers/boundary-probe.ts`, `src/__tests__/overlay.test.ts`.

### D3 — `node:path` `join` retained in `map.ts`

The task's step-2 prose ("map.ts KEEPS ... its `node:fs`/`node:path` imports") was honored,
but the literal seed import block omitted `join`. Store/lifecycle ops call `join` directly,
so it is retained. tsc converged it (would not compile otherwise).

---

## Files in the refactor commit (`0bc72acd`)

```
bun-apps/pi-agent-ext-wayfind/src/model.ts            (new — 12655 B)
bun-apps/pi-agent-ext-wayfind/src/map.ts              (−339 net lines)
bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts
bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts
bun-apps/pi-agent-ext-wayfind/src/chain.ts
bun-apps/pi-agent-ext-wayfind/tests/map.test.ts
bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts
bun-apps/pi-agent-ext-wayfind/tests/chain.test.ts
bun-apps/pi-agent-ext-wayfind/tests/lifecycle.test.ts   (+ purity guard)
bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts  (convergence — D2)
bun-apps/pi-agent-ext-wayfind/tests/wayfinder.test.ts    (convergence — D2)
```
11 files changed, 386 insertions(+), 356 deletions(-).
