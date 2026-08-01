# hermes-memory failure lifecycle (`state` + `severity`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `failures.md` entries a lifecycle (`active | resolved | acquired` + advisory `severity`) so the injected prompt surfaces only still-active failures, fixed ones retire, and permanent facts graduate out of injection — without a new container or data movement.

**Architecture:** `state`/`severity` are frontmatter fields (markdown source of truth) mirrored to DB columns (`state`, `severity`) on both backends, exactly like `category`/`status`/`md_id`. Injection filters `state='active'`. Backfill infers initial `state` from `category` (idempotent; never overwrites an explicit value). Manual transitions only.

**Tech Stack:** TypeScript (Bun), SQLite (`better-sqlite3`) + SurrealDB backends, YAML frontmatter (`yaml` pkg), `bun test`.

**Spec:** `.planning/2026-08-02-hermes-failure-lifecycle/spec.md`
**Source findings:** `.planning/2026-08-02-try-to-checkout-code-use-gh-and-learning-from-ht/findings.md` §2

## Global Constraints

- **Platform/tests:** Apple Silicon; run `python/venv/bin/python` only for the MLX pipeline (N/A here). Tests: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`. Full suite must stay green: currently **990 pass / 1 skip / 0 fail** (the +1 from Task 3's orphan test is on the minors branch, not this branch — baseline here is 990).
- **Shell discipline:** never top-level `cd`; use `( cd <dir> && ... )`. No `package-lock.json` (Bun workspace).
- **Format invariant:** field order in frontmatter is `id → created → last → state → severity → provenance → sources → memworth`. Absent optional fields are omitted entirely (same rule as today). `state`/`severity` are **failure-target only** (omitted for `memory`/`user`).
- **Backfill idempotency:** only write `state` when the entry has none; never overwrite an explicit `state`. Re-running is a no-op.
- **Safe default:** any missing/invalid `state` reads as `'active'` (never silently hide a failure).
- **No new config flags.** Existing `failureInjectionMaxAgeDays` / `failureInjectionMaxEntries` still apply, now over the `active`-only subset.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types.ts` | shared types | add `FailureState`; add `state`/`severity` to review-op input type |
| `src/store/memory-format.ts` | `.md` parse/encode | serialize/parse `state`+`severity`; `normalizeFailureState`, `defaultStateForCategory` helpers; `ParsedMarkdownMemoryEntry` |
| `src/store/repository.ts` | backend-neutral seam | add `state`/`severity` to `MemoryEntry`, `MemorySyncInput`, `addMemory`, `replaceSyncedMemories` |
| `src/store/sqlite/schema.ts` | fresh-DB DDL | add `state`/`severity` columns to `CREATE TABLE memories` |
| `src/store/sqlite/sqlite-backend.ts` | legacy-DB migration | `ALTER TABLE … ADD COLUMN state/severity` in `ensureMemoriesColumns` |
| `src/store/sqlite/sqlite-memory-repo.ts` | SQLite repo | select cols, `MemoryRow`, `mapRow`, INSERT/UPDATE, `getRecentFailures` filter |
| `src/store/surreal/surreal-memory-repo.ts` | Surreal repo | `mapRow`, insert/sync fields, `getRecentFailures` filter (SCHEMALESS → no DDL) |
| `src/store/memory-store.ts` | snapshot + add path + injection | `decodeEntry` carries state; default-state-on-add; `memworth.fail` freeze; **injection call-site** filters `active` |
| `src/handlers/sync-markdown-memories.ts` | startup mirror + backfill | idempotent `state` backfill by category (`.md` + DB) |
| `src/handlers/review-memory-ops.ts` | review ops | accept `state` (mirror `category`) |
| `src/tools/memory-tool.ts` | tool surface | optional `state`/`severity` params on add/edit |
| `tests/store/memory-format.test.ts` (new sections) | format tests | parse/encode/validate/defaults |
| `tests/store/memory-store.test.ts` (new sections) | injection/backfill tests | filter, freeze, backfill idempotency |

---

## Task 1: Format layer — `state` + `severity` in frontmatter

