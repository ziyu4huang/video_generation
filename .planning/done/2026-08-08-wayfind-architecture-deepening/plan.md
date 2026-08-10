# wayfind architecture-deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `map.ts` (524 lines) into a fs-free `model.ts`, a store `map.ts`, and a `lifecycle.ts`, and collapse the 3 triplicated "Settled vocabulary" emitters into one helper — with zero behavior change.

**Architecture:** Move-by-fs-criterion: every symbol that does not import `node:fs` goes to `model.ts` (the foundation); fs-bearing store ops stay in `map.ts`; fs-bearing status/move ops go to `lifecycle.ts`. `lifecycle.ts` imports only `model.ts` (no store edge). A pure `appendSettledVocabulary()` helper in `grill.ts` replaces the byte-identical glossary block in `buildPlanSeed` / `flattenTicketsToPlan` / `seedFromDecisions`.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Bun test runner, Biome lint. Package: `@repo/pi-agent-ext-wayfind`.

## Global Constraints

- **ESM `.js` extensions are mandatory** for every relative import: new files are imported as `./model.js` and `./lifecycle.js`. (Existing convention across `src/` and `tests/`.)
- **Zero behavior change.** No parser-tolerance change (the `extractSection` strict vs `parseMapBody` lenient divergence stays as-is — out of scope). No public signature changes. All emitted bytes preserved.
- **`model.ts` MUST NOT import `node:fs`** (it may import `node:path`). Enforced by a purity-guard test in Task 2.
- **Per-task gate (must pass before commit):** `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`. (`bun run check` = Biome; `bunx tsc --noEmit` = typecheck without the mermaid-vendor step; `bun test` = unit tests.) Do NOT use `bun run build` (it re-vendors mermaid unnecessarily).
- **Tests use real fs** via `mkdtempSync(join(tmpdir(), "..."))` + `afterEach(() => rmSync(...))`. No mocks.
- **Commit style:** conventional, e.g. `refactor(wayfind): extract model.ts (pure parsers/types) from map.ts`.
- **Branch:** `feat/wayfind-architecture-deepening` (already created from origin/main). All commits land here.

## File Structure

- **Create** `src/model.ts` — fs-free foundation: 9 types, parsers, serializers, pure path/date helpers. Imports only `node:path`.
- **Create** `src/lifecycle.ts` — fs-bearing status/move ops: `readEffortMeta`, `setEffortStatus`, `completeEffort` + private `deriveCreated`. Imports `node:fs`, `node:path`, `./model.js`.
- **Create** `tests/lifecycle.test.ts` — characterization tests for the lifecycle fns (Task 1), retargeted to `./lifecycle.js` in Task 3.
- **Modify** `src/map.ts` — loses pure symbols (Task 2) then lifecycle fns (Task 3); keeps store ops + `touchEffortManifest`.
- **Modify** `src/grill.ts` — add `appendSettledVocabulary` (Task 4).
- **Modify** `src/chain.ts`, `src/effort-tool.ts`, `src/wayfinder.ts`, `src/overlay.ts` — rewire imports by symbol partition (Tasks 2–3) + renderer (Task 4, chain only).
- **Modify** `tests/map.test.ts`, `tests/map-frontmatter.test.ts`, `tests/chain.test.ts` — rewire `../src/map.js` imports by partition (Tasks 2–3).
- **Modify** `tests/grill.test.ts` — add `appendSettledVocabulary` unit test (Task 4).

**Authoritative symbol → module partition (governs every rewire):**

| Symbol | → module |
|---|---|
| Consts `MAP_FM_RE`, `EFFORT_STATUSES` | model.ts |
| Types `TicketType`, `TicketStatus`, `Ticket`, `MapDecision`, `EffortStatus`, `EffortMeta`, `WayfindMap`, `SetStatusResult`, `CompleteEffortResult` | model.ts |
| Parsers `parseMapBody`, `parseMapFrontmatter`, `parseDecisionLine`, `parseBulletList` (private), `parseTicketFile` | model.ts |
| Serializers/logic `serializeMapFrontmatter`, `serializeTicket`, `computeFrontier`, `validateEffortMap` | model.ts |
| Pure helpers `today`, `effortDir`, `doneDir` | model.ts |
| Store `readMap`, `writeMap`, `writeTicket`, `appendDecision`, `closeTicket`, `touchEffortManifest` | map.ts (stays) |
| Lifecycle `readEffortMeta`, `setEffortStatus`, `completeEffort` (+ private `deriveCreated`) | lifecycle.ts |
| NEW `appendSettledVocabulary` | grill.ts |