**Files:**
- Modify: `src/types.ts` (add `FailureState` type)
- Modify: `src/store/memory-format.ts` (serialize/parse/helpers; `ParsedMarkdownMemoryEntry`)
- Test: `tests/store/memory-format.test.ts`

**Interfaces:**
- Produces: `FailureState` type; `normalizeFailureState(v): FailureState`; `defaultStateForCategory(c): FailureState`; `state`/`severity` on `ParsedMarkdownMemoryEntry`; `serializeMetadataFrontmatter`/`parseMetadataFrontmatter` carry `state`/`severity`.

- [ ] **Step 1: Write failing tests** (append to `tests/store/memory-format.test.ts`)

```ts
import { serializeMetadataFrontmatter, parseMetadataFrontmatter, normalizeFailureState, defaultStateForCategory } from "../../src/store/memory-format.js";
import type { FailureState } from "../../src/types.js";
import { test, expect } from "bun:test";

test("serialize/parse round-trips state + severity in frontmatter", () => {
  const raw = serializeMetadataFrontmatter({
    id: "uuid-1", text: "[failure] boom", created: "2026-08-02", last: "2026-08-02",
    state: "resolved", severity: 2,
  });
  expect(raw).toContain("state: resolved");
  expect(raw).toContain("severity: 2");
  const fm = parseMetadataFrontmatter(raw);
  expect(fm.state).toBe("resolved");
  expect(fm.severity).toBe(2);
});

test("state omitted when not supplied (memory/user entries)", () => {
  const raw = serializeMetadataFrontmatter({ id: "u", text: "note", created: "2026-08-02", last: "2026-08-02" });
  expect(raw).not.toContain("state:");
  expect(parseMetadataFrontmatter(raw).state).toBeUndefined();
});

test("normalizeFailureState coerces invalid → active", () => {
  expect(normalizeFailureState("resolved")).toBe("resolved");
  expect(normalizeFailureState("bogus")).toBe("active");
  expect(normalizeFailureState(undefined)).toBe("active");
  expect(normalizeFailureState(null)).toBe("active");
});

test("defaultStateForCategory maps tool-quirk/convention → acquired, else active", () => {
  expect(defaultStateForCategory("tool-quirk")).toBe("acquired");
  expect(defaultStateForCategory("convention")).toBe("acquired");
  expect(defaultStateForCategory("failure")).toBe("active");
  expect(defaultStateForCategory("correction")).toBe("active");
  expect(defaultStateForCategory(null)).toBe("active");
});
```

- [ ] **Step 2: Run test → verify FAIL** (`function not defined` / missing fields)
  Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format.test.ts )`

- [ ] **Step 3: Implement**

In `src/types.ts` (next to `MemoryCategory`):
```ts
/** Lifecycle state for failure-target entries. Default/invalid → `active`. */
export type FailureState = "active" | "resolved" | "acquired";
```

In `src/store/memory-format.ts` — add `state?: FailureState` and `severity?: number | null` to `ParsedMarkdownMemoryEntry`. Add helpers:
```ts
const FAILURE_STATES: ReadonlySet<string> = new Set(["active", "resolved", "acquired"]);
export function normalizeFailureState(v: unknown): FailureState {
  return typeof v === "string" && FAILURE_STATES.has(v) ? (v as FailureState) : "active";
}
export function defaultStateForCategory(c: MemoryCategory | null): FailureState {
  return c === "tool-quirk" || c === "convention" ? "acquired" : "active";
}
```
In `serializeMetadataFrontmatter` — add `state?: FailureState | null; severity?: number | null;` to the input type; emit after `last`:
```ts
  const fm: Record<string, unknown> = { id: input.id, created: input.created, last: input.last };
  if (input.state) fm.state = input.state;
  if (typeof input.severity === "number" && input.severity >= 1 && input.severity <= 3) fm.severity = input.severity;
  // … existing provenance/sources/memworth …