**Current `./map.js` importers and their partition (verbatim current imports):**

- `src/effort-tool.ts`: `{ computeFrontier, type EffortMeta, readMap, today, validateEffortMap, type WayfindMap, writeMap }` → model: `computeFrontier, type EffortMeta, today, validateEffortMap, type WayfindMap`; map: `readMap, writeMap`.
- `src/wayfinder.ts`: `{ appendDecision, completeEffort, computeFrontier, readMap, type Ticket, today, type WayfindMap, writeMap, writeTicket }` → map: `appendDecision, readMap, writeMap, writeTicket`; lifecycle: `completeEffort`; model: `computeFrontier, today, type Ticket, type WayfindMap`.
- `src/chain.ts` L18: `{ appendDecision, closeTicket, readMap, type Ticket }` → map: `appendDecision, closeTicket, readMap`; model: `type Ticket`.
- `src/overlay.ts` L14: `{ readEffortMeta }` → lifecycle: `readEffortMeta`.
- `tests/map.test.ts`: `{ computeFrontier, parseDecisionLine, parseMapBody, parseTicketFile, readMap, serializeTicket, type Ticket, type WayfindMap, writeMap }` → model: `computeFrontier, parseDecisionLine, parseMapBody, parseTicketFile, serializeTicket, type Ticket, type WayfindMap`; map: `readMap, writeMap`.
- `tests/map-frontmatter.test.ts`: `{ appendDecision, closeTicket, type EffortMeta, type MapDecision, parseMapFrontmatter, readEffortMeta, readMap, serializeMapFrontmatter, today, touchEffortManifest, validateEffortMap, type WayfindMap, writeMap, writeTicket }` → model: `type EffortMeta, type MapDecision, parseMapFrontmatter, serializeMapFrontmatter, today, validateEffortMap, type WayfindMap`; map: `appendDecision, closeTicket, readMap, touchEffortManifest, writeMap, writeTicket`; lifecycle: `readEffortMeta`.
- `tests/chain.test.ts`: `{ readMap, type Ticket, writeMap, writeTicket }` → map: `readMap, writeMap, writeTicket`; model: `type Ticket`.

`src/index.ts` does NOT re-export `map.ts` → no barrel change needed (the split is internal).

---

### Task 1: Characterization tests for the lifecycle functions