```
In `parseMetadataFrontmatter` — in the returned object add:
```ts
  ...(fm.state ? { state: normalizeFailureState(fm.state) } : {}),
  ...(typeof fm.severity === "number" && fm.severity >= 1 && fm.severity <= 3 ? { severity: fm.severity } : {}),
```

- [ ] **Step 4: Run test → verify PASS**
- [ ] **Step 5: Commit** — `feat(hermes-memory): parse/encode failure state + severity in frontmatter`

---

## Task 2: Repository seam — surface `state`/`severity` on types

**Files:**
- Modify: `src/store/repository.ts`
- Test: `tests/store/repository-contract.test.ts` (or nearest existing; if none covers sync input, add a type-level assertion)

**Interfaces:**
- Consumes: `FailureState` from Task 1.
- Produces: `state?: FailureState` + `severity?: number | null` on `MemoryEntry`, `MemorySyncInput`, `addMemory` input, `replaceSyncedMemories` updates.

- [ ] **Step 1: Write failing test** — add to the repository contract test an assertion that a `MemoryEntry` may carry `state`/`severity` and that `syncMemoryEntry` accepts them (compile-time + a round-trip if a fake repo is used). Minimal:
```ts
test("MemoryEntry/sync input carry failure state + severity", () => {
  const e: MemoryEntry = { id: 1, project: null, target: "failure", category: "failure",
    content: "x", failureReason: null, toolState: null, correctedTo: null,
    created: "2026-08-02", lastReferenced: "2026-08-02", state: "resolved", severity: 3 };
  expect(e.state).toBe("resolved");
  expect(e.severity).toBe(3);
});
```
- [ ] **Step 2: Run → FAIL (type error: `state` not on `MemoryEntry`)**
- [ ] **Step 3: Implement** — in `repository.ts`, add to `MemoryEntry`: `state?: FailureState;` and `severity?: number | null;` (import `FailureState` from `../types.js`). Add the same two optional fields to `MemorySyncInput`, to the `addMemory(input: { … })` literal, and to the `replaceSyncedMemories(oldText, updates: { … })` literal.
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(hermes-memory): surface failure state/severity on repository seam`

---

## Task 3: SQLite — schema, migration, mapRow, INSERT/UPDATE, getRecentFailures filter

**Files:**
- Modify: `src/store/sqlite/schema.ts` (fresh-DB DDL)
- Modify: `src/store/sqlite/sqlite-backend.ts` (`ensureMemoriesColumns`)
- Modify: `src/store/sqlite/sqlite-memory-repo.ts` (columns, row, mapRow, INSERT×2, UPDATE, getRecentFailures)
- Test: `tests/store/sqlite-memory-repo.test.ts` (or `tests/handlers/` integration)

**Interfaces:**
- Consumes: `state`/`severity` on `MemorySyncInput`/`addMemory` (Task 2).
- Produces: `state`/`severity` persisted + returned on `MemoryEntry`; `getRecentFailures` excludes non-`active`.