**Why first:** `setEffortStatus`, `completeEffort`, and `doneDir` have NO direct unit tests today. These tests become the safety net that proves the Task 3 move is behavior-preserving. They run against the CURRENT `map.ts` (lifecycle fns still live there); Task 3 flips the import to `./lifecycle.js`.

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/tests/lifecycle.test.ts`
- Test: same file (SUT imported from `../src/map.js` for now)

**Interfaces:**
- Consumes (current signatures in `map.ts`): `setEffortStatus(cwd: string, effort: string, status: EffortStatus): SetStatusResult`; `completeEffort(cwd: string, effort: string): CompleteEffortResult`; `doneDir(cwd: string): string`; type `EffortMeta`.
- Produces: a green characterization net; no production change.

- [ ] **Step 1: Write the failing-safe characterization test**

Create `tests/lifecycle.test.ts` with exactly:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// SUT still lives in map.ts at this point; Task 3 flips this to "../src/lifecycle.js".
import { completeEffort, doneDir, setEffortStatus } from "../src/map.js";
import type { EffortMeta } from "../src/map.js";

let cwd = "";
afterEach(() => {
  if (cwd) {
    rmSync(cwd, { recursive: true, force: true });
    cwd = "";
  }
});

function seedEffort(root: string, effort: string, status = "active"): void {
  const dir = join(root, ".planning", effort);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `effort: ${effort}`,
    "created: 2026-08-08",
    "last: 2026-08-08",
    `status: ${status}`,
    "---",
    "",
    "# Wayfinder map",
    "",
    "## Destination",
    "",
    "ship it",
  ].join("\n");
  writeFileSync(join(dir, "map.md"), fm, "utf-8");
}

describe("doneDir", () => {
  it("returns the <cwd>/.planning/done archive root", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    expect(doneDir(cwd)).toBe(join(cwd, ".planning", "done"));
  });
});

describe("setEffortStatus", () => {
  it("writes the new status into the map front-matter in place and returns ok", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const effort = "2026-08-08-demo";
    seedEffort(cwd, effort, "active");
    const res = setEffortStatus(cwd, effort, "paused");
    expect(res).toEqual({ ok: true });
    const after = readFileSync(join(cwd, ".planning", effort, "map.md"), "utf-8");
    expect(after).toContain("status: paused");
    expect(after).not.toContain("status: active");
    expect(after).toContain("created: 2026-08-08"); // preserved
  });

  it("refuses {ok:false} when no map.md exists", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const res = setEffortStatus(cwd, "no-such-effort", "paused");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no map");
  });
});

describe("completeEffort", () => {
  it("stamps status:complete and moves the effort dir under .planning/done/", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const effort = "2026-08-08-demo";
    seedEffort(cwd, effort, "active");
    const res = completeEffort(cwd, effort);
    expect(res).toEqual({ ok: true, effort, movedTo: `.planning/done/${effort}` });
    expect(existsSync(join(cwd, ".planning", effort))).toBe(false); // original gone
    const moved = join(cwd, ".planning", "done", effort);
    expect(existsSync(join(moved, "map.md"))).toBe(true);
    expect(readFileSync(join(moved, "map.md"), "utf-8")).toContain("status: complete");
  });

  it("refuses {ok:false} when there is no map.md", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const res = completeEffort(cwd, "no-such-effort");
    expect(res.ok).toBe(false);
  });

  it("refuses {ok:false} when the destination already exists (no clobber)", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const effort = "2026-08-08-demo";
    seedEffort(cwd, effort);
    mkdirSync(join(cwd, ".planning", "done", effort), { recursive: true });
    const res = completeEffort(cwd, effort);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("already exists");
  });
});
```

- [ ] **Step 2: Run the tests — they should PASS immediately (characterization)**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/lifecycle.test.ts )`
Expected: PASS (5 tests). These characterize existing behavior — they are not new behavior, so they go green at once. If any fails, STOP: the assumption about a signature/behavior is wrong; re-read `map.ts:457-524` and correct the test before proceeding.

- [ ] **Step 3: Run the full gate**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__superpowers add bun-apps/pi-agent-ext-wayfind/tests/lifecycle.test.ts
git -C /Users/huangziyu/proj/video_generation__superpowers commit -m "test(wayfind): characterize lifecycle fns (setEffortStatus/completeEffort/doneDir)"
```

---

### Task 2: Extract `model.ts` (fs-free foundation) + purity guard

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/src/model.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/map.ts` (remove pure symbols; import what remains from `./model.js`)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts`, `src/wayfinder.ts`, `src/chain.ts` (rewire pure symbols → `./model.js`)
- Modify: `bun-apps/pi-agent-ext-wayfind/tests/map.test.ts`, `tests/map-frontmatter.test.ts`, `tests/chain.test.ts` (rewire pure symbols → `../src/model.js`)
- Test: add purity-guard to `tests/lifecycle.test.ts` (or a new `tests/model-purity.test.ts`)

**Interfaces:**
- Consumes: the symbol partition table above; current `map.ts` line ranges.
- Produces: `src/model.ts` exporting the pure symbols; `map.ts` no longer defines them.

- [ ] **Step 1: Create `src/model.ts`**

Create `src/model.ts`. It imports ONLY `join` from `node:path` (NO `node:fs`). Move VERBATIM (copy the exact source, including leading `export`) these symbols from `map.ts`:

- Consts: `MAP_FM_RE`, `EFFORT_STATUSES`
- Types: `TicketType`, `TicketStatus`, `Ticket`, `MapDecision`, `EffortStatus`, `EffortMeta`, `WayfindMap`, `SetStatusResult`, `CompleteEffortResult`
- Parsers: `parseMapBody`, `parseMapFrontmatter`, `parseDecisionLine`, `parseTicketFile`, and the private `parseBulletList` (keep it non-exported in model.ts — only used internally by the parsers)
- Serializers/logic: `serializeMapFrontmatter`, `serializeTicket`, `computeFrontier`, `validateEffortMap`
- Pure helpers: `today`, `effortDir`, `doneDir`

Header for model.ts:

```ts
/**
 * Wayfind map + ticket data model — fs-free foundation.
 *
 * Pure types, parsers, serializers, and path/date helpers for the
 * `.planning/<effort>/` local-markdown store. NO `node:fs` import: this module
 * is the testable core that both the store (map.ts) and the lifecycle ops
 * (lifecycle.ts) build on. (Split out of the former monolithic map.ts.)
 */

import { join } from "node:path";
```

Then the moved symbols, verbatim. (`effortDir`/`doneDir` use `join`; everything else is pure.)

- [ ] **Step 2: Strip the moved symbols from `map.ts`; re-import what its remaining functions need**

In `map.ts`, DELETE the definitions moved to model.ts. The remaining `map.ts` keeps ONLY: `readMap`, `writeMap`, `writeTicket`, `appendDecision`, `closeTicket`, `touchEffortManifest` (the store ops), plus the `node:fs` + `node:path` imports it still needs. Add an import of the pure symbols these store ops use:

```ts
import { computeFrontier, effortDir, parseMapBody, parseMapFrontmatter, parseTicketFile, serializeMapFrontmatter, serializeTicket, today, type MapDecision, type Ticket, type WayfindMap } from "./model.js";
```

(The exact set is whatever the remaining store ops reference — let `bunx tsc --noEmit` and `bun run check` converge it: add any missing symbol, remove any unused. `touchEffortManifest`, `readMap`, `writeMap`, `writeTicket`, `appendDecision` call `effortDir`, `parseMapFrontmatter`, `today`, `serializeMapFrontmatter`, `serializeTicket`, `parseMapBody`, `parseTicketFile`, `computeFrontier` and the listed types.)

NOTE: at the end of Task 2 the lifecycle fns (`readEffortMeta`, `setEffortStatus`, `completeEffort`, `deriveCreated`) STILL live in `map.ts` — they move in Task 3. So `map.ts` must ALSO import what THOSE need from model.ts (`effortDir`, `doneDir`, `parseMapFrontmatter`, `serializeMapFrontmatter`, `today`, `type EffortMeta`, `type EffortStatus`, `type SetStatusResult`, `type CompleteEffortResult`) for this interim state. Let tsc tell you the full set.

- [ ] **Step 3: Rewire the `src/` importers (pure symbols → `./model.js`)**

For each, split the existing `from "./map.js"` import per the partition table; leave store + lifecycle symbols on `./map.js`:

- `src/effort-tool.ts`: add `import { computeFrontier, type EffortMeta, today, validateEffortMap, type WayfindMap } from "./model.js";` and reduce the `./map.js` import to `{ readMap, writeMap }`.
- `src/wayfinder.ts`: add `import { computeFrontier, today, type Ticket, type WayfindMap } from "./model.js";` and reduce `./map.js` to `{ appendDecision, completeEffort, readMap, writeMap, writeTicket }`. (Preserve the file's existing import style/indent.)
- `src/chain.ts` L18: change `import { appendDecision, closeTicket, readMap, type Ticket } from "./map.js";` → keep `import { appendDecision, closeTicket, readMap } from "./map.js";` and add `import type { Ticket } from "./model.js";`.

- [ ] **Step 4: Rewire the test importers (pure symbols → `../src/model.js`)**

- `tests/map.test.ts`: split — `import { computeFrontier, parseDecisionLine, parseMapBody, parseTicketFile, serializeTicket, type Ticket, type WayfindMap } from "../src/model.js";` and `import { readMap, writeMap } from "../src/map.js";`.
- `tests/map-frontmatter.test.ts`: split — `import { type EffortMeta, type MapDecision, parseMapFrontmatter, serializeMapFrontmatter, today, validateEffortMap, type WayfindMap } from "../src/model.js";` and reduce `../src/map.js` to `{ appendDecision, closeTicket, readEffortMeta, readMap, touchEffortManifest, writeMap, writeTicket }`. (`readEffortMeta` stays on map.js until Task 3.)
- `tests/chain.test.ts`: `import type { Ticket } from "../src/model.js";` and reduce `../src/map.js` to `{ readMap, writeMap, writeTicket }`.

- [ ] **Step 5: Add the purity-guard test**

Append to `tests/lifecycle.test.ts` (or create `tests/model-purity.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("model.ts purity (fs-free invariant)", () => {
  it("does not import node:fs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "model.ts"), "utf-8");
    expect(src).not.toContain('from "node:fs"');
    expect(src).not.toContain("require(");
  });
});
```

- [ ] **Step 6: Run the full gate — must be GREEN**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`
Expected: Biome clean, tsc clean, all tests pass (including Task 1 characterization + the new purity guard). If tsc reports a missing/changed symbol, re-check the partition table and the interim lifecycle-still-in-map.ts imports.

- [ ] **Step 7: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__superpowers add bun-apps/pi-agent-ext-wayfind/src/model.ts bun-apps/pi-agent-ext-wayfind/src/map.ts bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts bun-apps/pi-agent-ext-wayfind/src/chain.ts bun-apps/pi-agent-ext-wayfind/tests/map.test.ts bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts bun-apps/pi-agent-ext-wayfind/tests/chain.test.ts bun-apps/pi-agent-ext-wayfind/tests/lifecycle.test.ts
git -C /Users/huangziyu/proj/video_generation__superpowers commit -m "refactor(wayfind): extract fs-free model.ts (types/parsers/serializers/helpers) from map.ts"
```

---

### Task 3: Extract `lifecycle.ts` (status/move ops)

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/src/lifecycle.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/map.ts` (remove the 3 lifecycle fns + `deriveCreated`; drop their now-unneeded model imports)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts` (`completeEffort` → `./lifecycle.js`), `src/overlay.ts` (`readEffortMeta` → `./lifecycle.js`)
- Modify: `bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts` (`readEffortMeta` → `../src/lifecycle.js`), `tests/lifecycle.test.ts` (SUT import → `../src/lifecycle.js`)

**Interfaces:**
- Consumes from model.ts: `effortDir`, `doneDir`, `parseMapFrontmatter`, `serializeMapFrontmatter`, `today`, types `EffortMeta`, `EffortStatus`, `SetStatusResult`, `CompleteEffortResult`.
- Produces: `src/lifecycle.ts` exporting `readEffortMeta`, `setEffortStatus`, `completeEffort` (and keeping `deriveCreated` private).

- [ ] **Step 1: Create `src/lifecycle.ts`**

Header + imports:

```ts
/**
 * Wayfind effort lifecycle — status transitions + archival move.
 *
 * Fs-bearing status/move operations on `.planning/<effort>/map.md` and the
 * `.planning/done/` archive. Depends only on the fs-free model (no store edge).
 * (Split out of the former monolithic map.ts.)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  doneDir,
  effortDir,
  type EffortMeta,
  type EffortStatus,
  parseMapFrontmatter,
  serializeMapFrontmatter,
  today,
  type CompleteEffortResult,
  type SetStatusResult,
} from "./model.js";
```

Move VERBATIM from `map.ts` into `lifecycle.ts`:
- the private `function deriveCreated(slug: string): string | undefined` (keep private — only `setEffortStatus` uses it)
- `readEffortMeta`, `setEffortStatus`, `completeEffort` (exact bodies, unchanged)

- [ ] **Step 2: Strip the 3 lifecycle fns + `deriveCreated` from `map.ts`**

`map.ts` now contains ONLY the store ops (`readMap`, `writeMap`, `writeTicket`, `appendDecision`, `closeTicket`, `touchEffortManifest`). Remove the now-unneeded `node:fs` functions only used by lifecycle (`renameSync` — check; `readFileSync`/`writeFileSync`/`existsSync`/`mkdirSync` are still used by store ops, keep those). Drop any model import symbols only lifecycle used (e.g. `doneDir`, `type EffortStatus`, `type SetStatusResult`, `type CompleteEffortResult`, `type EffortMeta` if no store op needs it). Let `bunx tsc --noEmit` + `bun run check` converge the imports.

- [ ] **Step 3: Rewire `src/` importers**

- `src/wayfinder.ts`: move `completeEffort` from the `./map.js` import to a new `import { completeEffort } from "./lifecycle.js";`. (`./map.js` import becomes `{ appendDecision, readMap, writeMap, writeTicket }`; the `./model.js` import from Task 2 is unchanged.)
- `src/overlay.ts` L14: change `import { readEffortMeta } from "./map.js";` → `import { readEffortMeta } from "./lifecycle.js";`.

- [ ] **Step 4: Rewire test importers**

- `tests/map-frontmatter.test.ts`: move `readEffortMeta` off `../src/map.js` → add `import { readEffortMeta } from "../src/lifecycle.js";` and drop it from the `../src/map.js` import.
- `tests/lifecycle.test.ts`: change the SUT import `from "../src/map.js"` → `from "../src/lifecycle.js"` for `completeEffort, doneDir, setEffortStatus` (and `doneDir`/the `EffortMeta` type come from `../src/model.js` now — `import type { EffortMeta } from "../src/model.js";`). Keep the purity-guard test's `model.ts` read as-is.

- [ ] **Step 5: Run the full gate — must be GREEN**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`
Expected: all green. The Task 1 characterization tests now exercise `lifecycle.ts` and must still pass (proving the move preserved behavior).

- [ ] **Step 6: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__superpowers add bun-apps/pi-agent-ext-wayfind/src/lifecycle.ts bun-apps/pi-agent-ext-wayfind/src/map.ts bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts bun-apps/pi-agent-ext-wayfind/src/overlay.ts bun-apps/pi-agent-ext-wayfind/tests/map-frontmatter.test.ts bun-apps/pi-agent-ext-wayfind/tests/lifecycle.test.ts
git -C /Users/huangziyu/proj/video_generation__superpowers commit -m "refactor(wayfind): extract lifecycle.ts (readEffortMeta/setEffortStatus/completeEffort) from map.ts"
```

---

### Task 4: Unify the triplicated "Settled vocabulary" renderer

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/grill.ts` (add `appendSettledVocabulary`; rewire `buildPlanSeed`)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/chain.ts` (add helper to grill import; rewire `flattenTicketsToPlan` + `seedFromDecisions`)
- Test: `bun-apps/pi-agent-ext-wayfind/tests/grill.test.ts` (add `appendSettledVocabulary` unit test)

**Interfaces:**
- Produces: `grill.ts` exports `appendSettledVocabulary(lines, glossary, heading?)`.
- Behavior: byte-identical output to the 3 replaced blocks (existing `grill.test.ts`, `chain.test.ts`, `plan-seed-contract.test.ts` are the characterization net).

- [ ] **Step 1: Add the helper + unit test (RED→GREEN)**

In `src/grill.ts`, add (near `GlossaryTerm`, which it depends on):

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

Add to `tests/grill.test.ts`:

```ts
import { appendSettledVocabulary } from "../src/grill.js";
import type { GlossaryTerm } from "../src/grill.js";

describe("appendSettledVocabulary", () => {
  it("is a no-op when glossary is empty", () => {
    const lines: string[] = ["x"];
    appendSettledVocabulary(lines, []);
    expect(lines).toEqual(["x"]);
  });

  it("pushes heading + each term (default heading)", () => {
    const lines: string[] = [];
    const g: GlossaryTerm[] = [
      { term: "Foo", definition: "a foo" },
      { term: "Bar", definition: "a bar" },
    ];
    appendSettledVocabulary(lines, g);
    expect(lines).toEqual(["## Settled vocabulary", "", "- **Foo**: a foo", "- **Bar**: a bar", ""]);
  });

  it("honours a custom heading (grill's (from CONTEXT.md) variant)", () => {
    const lines: string[] = [];
    appendSettledVocabulary(lines, [{ term: "X", definition: "y" }], "## Settled vocabulary (from CONTEXT.md)");
    expect(lines[0]).toBe("## Settled vocabulary (from CONTEXT.md)");
  });
});
```

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/grill.test.ts )` → PASS.

- [ ] **Step 2: Rewire `buildPlanSeed` (grill.ts)**

In `buildPlanSeed`, replace the entire block:

```ts
  if (glossary.length > 0) {
    lines.push("## Settled vocabulary (from CONTEXT.md)");
    lines.push("");
    for (const g of glossary) {
      lines.push(`- **${g.term}**: ${g.definition}`);
    }
    lines.push("");
  }
```

with the single call:

```ts
  appendSettledVocabulary(lines, glossary, "## Settled vocabulary (from CONTEXT.md)");
```

(Output is byte-identical: the helper pushes the same heading, blank, terms, blank.)

- [ ] **Step 3: Rewire `chain.ts` (import + both emitters)**

Change the grill import (L17) from:
`import { buildPlanSeed, type GlossaryTerm, parseDecisions, parseGlossary, type ResolvedDecision } from "./grill.js";`
to:
`import { appendSettledVocabulary, buildPlanSeed, type GlossaryTerm, parseDecisions, parseGlossary, type ResolvedDecision } from "./grill.js";`

In `flattenTicketsToPlan`, replace:

```ts
  if (glossary.length > 0) {
    lines.push("## Settled vocabulary", "");
    for (const g of glossary) lines.push(`- **${g.term}**: ${g.definition}`);
    lines.push("");
  }
```

with:

```ts
  appendSettledVocabulary(lines, glossary);
```

In `seedFromDecisions`, replace the identical block with the same `appendSettledVocabulary(lines, glossary);` call.

- [ ] **Step 4: Run the full gate — must be GREEN**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`
Expected: all green. `chain.test.ts` still sees `## Settled vocabulary` + `**Foo**: a foo`; `plan-seed-contract.test.ts` still sees `buildPlanSeed`'s tokens — both unchanged because output is byte-identical.

- [ ] **Step 5: Commit**

```bash
git -C /Users/huangziyu/proj/video_generation__superpowers add bun-apps/pi-agent-ext-wayfind/src/grill.ts bun-apps/pi-agent-ext-wayfind/src/chain.ts bun-apps/pi-agent-ext-wayfind/tests/grill.test.ts
git -C /Users/huangziyu/proj/video_generation__superpowers commit -m "refactor(wayfind): unify triplicated 'Settled vocabulary' emitter via appendSettledVocabulary"
```

---

## Self-review (run before handoff)

1. **Spec coverage:** #3 (map.ts split) → Tasks 2–3; #1 (renderer unify) → Task 4; safety-net → Task 1. All spec sections covered. ✓
2. **Type consistency:** `SetStatusResult`/`CompleteEffortResult` relocate to model.ts and are imported by lifecycle.ts — names unchanged. `appendSettledVocabulary` signature identical in definition (Task 4) and both rewire call-sites. ✓
3. **No placeholders:** every code step contains real code; moves reference exact current line ranges + verbatim bodies. ✓
4. **Green at every commit:** Task 1 (characterization, green on existing code); Tasks 2–4 end with the full gate passing. ✓

## Execution handoff

Plan complete and saved to `.planning/2026-08-08-wayfind-architecture-deepening/plan.md`. Recommended execution: **Subagent-Driven Development** (fresh implementer per task + task review + final whole-branch review). Each task is independent and ends green. The 4 tasks are sequential (Task 2's interim state still has lifecycle in map.ts; Task 3 finishes the split) — dispatch them in order, not in parallel.