- [ ] **Step 1: Write failing test**
```ts
test("getRecentFailures excludes resolved/acquired; keeps active", async () => {
  const repo = await makeRepo(); // existing helper in the test file
  await repo.addMemory({ content: "[failure] active one", target: "failure", category: "failure", state: "active" });
  await repo.addMemory({ content: "[failure] fixed one", target: "failure", category: "failure", state: "resolved" });
  await repo.addMemory({ content: "[tool-quirk] known quirk", target: "failure", category: "tool-quirk", state: "acquired" });
  const recent = await repo.getRecentFailures(7);
  const contents = recent.map(m => m.content);
  expect(contents).toContain("[failure] active one");
  expect(contents).not.toContain("[failure] fixed one");
  expect(contents).not.toContain("[tool-quirk] known quirk");
  // state round-trips on the active row
  expect(recent.find(m => m.content === "[failure] active one")?.state).toBe("active");
});
```
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement**
  - `schema.ts` `CREATE TABLE memories` — after `md_id TEXT` add: `state TEXT NOT NULL DEFAULT 'active',` and `severity INTEGER`.
  - `sqlite-backend.ts ensureMemoriesColumns` — after the `md_id` block add:
    ```ts
    if (!names.has('state')) db.exec("ALTER TABLE memories ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
    if (!names.has('severity')) db.exec('ALTER TABLE memories ADD COLUMN severity INTEGER');
    ```
  - `sqlite-memory-repo.ts`:
    - `MEMORY_SELECT_COLUMNS` (the const near line 60 listing columns) — append `, state, severity`.
    - `MemoryRow` interface — add `state: string; severity?: number | null;`.
    - `mapRow` — add `state: (row.state as FailureState) ?? "active", severity: row.severity ?? null,` (import `FailureState`).
    - Both INSERT statements (`addMemory` ~236, `syncMemoryEntry` ~335) — add `state`/`severity` to the column list + params: `… md_id, state, severity) VALUES (…, ?, ?)` with `input.state ?? null, input.severity ?? null` (NULL → column default `'active'` applies for `state` on fresh INSERT only when omitted; for explicit safety pass `input.state ?? "active"`).

      NOTE: `state` column is `NOT NULL DEFAULT 'active'` — passing `input.state ?? "active"` is safest.
    - UPDATE (~357) — add `state = ?, severity = ?` to the SET list + params.
    - `getRecentFailures` (~805) — add `"state = ?"` to `conditions` and `"active"` to `params` (alongside the existing `target`/`created` conditions).
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(hermes-memory): persist failure state/severity in SQLite; filter injection to active`

---

## Task 4: Surreal parity

**Files:**
- Modify: `src/store/surreal/surreal-memory-repo.ts`
- Test: `tests/store/surreal-memory-repo.test.ts`

**Interfaces:** identical to Task 3 (Surreal is `SCHEMALESS` — `DEFINE TABLE … SCHEMALESS` at `surreal/schema.ts:15`, so no DDL; fields are written/ read directly).

- [ ] **Step 1: Write failing test** — mirror Task 3's test against the Surreal repo (skip if Surreal isn't available in CI; gate with the existing `runSurreal`/availability guard used by other surreal tests).
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement**
  - `FIELDS` const (the Surreal select field list) — append `, state, severity`.
  - `mapRow` — add `state: (r.state as FailureState) ?? "active", severity: r.severity ?? null,`.
  - insert/sync (`addMemory` ~283, `syncMemoryEntry` ~318) — add `state: input.state ?? "active", severity: input.severity ?? null` to the written record + the RETURN/merge so it round-trips.
  - `getRecentFailures` (~881) — add `"state = $state"` to `conds` and `params.state = "active"`.
- [ ] **Step 4: Run → PASS** (or SKIP if Surreal unavailable — record the skip reason)
- [ ] **Step 5: Commit** — `feat(hermes-memory): Surreal parity for failure state/severity + active filter`

---

## Task 5: Snapshot — decodeEntry carries state; default-on-add; memworth freeze; injection filter at call-site

**Files:**
- Modify: `src/store/memory-store.ts`
- Test: `tests/store/memory-store.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers + Task 2 types.
- Produces: snapshot injection surfaces only `active`; new failure entries default `state` by category; `memworth.fail` freezes on `active`→`resolved`/`acquired`.

> **Critical:** the `state='active'` filter goes at the **injection call-site** (`formatForSystemPrompt`, ~line 1195), NOT inside `getFailureEntries` (line 619) — because `error-detector.ts:153` also calls `getFailureEntries(30)` for capture-dedup and must still see resolved failures.

- [ ] **Step 1: Write failing test** (append to `tests/store/memory-store.test.ts`)
```ts
test("injection excludes resolved/acquired failure entries", () => {
  const store = makeStoreWithEntries([
    entry("[failure] live", { category: "failure", state: "active", created: today }),
    entry("[failure] fixed", { category: "failure", state: "resolved", created: today }),
    entry("[tool-quirk] quirk", { category: "tool-quirk", state: "acquired", created: today }),
  ]);
  const block = store.formatForSystemPrompt();
  expect(block).toContain("[failure] live");
  expect(block).not.toContain("[failure] fixed");
  expect(block).not.toContain("[tool-quirk] quirk");
});
```
(Use the test file's existing `entry()`/`makeStoreWith*` helpers; adapt names.)

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement**
  - `decodeEntry` (the read-path producing `{ text, created, lastReferenced, provenance, sources, mwSuccess, mwFail }`) — add `state`/`severity` to its return, sourced from `parseMetadataFrontmatter`/`parseMetadataComment` (the comment shape has no state → `undefined` → active). Also extend `entriesWithMeta` return type.
  - `encodeEntry`/add path (where frontmatter is written, ~1249+) — accept `state`/`severity` and pass to `serializeMetadataFrontmatter`; default `state` via `defaultStateForCategory(category)` when none supplied. Thread `state`/`severity` into the `MemoryResult`/sync (`added_md_id`-style plumbing) so the DB row matches.
  - `memworth.fail` freeze: in the `bumpMemoryWorth`/recurrence path (or wherever `mwFail` increments), skip the `fail` increment when the entry's `state !== "active"`. (Read the entry's state from the decoded snapshot entry or DB.)
  - `formatForSystemPrompt` (~1195): replace
    `const recentFailures = this.getFailureEntries(maxAgeDays);`
    with a state-aware filter:
    ```ts
    const recentFailures = this.entriesFor("failure")
      .map(e => ({ e, d: this.decodeEntry(e) }))
      .filter(({ d }) => (d.state ?? "active") === "active" && this.isWithinAge(d.created, maxAgeDays))
      .map(({ e }) => this.stripMetadata(e))
      .slice(0, ???); // keep age+cap semantics; see below
    ```
    NOTE: `getFailureEntries` already does age-filter + strip; the cleanest minimal change is to add a sibling `getActiveFailureEntries(maxAgeDays)` that decodes+filters `state==='active'` then strips, and call THAT from `formatForSystemPrompt`. Leave `getFailureEntries` untouched (error-detector keeps using it). Pick whichever is less invasive; the test only asserts behavior.
- [ ] **Step 4: Run → PASS**; also run `tests/handlers/error-detector*` to confirm dedup unchanged.
- [ ] **Step 5: Commit** — `feat(hermes-memory): inject only active failures; default state on add; freeze memworth.fail off-active`

---

## Task 6: Idempotent backfill — infer `state` from category for legacy entries

**Files:**
- Modify: `src/handlers/sync-markdown-memories.ts`
- Test: `tests/handlers/sync-markdown-memories.test.ts`

**Interfaces:**
- Consumes: Task 1 `defaultStateForCategory`; Task 3/4 DB columns.
- Produces: on startup mirror, failure entries with no `state` get the category-inferred default written to `.md` frontmatter + DB. Idempotent.

- [ ] **Step 1: Write failing test**
```ts
test("backfill sets state by category for legacy (stateless) failure entries; idempotent", async () => {
  // seed a .md with: a [failure] entry (no state), a [tool-quirk] entry (no state)
  const before = mdWith("[failure] boom — Failed: x", "[tool-quirk] quirk");
  await syncMarkdownMemories(repo, …);            // first run
  const after1 = readMd();
  expect(stateOf(after1, "[failure] boom")).toBe("active");
  expect(stateOf(after1, "[tool-quirk] quirk")).toBe("acquired");
  await syncMarkdownMemories(repo, …);            // second run
  expect(readMd()).toBe(after1);                   // idempotent — no rewrite
});
test("backfill never overwrites an explicit state", async () => {
  // seed a [failure] entry already carrying `state: resolved`
  await syncMarkdownMemories(repo, …);
  expect(stateOf(readMd(), "[failure] …")).toBe("resolved"); // not reset to active
});
```
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — in `syncMarkdownMemories` (`handlers/sync-markdown-memories.ts:178`), alongside the existing `.md`→DB mirror loop: for each parsed failure-target entry whose decoded `state` is `undefined`/absent, (a) compute `defaultStateForCategory(entry.category)`, (b) rewrite the `.md` entry's frontmatter to include `state: <default>` (reuse `serializeMetadataFrontmatter` — parse, add `state`, re-serialize, preserving body verbatim), (c) mirror `state` onto the DB row (via `syncMemoryEntry`/a targeted UPDATE). Entries that already have `state` are left untouched. Mirror the stable-id backfill's idempotency pattern (it already does parse→conditional-write→sync for `id`).
- [ ] **Step 4: Run → PASS**; run twice in-test to prove idempotency.
- [ ] **Step 5: Commit** — `feat(hermes-memory): idempotent failure-state backfill by category`

---

## Task 7: API surface — `memory_tool` + review-ops accept `state`/`severity`

**Files:**
- Modify: `src/tools/memory-tool.ts` (add/edit params)
- Modify: `src/handlers/review-memory-ops.ts` (accept `state`, mirror `category`)
- Test: `tests/tools/memory-tool.test.ts`, `tests/handlers/review-memory-ops.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: callers can pass `state`/`severity` on add/edit and in review ops.

- [ ] **Step 1: Write failing test** — assert the tool accepts `state` and threads it to `syncMemoryEntry` (mock the repo); assert a review op with `state: "resolved"` marks the entry resolved.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement**
  - `memory-tool.ts`: add optional `state`/`severity` to the add + edit input schema/validation; thread into `syncAddToSqlite`/`syncReplaceToSqlite` signatures (add params) → `syncMemoryEntry`/`replaceSyncedMemories` (`{ …, state, severity }`).
  - `review-memory-ops.ts`: in the op-parsing (where `category` is read via `isMemoryCategory`, ~150/192), add `state` handling (`normalizeFailureState(op.state)` when present) and thread it into the resulting store/DB call (mirror how `category` flows).
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(hermes-memory): accept failure state/severity in memory tool + review ops`

---

## Task 8: Dry-run report (rollout safety)

**Files:**
- Modify: `src/handlers/sync-markdown-memories.ts` (or a small `backfillFailuresState` helper it calls)
- Test: `tests/handlers/sync-markdown-memories.test.ts`

**Interfaces:** the backfill logs/returns a summary `{ active, resolved, acquired, unchanged }` count + lists any currently-injected entry that would STOP injecting (so a mis-map can't silently hide a live failure).

- [ ] **Step 1: Write failing test** — assert the backfill returns a count map and that a `[failure]` entry moving to `acquired` appears in the "would-stop-injecting" list.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — have the backfill accumulate counters and a `stoppedInjecting: string[]` (entries that were `active`-by-date-eligible but become non-`active`). Return/log them. (In steady state this is empty or tiny.)
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(hermes-memory): dry-run report for failure-state backfill`

---

## Self-Review (run after writing, before handoff)

- [ ] **Spec coverage:** §3.1 storage → T1/T2/T3/T4; §3.2 states → T1 (enum) + T5 (freeze); §3.3 transitions → T7; §3.4 defaults+backfill → T6; §3.5 injection → T3/T4 (repo) + T5 (snapshot call-site); §3.6 memworth freeze → T5; §6 migration → T3 (DDL+ALTER) + T6 (backfill); §7 error handling → T1 `normalizeFailureState` (invalid→active) + T6 idempotency; §8 dry-run → T8. **All spec sections mapped.**
- [ ] **Placeholder scan:** none — each task has real code/signatures. (T5 acknowledges two equivalent implementations for the call-site filter; the implementer picks the less invasive — that's a real choice, not a placeholder.)
- [ ] **Type consistency:** `FailureState` defined in T1, imported in T2/T3/T4/T5; `normalizeFailureState`/`defaultStateForCategory` defined T1, used T5/T6/T7; `state`/`severity` field names consistent across `MemoryEntry`/`MemorySyncInput`/`MemoryRow`/`FIELDS`.
- [ ] **Scope:** single plan, 8 tasks, each independently testable. SQLite + Surreal split (T3/T4) so each backend ships its own green cycle.

## Execution Handoff

Plan complete and saved to `.planning/2026-08-02-hermes-failure-lifecycle/plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session, batch with checkpoints.

Which approach?
