# Staleness dependency graph — Implementation Plan (Phase-2 / 10-impl)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a closed planning decision's cited/declared source-file dependencies have changed since last validation; flag the card `stale:`, expose a `stale:` query, and BLOCK an effort's graduation (`/wayfind done`) while stale decisions remain. Rides the hermes spine (08's `card.graph.relations` + a new `card_dep_hash` baseline) + a new hermes→wayfind reverse seam. No git hooks.

**Architecture:** A closed planning-ticket card already carries dep edges in `card.graph.relations` (`blocked-by` ticket→ticket, `cites` + new `depends_on` decision→source-file — 08-impl). 10-impl adds: (a) a new additive `card_dep_hash` table = the per-card aggregate hash of the card's deps' current source-file bytes (the staleness baseline; SEPARATE from 09's `card_md_hash` because that table's `card_id` PK is already taken by the mirror hash — see decision α), (b) a `planning-staleness.ts` compute layer (`computeStaleness`/`getStaleCards`) that recomputes the aggregate and compares to the stored baseline, (c) on-access refresh + background-sweep hooks (mirror 09's T6/T7 shapes), (d) a hermes `stale:` query + `stale` flag, (e) a hermes→wayfind reverse globalThis seam (`__piHermesStaleCheck`, mirroring `grill-seam.ts`), and (f) a graduation gate + read-side `stale` count in wayfind.

**Tech Stack:** Bun (no build step; `bun run check` = `tsc --noEmit` for hermes AND wayfind), `node:test` + `node:assert/strict`, `yaml`, bun:sqlite via SqliteBackend, `@repo/pi-agent-ext-hermes-memory`, `@repo/pi-agent-ext-wayfind`.

## Global Constraints

- Platform: Apple Silicon, Bun (no build step). Type-check per package: hermes `bun run check` (= `tsc --noEmit`); wayfind `bun run check` (= biome lint) **AND** `bunx tsc --noEmit` (wayfind's `check` script is biome, NOT tsc — its tsc runs under `build`; use `bunx tsc --noEmit` for a pure type gate). Full suites: `bun test` in each package.
- Workspace: `bun-apps/` root with isolated linker — every imported package MUST be a declared dep of the importing package.
- NEVER use a top-level `cd` — use `( cd <dir> && ... )` or `git -C <WT>` / `--cwd`.
- **Master invariant:** memory/user/failure/knowledge/planning cards MUST NOT regress. 10 is ADDITIVE: new `card_dep_hash` table (no `memories`/`card_md_hash` change), new module, new seam, additive gate-arm. 09's mirror/reconcile/backfill/refresh UNCHANGED. If any non-staleness test breaks at a task boundary, **STOP and fix**.
- `<WT>` = the repo worktree root (the dir containing `bun-apps/` and `.planning/`). All `git -C <WT>` and `( cd ... )` calls use it.
- **No cross-package import (ADR-0004):** hermes↔wayfind communicate via `globalThis` seam literals ONLY (duplicated literal, `typeof === "function"` guard, null-safe when the other extension is absent).

## 09↔10 boundary (do NOT cross)

- **09 owns** mirror drift (card_md_hash kind='mirror' INSERT/UPDATE/skip) + delete reconciliation + conflict-marker flag + on-demand mirror refresh + background mirror backfill.
- **10 owns** dep-validation staleness (NEW `card_dep_hash` baseline) + `stale:` flag/query + graduation gate + reverse seam + read-side surfacing.
- **10 reuses** 09's `planning-sync-state.ts` primitives (`hashEntry`, the `refreshPlanningCard`/`refreshIfStale` SHAPES) but MUST NOT modify 09's mirror/reconcile/hash-compare behavior. **10 does NOT touch `card_md_hash`** (uses a NEW table — see decision α).

## Scope boundaries (deferred — NOT in this plan)

- The `conflict:` divergence query (the 09-impl plan's boundary note forward-pointed to 10, but ticket 10's grilled Resolution is staleness-ONLY — `conflict:` is ungrilled; defer to a separate effort).
- Effort-level dep relations (Supersedes / Absorbed-by / Covered-by / Shares-decision-with) — DEFERRED per ticket 10 Resolution (v1 = ticket→ticket `blocked-by` + decision→source-file `cites`/`depends_on` only).
- Per-dep (per-edge) granularity (knowing WHICH dep changed) — v1 is per-card aggregate; refine later if re-grill UX needs it.

## Resolved decisions (from grill — recorded durably)

- **α — dep-validation baseline storage (REVISED from the 09-impl forecast):** NEW additive `card_dep_hash(card_id TEXT PK, dep_hash TEXT NOT NULL, validated_at DATE NOT NULL)` table — ONE aggregate row per card = `hashEntry(sorted(cited+depends_on source-file bytes))`. NOT in `card_md_hash`: that table's **`card_id` is the SOLE PRIMARY KEY** (verified in `src/store/sqlite/schema.ts`: `CREATE TABLE IF NOT EXISTS card_md_hash (card_id TEXT PRIMARY KEY, …)`), so a second `kind='validated'` row for the SAME card would COLLIDE on the PK. The new table is additive (`CREATE TABLE IF NOT EXISTS`, like 09's T1) → no migration to `card_md_hash`/`memories`. (Corrects the 09-impl plan's "kind='validated' without migration" note — that note was a forecast, not a grill decision; the real PK makes it infeasible.)
- **β — staleness seam:** reverse globalThis seam. Hermes owns staleness computation (reuses 08's `card.graph.relations` + the new `card_dep_hash` baseline) and publishes `globalThis.__piHermesStaleCheck = async (effort, cwd) => { stale: StaleCard[] }` at init; wayfind reads it via a new `stale-seam.ts` (mirrors `grill-seam.ts`: duplicated key literal, `typeof === "function"` guard, null when hermes absent → gate is a no-op, NEVER crashes). **The seam is ASYNC** because staleness is computed from the DB + source files at call time (on-access, per γ) — the hermes side opens an ephemeral `CardStore` per call (it holds no long-lived planning store, exactly like `mirrorPlanningToStore`). Matches DESIGN "rides the hermes spine"; consistent with ADR-0004.
- **γ — when staleness computes:** on-access (when the `stale:` query or graduation check fires) + background sweep (mirror 09's backfill, seeding dep baselines at `session_start`). Pinned by ticket 10 Resolution Q2.
- **δ — stale: surface:** hermes `stale:` query (a new additive `planning_stale` tool — see T6; `memory-tool.ts` is `@ts-nocheck` and carries no prefix-query grammar, so the cleanest additive surface is a standalone tool in the `knowledge_search`/`wayfind_effort` house style) returning stale cards + a `stale` flag on the returned cards (each returned card is stale by construction — the result set IS the stale flag).
- **ε — graduation behavior:** BLOCK — `closeEffortReflection` returns `{ refused: "N stale decision(s) remain on <effort>…" }` while stale. Pinned by ticket 10 Resolution Q3. **Because the seam is async (β), `closeEffortReflection` becomes `async`** (return type `Promise<CloseEffortReflection | CloseEffortRefused>`); its sole non-test caller `commands.ts:handleWayfindDone` is already async (add one `await`), and the 3 existing `closeEffortReflection` assertions in `wayfinder.test.ts` each get one `await`. This is the only public-signature ripple in the plan and it is localized + mechanical. (The brief sketched a sync seam; that is infeasible against the real async store — `CardStore.getCard`/`getCardsByKind` are async-wrapped. Async is the honest resolution.)
- **ζ — sweep vs revalidate (cleaner of the brief's "pick one"):** the `session_start` sweep FLAGS stale (it calls `computeStaleness`, which is compare-only after the first-touch seed — it does NOT rebaseline drifted cards, which would wipe stale state every session_start and contradict γ). `refreshStaleness` is the explicit RE-VALIDATE primitive (re-baseline now) — called by the agent re-grill flow via the `planning_stale` tool's `revalidate` action (T6), NOT by the sweep. The sweep's observable write is seeding dep baselines for newly-mirrored cards (fixing "validated as of session start" snapshots so a dep change DURING the session is detectable at graduation).
- **StaleCard shape (minimal, duplicated across the seam — no shared import):** `{ cardId: string; effort: string; missingDeps?: string[] }`.
- **η — T4 dep source (Path B — REVISED from the verbatim T4 body):** the 06a store does NOT persist `card.graph` (`card.ts` documents `graph?` as "part of the TYPE but NOT persisted/indexed in 06a … round-trips as `undefined`"; `rowToCard` emits no `graph`; the `memories` table has no graph column). Therefore `computeStaleness` CANNOT source a card's deps from `store.getCard(id).graph.relations` — that path was always `[]`, so staleness was a **no-op** (the structural blocker that forced this amendment). **Path B:** deps are sourced by re-parsing the **git-canonical source `.md`** (Tier-1 md-wins) via a new additive `readSourceCard(store, cardId, fsRoot): Promise<Card | null>` helper, exported from `planning-sync-state.ts` alongside a newly-exported `sourcePathForId` — `readSourceCard` resolves the source path (`sourcePathForId`), reads the md bytes utf8 (absent → null), derives the kind from the id prefix, `store.serializerFor(kind).deserialize(bytes, {filePath})`, and `find(c => c.id === cardId)` (none → null). The deserialized card HAS `graph.relations` (the serializer populates `blocked-by`/`cites`/`depends_on`). `refreshPlanningCard` is refactored to call `readSourceCard` (behavior-preserving extract — its 09-impl tests gate the refactor). First-class `card.graph` persistence is DEFERRED to ticket 03 (graph layer, unbuilt). This mirrors `refreshPlanningCard`'s resolve→read→deserialize→find body, so it is self-contained (NO `memories` migration) and aligns with the md-wins model. T4 tests write a real source `.md` ticket file (+ its cited/`depends_on` dep files) under a temp fsRoot — mirroring `refreshPlanningCard`'s 09-impl test setup.

---

### Task 1: `depends_on` edge — parse + serializer emit

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.ts` (add `parseDependsOn`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.ts` (`ticketCard()` reads `depends_on`, emits frontmatter + `depends_on` relations)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.test.ts` (`parseDependsOn` cases)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.test.ts` (serializer emission — self-contained, inline bytes)

**Interfaces:**
- Produces: `parseDependsOn(raw: unknown): string[]` (planning-parse.ts) — mirrors `parseBlockedBy` BUT these are repo-relative PATHS (not ticket numbers): accept `string | string[]`; a string is split on commas/newlines; trim; drop empties; **NO zero-pad** (paths, not `NN` ticket nos).
- Produces: `ticketCard()` now also reads `data["depends_on"]` via `parseDependsOn`, sets `frontmatter.dependsOn` when non-empty, and pushes `{ s: selfId, rel: "depends_on", o: path }` for each (o = repo-relative path, like `cites`).

- [ ] **Step 1: Write the failing tests**

Append to `src/store/planning-parse.test.ts` (match the file's existing `describe`/`it` + `node:assert/strict` idiom; add `parseDependsOn` to the existing import from `./planning-parse.js`):
```ts
describe("parseDependsOn", () => {
  it("accepts an explicit array of repo-relative paths", () => {
    assert.deepEqual(
      parseDependsOn(["bun-apps/x/src/a.ts", "docs/spec.md"]),
      ["bun-apps/x/src/a.ts", "docs/spec.md"],
    );
  });
  it("accepts a single string path", () => {
    assert.deepEqual(parseDependsOn("python/mlx-movie-director/run.py"), ["python/mlx-movie-director/run.py"]);
  });
  it("accepts a comma/newline list and trims + drops empties", () => {
    assert.deepEqual(
      parseDependsOn("src/a.ts, src/b.ts\n , docs/c.md"),
      ["src/a.ts", "src/b.ts", "docs/c.md"],
    );
  });
  it("does NOT zero-pad (paths are not ticket numbers)", () => {
    // A path-like value is kept verbatim — no String(...).padStart(2,"0").
    assert.deepEqual(parseDependsOn("src/v0/thing.ts"), ["src/v0/thing.ts"]);
  });
  it("returns [] when absent / wrong type", () => {
    assert.deepEqual(parseDependsOn(undefined), []);
    assert.deepEqual(parseDependsOn(null), []);
    assert.deepEqual(parseDependsOn(42), []);
  });
});
```
Append to `src/store/planning-serializer.test.ts` (self-contained — inline bytes + a synthetic `filePath`, no fixture edit):
```ts
describe("PlanningTicketSerializer — depends_on edge (10-impl T1)", () => {
  const ser = new PlanningTicketSerializer();
  const EFF = "dep-edge-eff";
  const md = `---\ntype: task\nstatus: closed\nblocked by: 01\ndepends_on:\n  - bun-apps/hermes/src/store/card.ts\n  - docs/spec.md\n---\n# 02 — x\n\n## Resolution\nCites src/real/file.ts in body.\n`;
  it("emits depends_on paths as graph.relations (rel='depends_on')", () => {
    const [c] = ser.deserialize(md, { filePath: `.planning/${EFF}/tickets/02-x.md` });
    const rels = c!.graph?.relations ?? [];
    assert.ok(rels.some((r) => r.rel === "depends_on" && r.o === "bun-apps/hermes/src/store/card.ts"));
    assert.ok(rels.some((r) => r.rel === "depends_on" && r.o === "docs/spec.md"));
  });
  it("emits frontmatter.dependsOn (the parsed list)", () => {
    const [c] = ser.deserialize(md, { filePath: `.planning/${EFF}/tickets/02-x.md` });
    assert.deepEqual(c!.frontmatter.dependsOn, ["bun-apps/hermes/src/store/card.ts", "docs/spec.md"]);
  });
  it("blocked-by + cites are UNCHANGED alongside depends_on", () => {
    const [c] = ser.deserialize(md, { filePath: `.planning/${EFF}/tickets/02-x.md` });
    const rels = c!.graph?.relations ?? [];
    assert.ok(rels.some((r) => r.rel === "blocked-by" && r.o === `planning-ticket:${EFF}:01`));
    assert.ok(rels.some((r) => r.rel === "cites" && r.o === "src/real/file.ts"));
    assert.deepEqual(c!.frontmatter.blockedBy, ["01"]);
  });
  it("absent depends_on -> no depends_on relation + no frontmatter.dependsOn", () => {
    const noDeps = `---\ntype: task\nstatus: closed\n---\n# 03 — y\n\n## Resolution\nPlain.\n`;
    const [c] = ser.deserialize(noDeps, { filePath: `.planning/${EFF}/tickets/03-y.md` });
    const rels = c!.graph?.relations ?? [];
    assert.equal(rels.some((r) => r.rel === "depends_on"), false);
    assert.equal(c!.frontmatter.dependsOn, undefined);
  });
});
```
> NOTE: `extractCitedPaths` (already in planning-parse.ts) keys off the rooted-path prefixes `bun-apps|src|python|scripts|docs|tests|.planning` — so `bun-apps/hermes/src/store/card.ts` and `src/real/file.ts` in the body ARE picked up as `cites` (the test asserts `cites` is unchanged); the explicit `depends_on` list adds the `depends_on` relations on top. A path only in `depends_on` (e.g. `docs/spec.md`) becomes a `depends_on` relation; a path only in the body becomes `cites`. The aggregator (T3) treats BOTH `cites` + `depends_on` as deps.

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-parse.test.ts src/store/planning-serializer.test.ts )`
Expected: FAIL — `parseDependsOn` is not exported; `depends_on` relations/frontmatter absent.

- [ ] **Step 3: Add `parseDependsOn` to planning-parse.ts**

Append (next to `parseBlockedBy`):
```ts
/** Normalise a frontmatter `depends_on` value (string | string[]) → string[] of
 *  repo-relative PATHS (10-impl staleness dependency graph). Mirrors
 *  {@link parseBlockedBy} in SHAPE but NOT in semantics: these are file paths,
 *  NOT ticket numbers, so there is NO number-coercion and NO zero-pad. A string
 *  is split on commas/newlines (a single path stays whole); entries are trimmed
 *  and empties dropped. Wrong types → []. */
export function parseDependsOn(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}
```

- [ ] **Step 4: Emit `depends_on` in `ticketCard()`**

In `src/store/planning-serializer.ts`, add `parseDependsOn` to the existing import block from `./planning-parse.js`, then in `ticketCard()` read + emit (mirror the `blockedBy`/`citedPaths` blocks exactly):
```ts
  const dependsOn = parseDependsOn(data["depends_on"]);
```
In the `relations` build (right after the `citedPaths` loop):
```ts
  for (const path of dependsOn) {
    relations.push({ s: selfId, rel: "depends_on", o: path });
  }
```
In the `frontmatter` object (right after the `...(blockedBy.length > 0 ? { blockedBy } : {}),` spread):
```ts
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
```
(`graph` is already derived from `relations.length > 0` — adding `depends_on` edges extends it automatically; no other change.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-parse.test.ts src/store/planning-serializer.test.ts )`
Expected: PASS (new depends_on cases + existing blocked-by/cites/effort tests still green — T1 is purely additive).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): depends_on edge — parse + serializer emit (10-impl T1)"
```

**DoD:** `parseDependsOn` handles array/string/comma-list/absent (no zero-pad); `ticketCard()` emits `frontmatter.dependsOn` + `rel:"depends_on"` relations; existing `blocked-by` + `cites` emission unchanged; full suite green.

---

### Task 2: `card_dep_hash` table — DDL + idempotent migration + CardStore accessors

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` (append `card_dep_hash` CREATE TABLE + index to `SCHEMA_SQL`, right after the `card_md_hash` block)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts` (add `ensureCardDepHashTable(db)` next to `ensureCardMdHashTable`; call it in `initializeSchema` right after `ensureCardMdHashTable`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (add `getCardDepHash`/`upsertCardDepHash`/`deleteCardDepHash` to the `CardStore` interface + impl)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts` (fresh-DB + legacy-DB table tests + accessor round-trip — mirror the existing 09 T1 `card_md_hash` tests)

**Interfaces:**
- Produces: a new `card_dep_hash` table present on every DB (fresh + legacy), created idempotently.
- Produces (CardStore): `getCardDepHash(cardId): Promise<{ depHash: string; validatedAt: string } | null>`, `upsertCardDepHash(cardId, depHash): Promise<void>`, `deleteCardDepHash(cardId): Promise<void>` (kind-less — this table holds ONE aggregate row per card; no `kind` discriminator, unlike `card_md_hash`).
- DDL (canonical — appended to `SCHEMA_SQL` AND ensured by the migration):
  ```sql
  CREATE TABLE IF NOT EXISTS card_dep_hash (
    card_id TEXT PRIMARY KEY,
    dep_hash TEXT NOT NULL,
    validated_at DATE NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_card_dep_hash ON card_dep_hash(card_id);
  ```

- [ ] **Step 1: Write the failing tests (append to `__tests__/card-store.test.ts`)**

Append inside the existing top-level describe block (mirror the two `card_md_hash` table tests already in this file — same `RawDatabase` idiom):
```ts
  it("creates card_dep_hash on a fresh store open (10-impl T2)", async () => {
    const { RawDatabase } = await import("../src/store/sqlite/sqlite-backend.js");
    const raw = new RawDatabase(join(dir, "sessions.db"));
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_dep_hash'")
      .get() as { name?: string } | undefined;
    raw.close();
    assert.equal(row?.name, "card_dep_hash");
  });

  it("ensures card_dep_hash on a legacy (pre-10) DB via ensureCardDepHashTable", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "carddephash-migrate-"));
    try {
      const { RawDatabase } = await import("../src/store/sqlite/sqlite-backend.js");
      const raw = new RawDatabase(join(legacyDir, "sessions.db"));
      // A pre-10 DB: has memories + card_md_hash (post-09) but NO card_dep_hash.
      raw.exec(
        `CREATE TABLE memories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           target TEXT NOT NULL CHECK (target IN ('memory','user','failure','knowledge','planning-effort','planning-ticket')),
           content TEXT NOT NULL, created DATE NOT NULL, last_referenced DATE NOT NULL
         )`,
      );
      raw.exec(
        `CREATE TABLE card_md_hash (
           card_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
           mirrored_at DATE NOT NULL, kind TEXT NOT NULL DEFAULT 'mirror'
         )`,
      );
      raw.close();
      const migrated = await createCardStore({ memoryDir: legacyDir, dbBackend: "sqlite" });
      await migrated.close();
      const after = new RawDatabase(join(legacyDir, "sessions.db"));
      const row = after
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_dep_hash'")
        .get() as { name?: string } | undefined;
      after.close();
      assert.equal(row?.name, "card_dep_hash");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("card_dep_hash accessors round-trip (getCardDepHash/upsertCardDepHash/deleteCardDepHash)", async () => {
    assert.equal(await store.getCardDepHash("planning-ticket:e:01"), null);
    await store.upsertCardDepHash("planning-ticket:e:01", "deadbeefdeadbeef");
    const got = await store.getCardDepHash("planning-ticket:e:01");
    assert.equal(got?.depHash, "deadbeefdeadbeef");
    assert.ok(got?.validatedAt);
    // UPSERT overwrites (no kind discriminator — one aggregate row per card).
    await store.upsertCardDepHash("planning-ticket:e:01", "newhash0000000000");
    assert.equal((await store.getCardDepHash("planning-ticket:e:01"))?.depHash, "newhash0000000000");
    await store.deleteCardDepHash("planning-ticket:e:01");
    assert.equal(await store.getCardDepHash("planning-ticket:e:01"), null);
  });
```
> NOTE: `dir`, `store`, `createCardStore`, `mkdtempSync`, `join`, `tmpdir`, `rmSync`, `assert` are all already in scope in `card-store.test.ts` (the 09 `card_md_hash` tests use exactly these). `RawDatabase` is the exported `bun:sqlite` wrapper from `sqlite-backend.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Expected: FAIL — `card_dep_hash` table does not exist; `getCardDepHash` not on CardStore.

- [ ] **Step 3: Add the DDL to SCHEMA_SQL**

In `src/store/sqlite/schema.ts`, append IMMEDIATELY AFTER the `idx_card_md_hash_kind` index block (before the `session_assembly` table comment):
```sql
  -- 10-impl (knowledge-pipeline / ticket 10): per-card aggregate hash of a
  -- planning-card's cited+declared source-file deps (the staleness baseline).
  -- SEPARATE from card_md_hash because that table's card_id is the SOLE PK
  -- (taken by the mirror hash) — a kind='validated' row there would collide.
  -- ONE aggregate row per card (no kind discriminator).
  CREATE TABLE IF NOT EXISTS card_dep_hash (
    card_id TEXT PRIMARY KEY,
    dep_hash TEXT NOT NULL,
    validated_at DATE NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_card_dep_hash ON card_dep_hash(card_id);
```

- [ ] **Step 4: Add `ensureCardDepHashTable` + call it**

In `src/store/sqlite/sqlite-backend.ts`, add the private method IMMEDIATELY AFTER `ensureCardMdHashTable` (same house style — plain `CREATE TABLE IF NOT EXISTS`, simpler than the `memories` rebuild migrations; no data to carry):
```ts
  /** 10-impl (ticket 10): ensure the `card_dep_hash` table exists. Idempotent
   *  (CREATE TABLE IF NOT EXISTS). Additive — does NOT touch `memories` or
   *  `card_md_hash` (no C3 column-drift; no PK collision with the mirror hash). */
  private ensureCardDepHashTable(db: DatabaseLike): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_dep_hash (
        card_id TEXT PRIMARY KEY,
        dep_hash TEXT NOT NULL,
        validated_at DATE NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_dep_hash ON card_dep_hash(card_id);
    `);
  }
```
Then in `initializeSchema(db)`, add ONE line IMMEDIATELY AFTER the existing `this.ensureCardMdHashTable(db);` call (i.e. between `ensureCardMdHashTable` and `rebuildMemoryFts`):
```ts
    // Phase-2 (knowledge-pipeline / ticket 10): ensure the card_dep_hash table
    // for the staleness dependency-graph baseline. Idempotent (CREATE TABLE IF
    // NOT EXISTS). Additive — does NOT touch memories/card_md_hash.
    this.ensureCardDepHashTable(db);
```

- [ ] **Step 5: Add the accessors to CardStore**

In `src/store/card-store.ts`, extend the `CardStore` interface (additive — after `deleteCardMdHash`):
```ts
  /** 10-impl: read the stored dep-aggregate baseline hash for a card, or null. */
  getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null>;
  /** 10-impl: UPSERT a dep-aggregate baseline hash (SQLite ON CONFLICT DO UPDATE). */
  upsertCardDepHash(cardId: string, depHash: string): Promise<void>;
  /** 10-impl: delete the dep-aggregate baseline hash for a card. */
  deleteCardDepHash(cardId: string): Promise<void>;
```
Implement them on the `store` object (same `runWithTransientRetry(() => backend.withCorruptionRecovery(() => …))` envelope as `getCardMdHash`; `today()` is already imported):
```ts
    getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          const row = getDb()
            .prepare("SELECT dep_hash, validated_at FROM card_dep_hash WHERE card_id = ?")
            .get(cardId) as { dep_hash: string; validated_at: string } | undefined;
          return row ? { depHash: row.dep_hash, validatedAt: row.validated_at } : null;
        }),
      );
    },

    upsertCardDepHash(cardId: string, depHash: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `INSERT INTO card_dep_hash (card_id, dep_hash, validated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(card_id) DO UPDATE SET
                 dep_hash = excluded.dep_hash,
                 validated_at = excluded.validated_at`,
            )
            .run(cardId, depHash, today());
        }),
      );
    },

    deleteCardDepHash(cardId: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM card_dep_hash WHERE card_id = ?").run(cardId);
        }),
      );
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Expected: PASS (existing card-store tests + the 3 new card_dep_hash tests).

- [ ] **Step 7: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): card_dep_hash table + CardStore accessors (10-impl T2)"
```

**DoD:** `card_dep_hash` exists on fresh + legacy DBs; `memories` + `card_md_hash` schemas byte-identical (additive table only); the 3 accessors round-trip; full suite green.

---

### Task 3: dep aggregate hash + validated-baseline writer

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` (add `citedDeps` + `depAggregateHash` + `writeValidatedBaseline`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts` (aggregate-hash tests)

**Interfaces:**
- Consumes: `Card` (+ `CardGraph.relations`) from `./card.js`; `hashEntry` from `./merge-plan.js` (already imported); the T2 `CardStore.upsertCardDepHash`.
- Produces:
  - `citedDeps(card: Card): string[]` — distinct repo-relative paths from `card.graph.relations` where `rel ∈ {"cites","depends_on"}` (stable order: first-occurrence dedupe).
  - `depAggregateHash(card, fsRoot): Promise<{ hash: string; missing: string[] }>` — for each dep, `readFileSync(join(fsRoot, path))` → `hashEntry(bytes)`; an absent file → pushed to `missing[]` AND contributes the token `"<missing>"` to the aggregate; aggregate = `hashEntry(sorted(`${path}:${fileHashOrMissing}`).join("\n"))`.
  - `writeValidatedBaseline(store, card, fsRoot): Promise<{ hash: string; missing: string[] }>` — compute → `store.upsertCardDepHash(card.id, hash)`.

- [ ] **Step 1: Write the failing tests (append to `planning-sync-state.test.ts`)**

Add the three new functions to the existing import block from `./planning-sync-state.js` (`mkdirSync`/`writeFileSync`/`mkdtempSync`/`rmSync`/`createCardStore`/`Card` are ALREADY imported at the top of this file — reuse them):
```ts
import {
  planningContentHash,
  getStoredHash,
  upsertHash,
  deleteHash,
  refreshPlanningCard,
  refreshIfStale,
  citedDeps,            // 10-impl T3
  depAggregateHash,     // 10-impl T3
  writeValidatedBaseline, // 10-impl T3
} from "./planning-sync-state.js";
```
Append the describe block:
```ts
describe("dep aggregate hash (10-impl T3)", () => {
  const root = mkdtempSync(join(tmpdir(), "dephash-"));
  const mem = mkdtempSync(join(tmpdir(), "dephash-mem-"));
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  });

  // A card with two cited deps (one under src/, one under docs/) + a depends_on.
  const mkCard = (extraCites: string[] = []): Card => ({
    id: "planning-ticket:dep-eff:01",
    kind: "planning-ticket",
    content: "body",
    frontmatter: { id: "01", slug: "x", status: "closed" },
    graph: {
      relations: [
        { s: "planning-ticket:dep-eff:01", rel: "cites", o: "src/a.ts" },
        { s: "planning-ticket:dep-eff:01", rel: "cites", o: "docs/b.md" },
        { s: "planning-ticket:dep-eff:01", rel: "depends_on", o: "src/c.ts" },
        ...extraCites.map((o) => ({ s: "planning-ticket:dep-eff:01", rel: "cites" as const, o })),
      ],
    },
  });

  it("citedDeps returns distinct cites+depends_on paths (first-occurrence order)", () => {
    assert.deepEqual(citedDeps(mkCard()), ["src/a.ts", "docs/b.md", "src/c.ts"]);
    // duplicate path under cites + depends_on collapses to one.
    assert.deepEqual(citedDeps(mkCard(["src/a.ts"])), ["src/a.ts", "docs/b.md", "src/c.ts"]);
  });

  it("depAggregateHash is deterministic over sorted deps", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "AAA");
    writeFileSync(join(root, "docs", "b.md"), "BBB");
    writeFileSync(join(root, "src", "c.ts"), "CCC");
    const h1 = await depAggregateHash(mkCard(), root);
    const h2 = await depAggregateHash(mkCard(), root);
    assert.equal(h1.hash, h2.hash);
    assert.match(h1.hash, /^[0-9a-f]{16}$/);
    assert.deepEqual(h1.missing, []);
  });

  it("a changed dep file -> different aggregate", async () => {
    const before = await depAggregateHash(mkCard(), root);
    writeFileSync(join(root, "src", "a.ts"), "AAA-EDITED");
    const after = await depAggregateHash(mkCard(), root);
    assert.notEqual(before.hash, after.hash);
  });

  it("a missing dep -> missing[] non-empty + aggregate reflects <missing>", async () => {
    const r = await depAggregateHash(mkCard(), root); // src/c.ts still exists
    assert.deepEqual(r.missing, []);
    writeFileSync(join(root, "src", "gone.ts"), "G");
    const card = { ...mkCard(), graph: { relations: [{ s: "x", rel: "depends_on", o: "src/gone.ts" }] } };
    const presentHash = (await depAggregateHash(card, root)).hash;
    rmSync(join(root, "src", "gone.ts"));
    const r2 = await depAggregateHash(card, root);
    assert.deepEqual(r2.missing, ["src/gone.ts"]);
    assert.notEqual(presentHash, r2.hash); // <missing> token changes the aggregate
  });

  it("writeValidatedBaseline writes via upsertCardDepHash (card_dep_hash, kind-less)", async () => {
    const store = await createCardStore({ memoryDir: mem });
    try {
      const card = mkCard();
      const { hash, missing } = await writeValidatedBaseline(store, card, root);
      assert.deepEqual(missing, []);
      const row = await store.getCardDepHash(card.id);
      assert.equal(row?.depHash, hash);
      assert.ok(row?.validatedAt);
    } finally {
      await store.close();
    }
  });
});
```
> NOTE: `mkdtempSync`, `rmSync`, `join`, `tmpdir`, `assert`, `createCardStore`, `Card` are all already imported at the top of `planning-sync-state.test.ts` (the existing suites use them). `mkdirSync`/`writeFileSync` are added by this step's import edit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: FAIL — `citedDeps`/`depAggregateHash`/`writeValidatedBaseline` not exported.

- [ ] **Step 3: Implement the three functions**

Append to `src/store/planning-sync-state.ts` (`readFileSync` is already imported; `join` is already imported; `hashEntry` + `Card`/`CardStore` types are already imported):
```ts
// ─── 10-impl staleness: dep aggregate hash + validated baseline ─────────────
//
// The staleness baseline is ONE aggregate row per card in card_dep_hash =
// hashEntry(sorted(cited+depends_on source-file bytes)). Distinct from 09's
// card_md_hash (which hashes the CARD's own bytes); this hashes the bytes of
// the files the card's decision DEPENDS ON, so a change to a cited/declared
// source file flips the card stale even when the card's own md is unchanged.

/** Distinct repo-relative dep paths carried by a card's graph.relations
 *  (rel ∈ {"cites","depends_on"}). First-occurrence dedupe → stable order. */
export function citedDeps(card: Card): string[] {
  const rels = card.graph?.relations ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rels) {
    if ((r.rel === "cites" || r.rel === "depends_on") && !seen.has(r.o)) {
      seen.add(r.o);
      out.push(r.o);
    }
  }
  return out;
}

/** Aggregate content-hash of a card's deps under fsRoot. For each dep path,
 *  read join(fsRoot, path): present → hashEntry(bytes); absent → recorded in
 *  `missing` AND contributes the token "<missing>" (so a file reappearing or
 *  vanishing changes the aggregate). Aggregate = hashEntry of the sorted
 *  `${path}:${hashOrToken}` entries joined by "\n" — deterministic over the
 *  dep SET regardless of relation order. A card with NO deps hashes the empty
 *  string (stable → never stale by dep-change, which is correct: nothing to
 *  depend on). */
export async function depAggregateHash(
  card: Card,
  fsRoot: string,
): Promise<{ hash: string; missing: string[] }> {
  const deps = citedDeps(card);
  const missing: string[] = [];
  const entries = deps.map((path) => {
    let fileHash: string;
    try {
      fileHash = hashEntry(readFileSync(join(fsRoot, path), "utf8"));
    } catch {
      missing.push(path);
      fileHash = "<missing>";
    }
    return `${path}:${fileHash}`;
  });
  entries.sort();
  return { hash: hashEntry(entries.join("\n")), missing };
}

/** Compute the dep aggregate + UPSERT it as the card's validated baseline
 *  (the staleness reference). This is the RE-VALIDATE write — call it when an
 *  agent re-grills + re-validates a decision (clears stale). The on-access
 *  computeStaleness (T4) uses depAggregateHash WITHOUT writing except the
 *  first-touch seed. */
export async function writeValidatedBaseline(
  store: CardStore,
  card: Card,
  fsRoot: string,
): Promise<{ hash: string; missing: string[] }> {
  const { hash, missing } = await depAggregateHash(card, fsRoot);
  await store.upsertCardDepHash(card.id, hash);
  return { hash, missing };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: PASS (new aggregate tests + existing content-hash/refresh tests still green — additive).

- [ ] **Step 5: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): dep aggregate hash + validated-baseline writer (10-impl T3)"
```

**DoD:** `citedDeps` dedupes cites+depends_on; `depAggregateHash` is deterministic + changes on a dep edit + reflects `<missing>` for absent deps; `writeValidatedBaseline` writes via `upsertCardDepHash`; full suite green.

---

### Task 4: staleness computation module

> **Path B amendment (decision η):** the verbatim T4 body below sourced deps from `store.getCard(id).graph.relations`, but the 06a store does NOT persist `card.graph` (`card.ts`: "round-trips as `undefined"`; `rowToCard` emits no `graph`). That path was always `[]` → staleness was a no-op. **Path B:** deps come from re-parsing the git-canonical source `.md` via a new `readSourceCard` helper (exported from `planning-sync-state.ts` alongside a newly-exported `sourcePathForId`). Tests write a real source `.md` ticket file under a temp fsRoot. See decision η above.

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` (**export** `sourcePathForId`; **add** additive `readSourceCard(store, cardId, fsRoot): Promise<Card | null>`; **refactor** `refreshPlanningCard` to call it — behavior-preserving extract gated by its 09-impl tests)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-staleness.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-staleness.test.ts`

**Interfaces:**
- Consumes: `CardStore` (incl. T2 `getCardDepHash`/`upsertCardDepHash` + `getCardsByKind`); `readSourceCard` + `depAggregateHash` + `writeValidatedBaseline` from `./planning-sync-state.js`; `Card` from `./card.js`.
- Produces:
  - `StaleCard` (exported) = `{ cardId: string; effort: string; missingDeps?: string[] }`.
  - `computeStaleness(store, cardId, fsRoot): Promise<{ stale: boolean; missing: string[] }>` — `readSourceCard` (re-parse the source `.md`); unresolvable → `{stale:false,missing:[]}` (can't validate → not stale; NO baseline written); the deserialized card HAS `graph.relations`; compute current `depAggregateHash`; read stored `getCardDepHash`; FIRST check (no stored baseline) → seed it via `writeValidatedBaseline`, return `{stale:false,missing}`; else `stale = current.hash !== stored.depHash || missing.length > 0` (NO write — a stale card stays flagged until explicitly re-validated via T5 `refreshStaleness`).
  - `getStaleCards(store, effort?, fsRoot): Promise<StaleCard[]>` — `getCardsByKind("planning-ticket")` (enumeration — card ids only, NO graph needed); optional effort filter (derive effort from the ticket card id); `computeStaleness` each; map stale → `StaleCard`.

- [ ] **Step 1: Write the failing test (Path B — see decision η)**

> **Path B:** deps come from a real source `.md` (re-parsed via `readSourceCard`), NOT from an inline `graph` on a store row (the 06a store does not persist `card.graph`). So the test writes a real `.planning/<effort>/tickets/01-<slug>.md` (+ its cited + `depends_on` dep files) under a temp fsRoot — mirroring `refreshPlanningCard`'s 09-impl test. `computeStaleness` does NOT read the card from the store (only `getCardDepHash`/`upsertCardDepHash`); `getStaleCards` enumerates via `store.getCardsByKind("planning-ticket")`, so a card is `store.upsertCard`'d for THAT test only (its row needs NO graph).

Create `src/store/planning-staleness.test.ts` (sketch — the committed file is authoritative):
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { computeStaleness, getStaleCards } from "./planning-staleness.js";
import { createCardStore } from "./card-store.js";

// Helper: write a source .md that cites `citesPath` in the body + declares
// `depends_on: <depPath>` in frontmatter, plus writes BOTH dep files (v1).
// ticketCard() emits a `cites` + a `depends_on` relation -> citedDeps =
// [citesPath, depPath]. Returns the ticket card id.
function seedSource(root: string, effort: string, citesPath: string, depPath: string): string {
  const ticketPath = join(root, ".planning", effort, "tickets", "01-dep-ticket.md");
  mkdirSync(dirname(ticketPath), { recursive: true });
  writeFileSync(
    ticketPath,
    `---\ntype: task\nstatus: closed\ndepends_on: ${depPath}\n---\n# 01 — dep-ticket\n\n## Resolution\n\nThis decision cites ${citesPath} in the body.\n`,
  );
  for (const p of [citesPath, depPath]) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), "v1");
  }
  return `planning-ticket:${effort}:01`;
}
// Each `it` uses FRESH temp dirs (root + mem) + cleanup — no cross-test state.
//
// Cases (all under computeStaleness unless noted):
//  • unresolvable cardId (no source .md) -> {stale:false, missing:[]} + NO baseline written
//    (assert getCardDepHash is null).
//  • first touch -> {stale:false} AND seeds card_dep_hash (assert getCardDepHash non-null);
//    second call w/ deps UNCHANGED -> {stale:false}.
//  • a cited dep file CHANGED (writeFileSync src/a.ts = "v2") -> {stale:true};
//    second call STILL stale (compare-only, NO rebaseline).
//  • a depends_on dep file MISSING (rm src/b.ts) -> {stale:true, missing:["src/b.ts"]}.
//  • getStaleCards: two efforts each w/ OWN dep files; clean-eff -> []; drift stale-eff's
//    cited dep -> only stale-eff surfaced w/ {cardId, effort}; effort filter scopes;
//    vanish a dep -> missingDeps populated.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-staleness.test.ts )`
Expected: FAIL — `readSourceCard` is not exported (module cannot resolve the dep source).

- [ ] **Step 3: Write the module + the `readSourceCard` helper (Path B)**

First, in `src/store/planning-sync-state.ts`: **export** `sourcePathForId` (`function` → `export function`); **add** an additive `readSourceCard` (factored from `refreshPlanningCard`'s resolve→read→deserialize→find body); and **refactor** `refreshPlanningCard` to call `readSourceCard` (behavior-preserving — its 09-impl tests gate the refactor; if risky, leave `refreshPlanningCard` as-is and inline in `computeStaleness`).
```ts
// in planning-sync-state.ts
export function sourcePathForId(cardId: string, fsRoot: string): string | null { /* unchanged body */ }

/** Path B (η): re-parse the git-canonical source .md for cardId -> the Card
 *  (which HAS graph.relations; the 06a store row does not). null when the source
 *  is unresolvable / unreadable / the id is not in the file. Mirrors
 *  refreshPlanningCard's resolve→read→deserialize→find body. */
export async function readSourceCard(store: CardStore, cardId: string, fsRoot: string): Promise<Card | null> {
  const src = sourcePathForId(cardId, fsRoot);
  if (!src) return null;
  let bytes: string;
  try { bytes = readFileSync(src, "utf8"); } catch { return null; }
  const kind = cardId.startsWith("planning-effort:") ? "planning-effort"
    : cardId.startsWith("planning-ticket:") ? "planning-ticket" : null;
  if (!kind) return null;
  const serializer = store.serializerFor(kind);
  if (!serializer) return null;
  const cards = serializer.deserialize(bytes, { filePath: src });
  return cards.find((c) => c.id === cardId) ?? null;
}
// refreshPlanningCard now begins: const card = await readSourceCard(store, cardId, fsRoot);
//   if (!card) return { action: "absent" }; …(rest unchanged)
```

Create `src/store/planning-staleness.ts` (the dep source is `readSourceCard`, NOT `store.getCard`):
```ts
import type { CardStore } from "./card-store.js";
import { depAggregateHash, readSourceCard, writeValidatedBaseline } from "./planning-sync-state.js";

export interface StaleCard { cardId: string; effort: string; missingDeps?: string[] }

function effortOfTicketCardId(cardId: string): string | null {
  if (!cardId.startsWith("planning-ticket:")) return null;
  const rest = cardId.slice("planning-ticket:".length);
  const sep = rest.lastIndexOf(":");
  return sep > 0 ? rest.slice(0, sep) : null;
}

export async function computeStaleness(
  store: CardStore, cardId: string, fsRoot: string,
): Promise<{ stale: boolean; missing: string[] }> {
  const card = await readSourceCard(store, cardId, fsRoot); // Path B: deps from source .md
  if (!card) return { stale: false, missing: [] };          // unresolvable -> can't validate -> not stale
  const { hash: current, missing } = await depAggregateHash(card, fsRoot);
  const stored = await store.getCardDepHash(cardId);
  if (!stored) {                                            // FIRST touch -> seed
    await writeValidatedBaseline(store, card, fsRoot);
    return { stale: false, missing };
  }
  return { stale: current !== stored.depHash || missing.length > 0, missing }; // compare-only
}

export async function getStaleCards(
  store: CardStore, effort: string | undefined, fsRoot: string,
): Promise<StaleCard[]> {
  const tickets = await store.getCardsByKind("planning-ticket");
  const out: StaleCard[] = [];
  for (const card of tickets) {
    const cardEffort = effortOfTicketCardId(card.id);
    if (!cardEffort) continue;
    if (effort && cardEffort !== effort) continue;
    const { stale, missing } = await computeStaleness(store, card.id, fsRoot);
    if (stale) out.push({ cardId: card.id, effort: cardEffort, ...(missing.length > 0 ? { missingDeps: missing } : {}) });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-staleness.test.ts )`
Expected: PASS.

- [ ] **Step 5: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-staleness.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-staleness.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): staleness computation module — Path B, deps from source .md (10-impl T4)"
```

**DoD (Path B):** deps sourced from `readSourceCard` (re-parse of source `.md`), NOT `store.getCard().graph`; unresolvable source → `{stale:false}` + NO baseline; first touch seeds baseline (`writeValidatedBaseline`) → `{stale:false}`; second unchanged call → `{stale:false}`; a cited dep changed → `{stale:true}` (compare-only, no rebaseline); a `depends_on` dep missing → `{stale:true, missing:[path]}`; `getStaleCards` surfaces only stale tickets w/ effort + `missingDeps`, effort filter scopes, clean effort → `[]`; `refreshPlanningCard` behavior preserved (its 09-impl tests green); full suite green (only the known date-aging time-bomb fail unchanged).

---

### Task 5: on-access refresh + background-sweep hooks

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` (add `refreshStaleness` — the explicit RE-VALIDATE primitive)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.ts` (add a staleness pass inside `schedulePlanningBackfill`'s deferred block that calls `computeStaleness` to FLAG + seed)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts` (`refreshStaleness` tests)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.test.ts` (sweep-flags-stale test)

**Interfaces:**
- Produces: `refreshStaleness(store, cardId, fsRoot): Promise<boolean>` — returns whether the dep HAD drifted relative to the OLD baseline AND re-baselines to current (the re-validate write, clearing the flag). Called by the `planning_stale` tool's `revalidate` action (T6); NOT by the sweep. Mirrors `refreshIfStale`'s boolean envelope; Path B (η) — deps come from `readSourceCard` (re-parse of the source `.md`), NOT `store.getCard` (the 06a store row drops `graph`).
- Produces: the `schedulePlanningBackfill` deferred block gains a staleness pass that iterates `getCardsByKind("planning-ticket")` and calls `computeStaleness` (FLAG + first-touch seed — NO rebaseline, per ζ).

> **Design choice (ζ — pinned):** the sweep FLAGS via `computeStaleness` (compare-only after the first-touch seed), so stale state persists across sessions. It does NOT call `refreshStaleness` (a sweep that re-baselines every card on each `session_start` would wipe stale state, contradicting γ). The sweep's observable WRITE is seeding dep baselines for newly-mirrored cards — fixing "validated as of session start" snapshots so a dep change DURING the session is detectable at graduation. `refreshStaleness` is the explicit re-validate op (agent re-grill flow).

- [ ] **Step 1: Write the failing tests**

Append to `planning-sync-state.test.ts` (add `refreshStaleness` to the existing import from `./planning-sync-state.js`):
```ts
describe("refreshStaleness (10-impl T5 — sole re-validate primitive)", () => {
  /** Write a ticket source .md (depends_on: src/d.ts) + the dep file at `v`. */
  const seedTicket = (root: string, effort: string, depContent: string): string => {
    mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
    writeFileSync(
      join(root, ".planning", effort, "tickets", "01-x.md"),
      "---\ntype: task\nstatus: closed\ndepends_on: src/d.ts\n---\n# 01 — x\n\n## Resolution\n\nDepends on src/d.ts.\n",
    );
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "d.ts"), depContent);
    return `planning-ticket:${effort}:01`;
  };

  it("reports stale=true + clears the flag when the dep had drifted (re-baseline to current)", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-drift-"));
    const mem = mkdtempSync(join(tmpdir(), "refresh-drift-mem-"));
    try {
      const id = seedTicket(root, "drift-eff", "v1");
      const store = await createCardStore({ memoryDir: mem });
      try {
        // Seed the baseline @ v1 (first-touch computeStaleness seeds, NOT stale).
        assert.equal((await computeStaleness(store, id, root)).stale, false);
        // Drift the dep AFTER the baseline is seeded.
        writeFileSync(join(root, "src", "d.ts"), "v2-EDITED");
        assert.equal((await computeStaleness(store, id, root)).stale, true, "precondition: dep change flags stale");
        // Re-validate: reports it HAD drifted + re-baselines to current (clears).
        const wasStale = await refreshStaleness(store, id, root);
        assert.equal(wasStale, true, "reports it HAD drifted relative to the old baseline");
        // ...and the re-baseline cleared the flag against current bytes:
        assert.equal(
          (await computeStaleness(store, id, root)).stale,
          false,
          "re-validate clears the flag against current bytes",
        );
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("reports stale=false + leaves the baseline value unchanged when the dep is current", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-clean-"));
    const mem = mkdtempSync(join(tmpdir(), "refresh-clean-mem-"));
    try {
      const id = seedTicket(root, "clean-eff", "v1");
      const store = await createCardStore({ memoryDir: mem });
      try {
        // Seed baseline @ v1.
        await computeStaleness(store, id, root);
        const before = await store.getCardDepHash(id);
        assert.ok(before, "precondition: baseline seeded");
        // Re-validate WITHOUT changing the dep -> false + baseline value unchanged
        // (writeValidatedBaseline is an idempotent UPSERT of the same hash).
        const wasStale = await refreshStaleness(store, id, root);
        assert.equal(wasStale, false, "no drift -> false");
        const after = await store.getCardDepHash(id);
        assert.equal(after?.depHash, before?.depHash, "baseline depHash value unchanged (idempotent re-write)");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("returns false + writes NO baseline for an unresolvable source", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-absent-"));
    const mem = mkdtempSync(join(tmpdir(), "refresh-absent-mem-"));
    try {
      const store = await createCardStore({ memoryDir: mem });
      try {
        const wasStale = await refreshStaleness(store, "planning-ticket:nope:99", root);
        assert.equal(wasStale, false);
        assert.equal(
          await store.getCardDepHash("planning-ticket:nope:99"),
          null,
          "no baseline written for an unresolvable source",
        );
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```
> NOTE (Path B, decision η): each case writes a REAL source `.md` ticket (`depends_on: src/d.ts`) under a per-case temp fsRoot + the dep file, then seeds the baseline via `computeStaleness` (first touch). `refreshStaleness` re-parses that source `.md` (NOT `store.getCard().graph` — the 06a store drops `graph`), so the seed must be a real file. This describe imports `computeStaleness` (to seed + to probe post-revalidate cleanliness); add it once at the top of the file:
```ts
import { computeStaleness } from "./planning-staleness.js";
```

Append the sweep test to `src/handlers/planning-backfill.test.ts` (this file lives at `src/handlers/`, so imports of store modules are `../store/...` — NOT `../src/store/...`; verified against the existing file header, which even carries a NOTE about this exact path). `createCardStore`, `mkdtempSync`, `mkdirSync`, `writeFileSync`, `rmSync`, `join`, `tmpdir`, `assert`, `schedulePlanningBackfill` are ALREADY imported at the top of the file — reuse them; add ONLY the one new import:
```ts
import { getStaleCards } from "../store/planning-staleness.js";
```
The new test mirrors the existing "re-mirrors a changed planning md" shape (the `flushedState()` + inline `flush` setTimeout idiom already in the file) but asserts the sweep flags a card stale after its dep changes:

it("staleness sweep flags a card stale after its dep changes (10-impl T5)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pbf-stale-"));
  const mem = mkdtempSync(join(tmpdir(), "pbf-stale-mem-"));
  const state = { inProgress: false, promise: null as Promise<void> | null };
  const flush = (cb: () => void) => cb();
  try {
    const effort = "sweep-eff";
    mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "dep.ts"), "v1");
    writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
      "---\ntype: task\nstatus: closed\ndepends_on:\n  - src/dep.ts\n---\n# 01 — x\n\n## Resolution\nDepends on src/dep.ts.\n");
    // 1st sweep: mirror + seed the dep baseline @ v1.
    schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
    await state.promise;
    // Change the dep AFTER the baseline is seeded.
    writeFileSync(join(root, "src", "dep.ts"), "v2-EDITED");
    // 2nd sweep: flags stale (compare-only; no rebaseline).
    state.inProgress = false; state.promise = null;
    schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
    await state.promise;
    const store = await createCardStore({ memoryDir: mem });
    try {
      const stale = await getStaleCards(store, effort, root);
      assert.ok(stale.some((s) => s.cardId === `planning-ticket:${effort}:01`), "edited dep must flag the card stale");
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts src/handlers/planning-backfill.test.ts )`
Expected: FAIL — `refreshStaleness` not exported; sweep does not flag stale.

- [ ] **Step 3: Implement `refreshStaleness`**

Append to `src/store/planning-sync-state.ts` (`depAggregateHash` is local from T3):
```ts
/** Explicit RE-VALIDATE of ONE card (the agent re-grill flow — T6's `planning_stale`
 *  tool `revalidate` action): recompute the dep aggregate, report whether it HAD
 *  drifted relative to the OLD baseline, AND re-baseline to the CURRENT bytes
 *  (clearing the stale flag). This is the SOLE re-baseline op — distinct from
 *  {@link computeStaleness} (planning-staleness.ts), which is compare-only after
 *  the first-touch seed and NEVER clears a stale flag.
 *
 *  Path B (decision η): deps come from {@link readSourceCard} (a re-parse of the
 *  git-canonical source .md → graph.relations), NOT `store.getCard` (whose row
 *  drops `graph`, so `depAggregateHash` would hash the empty aggregate and never
 *  detect drift). An unresolvable source → `false` + NO write (cannot validate
 *  what we cannot read). Mirrors {@link refreshIfStale}'s boolean envelope.
 *
 *  The `session_start` sweep (planning-backfill.ts) does NOT call this — it flags
 *  via `computeStaleness` so stale state PERSISTS across sessions (decision ζ); a
 *  re-baselining sweep would wipe stale state every session start. Returns `true`
 *  iff re-validation cleared a stale state: the card HAD a stored baseline whose
 *  dep hash differs from the current aggregate, OR a dep is currently missing
 *  (a vanishing dep is itself a stale signal that survives re-baselining). */
export async function refreshStaleness(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<boolean> {
  const card = await readSourceCard(store, cardId, fsRoot);
  if (!card) return false;
  const { hash: current, missing } = await depAggregateHash(card, fsRoot);
  const stored = await store.getCardDepHash(cardId);
  const wasStale = stored !== null && (current !== stored.depHash || missing.length > 0);
  // Re-baseline NOW to the CURRENT bytes: the NEXT change after this point is
  // what re-flags stale. writeValidatedBaseline recomputes the aggregate once
  // more (deterministic, idempotent — matches computeStaleness's first-touch path).
  await writeValidatedBaseline(store, card, fsRoot);
  return wasStale;
}
```

- [ ] **Step 4: Add the staleness pass to `schedulePlanningBackfill`**

In `src/handlers/planning-backfill.ts`, add imports at the top (alongside the existing `walkAndIngest` import):
```ts
import { createCardStore } from "../store/card-store.js";
import { computeStaleness } from "../store/planning-staleness.js";
```
Inside the deferred `setTimeoutFn(async () => { … })` block, AFTER the existing `await walkAndIngest(files, { memoryDir, planningOnly: true, partialWalk: true });` call (and BEFORE the success `notifyBestEffort`), add the staleness pass (best-effort — wrapped so a failure NEVER breaks the mirror/backfill):
```ts
        // 10-impl T5: staleness sweep — seed dep baselines for newly-mirrored
        // cards + FLAG stale (compare-only after the first-touch seed). Does NOT
        // rebaseline drifted cards (that would wipe stale state every session
        // start, contradicting γ); re-baselining is the explicit refreshStaleness
        // op. Best-effort: a staleness failure must never break the mirror.
        try {
          const stStore = await createCardStore({ memoryDir });
          try {
            const tickets = await stStore.getCardsByKind("planning-ticket");
            for (const t of tickets) {
              try {
                await computeStaleness(stStore, t.id, repoRoot);
              } catch {
                /* one bad card must not abort the sweep */
              }
            }
          } finally {
            await stStore.close();
          }
        } catch {
          /* staleness sweep is best-effort */
        }
```
> `repoRoot` is the `schedulePlanningBackfill(repoRoot, memoryDir, …)` first arg — the fs root for resolving cited/declared dep paths (the same root `walkAndIngest` scopes to). `memoryDir` is the second arg.

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts src/handlers/planning-backfill.test.ts )`
Expected: PASS (refreshStaleness clears the flag; sweep flags stale after a dep change; existing backfill tests still green).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.ts bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): staleness refresh + session_start sweep (10-impl T5)"
```

**DoD:** `refreshStaleness` reports drift + re-baselines (clearing the flag); the `session_start` sweep flags a card stale after its dep changes (no rebaseline); existing mirror backfill unchanged; full suite green.

---

### Task 6: `stale:` flag + query (hermes)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/tools/planning-stale-tool.ts` (a new additive `planning_stale` tool — standalone, mirroring `knowledge_search`/`wayfind_effort` house style; `memory-tool.ts` is `@ts-nocheck` and carries no prefix-query grammar, so a standalone tool is the cleanest additive surface)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/tools/planning-stale-tool.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` (register the tool alongside the other knowledge tools)

**Interfaces:**
- Consumes: `getStaleCards`/`StaleCard` from `../store/planning-staleness.js`; `refreshStaleness` from `../store/planning-sync-state.js`; `createCardStore` from `../store/card-store.js`.
- Produces:
  - `parseStaleQuery(query: string): { effort?: string }` — `"stale"` → `{}`; `"stale:<effort>"` → `{ effort }`; anything else → `{}` (lenient — an unknown prefix is treated as unscoped).
  - `runStaleQuery(memoryDir, query, fsRoot): Promise<{ ok; stale: StaleCard[]; error? }>` — pure resolver (no pi API) wrapping `getStaleCards`; opens an ephemeral store. Each returned card is stale by construction (the result set IS the `stale` flag — δ).
  - `revalidateCard(memoryDir, cardId, fsRoot): Promise<{ ok; stale; missing; error? }>` — pure resolver wrapping `refreshStaleness` (the agent re-grill "re-validate" step — Q3).
  - `registerPlanningStaleTool(pi, { memoryDir })` — the `planning_stale` tool with actions `query` (`query` param: `"stale"` / `"stale:<effort>"`) and `revalidate` (`cardId` param).

- [ ] **Step 1: Write the failing test**

Create `src/tools/planning-stale-tool.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseStaleQuery, runStaleQuery, revalidateCard } from "./planning-stale-tool.js";
import { createCardStore } from "../store/card-store.js";
import { computeStaleness } from "../store/planning-staleness.js";

/** Write a dep file under root (creating its parent dir). Mirrors T4's writeDep. */
function writeDep(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Write a source .md ticket that cites `citesPath` in the body + declares
 *  `depends_on: <depPath>` in frontmatter, plus writes BOTH dep files (v1).
 *  Returns the ticket card id `planning-ticket:<effort>:01`. Mirrors T4's
 *  seedSource — the deserialized card carries a `cites` + a `depends_on` relation
 *  so citedDeps = [citesPath, depPath]. */
function seedSource(root: string, effort: string, citesPath: string, depPath: string): string {
  const ticketPath = join(root, ".planning", effort, "tickets", "01-stale-ticket.md");
  mkdirSync(dirname(ticketPath), { recursive: true });
  writeFileSync(
    ticketPath,
    `---\ntype: task\nstatus: closed\ndepends_on: ${depPath}\n---\n# 01 — stale-ticket\n\n## Resolution\n\nThis decision cites ${citesPath} in the body.\n`,
  );
  writeDep(root, citesPath, "v1");
  writeDep(root, depPath, "v1");
  return `planning-ticket:${effort}:01`;
}

/** Seed a ticket into the store at `mem`: write the source .md + dep files, upsert
 *  the ticket ROW (id only — the row needs NO graph; getStaleCards enumerates via
 *  getCardsByKind), and seed the dep baseline via computeStaleness (first touch). */
async function seedTicket(
  root: string,
  mem: string,
  effort: string,
  citesPath: string,
  depPath: string,
): Promise<string> {
  const id = seedSource(root, effort, citesPath, depPath);
  const store = await createCardStore({ memoryDir: mem });
  try {
    await store.upsertCard({
      id,
      kind: "planning-ticket",
      content: "",
      frontmatter: { id: "01" },
    });
    await computeStaleness(store, id, root); // seed baseline @ v1
  } finally {
    await store.close();
  }
  return id;
}

describe("parseStaleQuery", () => {
  it("'stale' -> unscoped", () => assert.deepEqual(parseStaleQuery("stale"), {}));
  it("'stale:<effort>' -> scoped", () =>
    assert.deepEqual(parseStaleQuery("stale:my-effort"), { effort: "my-effort" }));
  it("unknown prefix -> lenient unscoped", () => assert.deepEqual(parseStaleQuery("anything"), {}));
  it("empty -> unscoped", () => assert.deepEqual(parseStaleQuery(""), {}));
  it("nullish -> unscoped (lenient)", () => assert.deepEqual(parseStaleQuery(undefined as unknown as string), {}));
});

describe("runStaleQuery (10-impl T6)", () => {
  it("query (no effort) returns only stale cards; clean excluded; empty effort -> []", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-root-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-mem-"));
    try {
      const staleId = await seedTicket(root, mem, "q-eff", "src/stale-a.ts", "src/stale-b.ts");
      const cleanId = await seedTicket(root, mem, "clean-eff", "src/clean-a.ts", "src/clean-b.ts");
      // drift ONLY the q-eff cited dep (clean-eff stays at v1).
      writeFileSync(join(root, "src", "stale-a.ts"), "v2-EDITED");

      const all = await runStaleQuery(mem, "stale", root);
      assert.equal(all.ok, true);
      assert.ok(all.stale.some((s) => s.cardId === staleId), "stale card surfaced");
      assert.ok(!all.stale.some((s) => s.cardId === cleanId), "clean card excluded");

      // scoped to an effort with no tickets -> []
      const scoped = await runStaleQuery(mem, "stale:nope-eff", root);
      assert.equal(scoped.ok, true);
      assert.deepEqual(scoped.stale, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("'stale:<effort>' returns only that effort's stale cards", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-scope-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-scope-mem-"));
    try {
      const effOne = await seedTicket(root, mem, "eff-one", "src/o-a.ts", "src/o-b.ts");
      const effTwo = await seedTicket(root, mem, "eff-two", "src/t-a.ts", "src/t-b.ts");
      // drift BOTH — only the scoped one should surface for "stale:eff-one".
      writeFileSync(join(root, "src", "o-a.ts"), "v2-EDITED");
      writeFileSync(join(root, "src", "t-a.ts"), "v2-EDITED");

      const scoped = await runStaleQuery(mem, "stale:eff-one", root);
      assert.equal(scoped.ok, true);
      assert.equal(scoped.stale.length, 1, "only eff-one's stale card");
      assert.equal(scoped.stale[0]!.cardId, effOne);
      assert.equal(scoped.stale[0]!.effort, "eff-one");

      const scopedTwo = await runStaleQuery(mem, "stale:eff-two", root);
      assert.equal(scopedTwo.stale.length, 1);
      assert.equal(scopedTwo.stale[0]!.cardId, effTwo);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("a vanishing dep surfaces missingDeps on the StaleCard", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-miss-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-miss-mem-"));
    try {
      const id = await seedTicket(root, mem, "miss-eff", "src/gone-a.ts", "src/gone-b.ts");
      rmSync(join(root, "src", "gone-b.ts")); // depends_on dep vanishes

      const r = await runStaleQuery(mem, "stale:miss-eff", root);
      assert.equal(r.ok, true);
      assert.equal(r.stale.length, 1);
      assert.equal(r.stale[0]!.cardId, id);
      assert.deepEqual(r.stale[0]!.missingDeps, ["src/gone-b.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("revalidateCard (10-impl T6)", () => {
  it("on a stale card -> {ok:true, stale:true} AND clears staleness", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-rev-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-rev-mem-"));
    try {
      const id = await seedTicket(root, mem, "rev-eff", "src/r-a.ts", "src/r-b.ts");
      writeFileSync(join(root, "src", "r-a.ts"), "v2-EDITED"); // drift

      // before revalidate the query lists it
      const before = await runStaleQuery(mem, "stale:rev-eff", root);
      assert.equal(before.stale.length, 1);

      const r = await revalidateCard(mem, id, root);
      assert.equal(r.ok, true);
      assert.equal(r.stale, true, "reports it HAD drifted");

      // after revalidate the query no longer lists it (re-baseline cleared the flag)
      const after = await runStaleQuery(mem, "stale:rev-eff", root);
      assert.ok(!after.stale.some((s) => s.cardId === id), "no longer stale after revalidate");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("on a non-stale (current) card -> {ok:true, stale:false}", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-cur-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-cur-mem-"));
    try {
      const id = await seedTicket(root, mem, "cur-eff", "src/c-a.ts", "src/c-b.ts");
      // no drift — baseline is current
      const r = await revalidateCard(mem, id, root);
      assert.equal(r.ok, true);
      assert.equal(r.stale, false, "current card was not stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/tools/planning-stale-tool.test.ts )`
Expected: FAIL — `Cannot find module "./planning-stale-tool.js"`.

- [ ] **Step 3: Write the tool module**

Create `src/tools/planning-stale-tool.ts`:
```ts
// src/tools/planning-stale-tool.ts — the `planning_stale` tool (Phase-2 / 10-impl).
// Surface for the staleness dependency graph: a `stale:` query (returns closed
// planning decisions whose cited/declared source-file deps changed since last
// validation) + a `revalidate` action (the agent re-grill "re-validate" step,
// re-baselining a decision against current bytes). Standalone tool mirroring the
// knowledge_search / wayfind_effort house style (memory-tool.ts is @ts-nocheck
// and carries no prefix-query grammar, so a standalone tool is the cleanest
// additive surface). The pure resolvers (runStaleQuery / revalidateCard) are
// exported for unit testing without the pi API.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolRegistrar } from "./knowledge-search-tool.js";
import { createCardStore } from "../store/card-store.js";
import { getStaleCards, type StaleCard } from "../store/planning-staleness.js";
import { refreshStaleness } from "../store/planning-sync-state.js";

const PLANNING_STALE_DESCRIPTION = `Staleness dependency graph over .planning decisions.

action 'query' — pass a \`query\` of 'stale' (all efforts) or 'stale:<effort>' (scope to one effort). Returns closed planning-ticket decisions whose cited / declared (depends_on) source-file dependencies changed since last validation. Each returned card is stale by construction.

action 'revalidate' — pass a \`cardId\` (planning-ticket:<effort>:<no>). Re-baselines that decision against its CURRENT dependency bytes — call this AFTER re-grilling a stale decision to clear its stale flag. Reports whether the decision HAD drifted.

Use cases:
- Before acting on a stored planning decision, check its cited deps are still valid: planning_stale(action:'query', query:'stale')
- Scope staleness to one effort: planning_stale(action:'query', query:'stale:2026-08-08-knowledge-pipeline')
- After re-confirming a decision against changed code, clear its stale flag: planning_stale(action:'revalidate', cardId:'planning-ticket:<effort>:<no>')`;

/** Parse a `stale[:<effort>]` query string. Lenient: "stale" / "" / unknown →
 *  unscoped; "stale:<effort>" → scoped. */
export function parseStaleQuery(query: string): { effort?: string } {
  const q = (query ?? "").trim();
  if (q.startsWith("stale:")) {
    const effort = q.slice("stale:".length).trim();
    return effort.length > 0 ? { effort } : {};
  }
  return {};
}

/** Run a `stale:` query against the store: returns closed planning decisions
 *  flagged stale (deps changed since last validation). Each returned card is
 *  stale by construction — the result set IS the `stale` flag. Opens an
 *  ephemeral store (hermes holds no long-lived planning store). */
export async function runStaleQuery(
  memoryDir: string,
  query: string,
  fsRoot: string,
): Promise<{ ok: boolean; stale: StaleCard[]; error?: string }> {
  const { effort } = parseStaleQuery(query);
  let store;
  try {
    store = await createCardStore({ memoryDir });
  } catch (err) {
    return { ok: false, stale: [], error: msg(err) };
  }
  try {
    const stale = await getStaleCards(store, effort, fsRoot);
    return { ok: true, stale };
  } catch (err) {
    return { ok: false, stale: [], error: msg(err) };
  } finally {
    try {
      await store.close();
    } catch {
      /* best effort */
    }
  }
}

/** Re-validate ONE decision (the agent re-grill step): recompute the dep
 *  aggregate, report whether it HAD drifted relative to the OLD baseline, AND
 *  re-baseline to the CURRENT bytes (clearing the stale flag). `stale` is the
 *  T5 `refreshStaleness` boolean (wasStale); `missing` is `[]` (T5 does not
 *  expose missing — the query path surfaces it via StaleCard.missingDeps). */
export async function revalidateCard(
  memoryDir: string,
  cardId: string,
  fsRoot: string,
): Promise<{ ok: boolean; stale: boolean; missing: string[]; error?: string }> {
  let store;
  try {
    store = await createCardStore({ memoryDir });
  } catch (err) {
    return { ok: false, stale: false, missing: [], error: msg(err) };
  }
  try {
    const wasStale = await refreshStaleness(store, cardId, fsRoot);
    return { ok: true, stale: wasStale, missing: [] };
  } catch (err) {
    return { ok: false, stale: false, missing: [], error: msg(err) };
  } finally {
    try {
      await store.close();
    } catch {
      /* best effort */
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Format the stale-card list into a human-readable one-line-per-card summary
 *  (mirrors the memory-search / knowledge-search text shape). */
function renderStale(stale: StaleCard[]): string {
  if (stale.length === 0) return "No stale planning decisions.";
  const lines: string[] = [
    `${stale.length} stale decision${stale.length === 1 ? "" : "s"} (deps changed since last validation):`,
    "",
  ];
  for (const s of stale) {
    const miss = s.missingDeps && s.missingDeps.length > 0 ? ` — missing: ${s.missingDeps.join(", ")}` : "";
    lines.push(`- [${s.effort}] ${s.cardId}${miss}`);
  }
  return lines.join("\n");
}

/** Register the `planning_stale` tool (query + revalidate). `memoryDir` is the
 *  hermes memory DB dir (the SAME `globalDir` createCardStore / the planning
 *  mirror use) — captured in a closure at registration, mirroring
 *  `registerKnowledgeSearchTool`'s `vaultResolver` + `registerKnowledgeIngestTool`'s
 *  `opts.memoryDir`. The repo root (`fsRoot`) comes from `ctx.cwd` at call time. */
export function registerPlanningStaleTool(
  pi: ToolRegistrar,
  opts: { memoryDir: string },
): ToolDefinition {
  const definition = defineTool({
    name: "planning_stale",
    label: "Planning Stale",
    gating: { core: true },
    description: PLANNING_STALE_DESCRIPTION,
    parameters: Type.Object({
      action: StringEnum(["query", "revalidate"] as const, {
        description: "'query' — list stale planning decisions; 'revalidate' — re-baseline one decision against current deps.",
      }),
      query: Type.Optional(
        Type.String({
          description: "query action: 'stale' (all efforts) or 'stale:<effort>' (scope to one effort).",
        }),
      ),
      cardId: Type.Optional(
        Type.String({
          description: "revalidate action: the planning-ticket card id (planning-ticket:<effort>:<no>) to re-baseline.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      if (params.action === "revalidate") {
        if (!params.cardId) {
          return {
            content: [{ type: "text" as const, text: "✗ Missing 'cardId' for revalidate." }],
            details: { ok: false, error: "missing cardId" },
          };
        }
        const r = await revalidateCard(opts.memoryDir, params.cardId, cwd);
        const text = r.ok
          ? `✓ Re-validated ${params.cardId}: ${r.stale ? "had drifted (now re-baselined)" : "was current"}${r.missing.length > 0 ? `; missing deps: ${r.missing.join(", ")}` : ""}.`
          : `✗ Re-validate failed: ${r.error}`;
        return { content: [{ type: "text" as const, text }], details: r };
      }
      // query (the default path when action !== 'revalidate')
      const r = await runStaleQuery(opts.memoryDir, params.query ?? "stale", cwd);
      const text = r.ok ? renderStale(r.stale) : `✗ stale: query failed: ${r.error}`;
      return { content: [{ type: "text" as const, text }], details: r };
    },
  });
  pi.registerTool(definition);
  return definition;
}
```

- [ ] **Step 4: Register the tool in index.ts**

In `src/index.ts`, add the import (next to the other tool imports, e.g. after `registerKnowledgeIngestTool`):
```ts
import { registerPlanningStaleTool } from "./tools/planning-stale-tool.js";
```
Register it next to the other knowledge tools (after the `registerKnowledgeIngestTool(pi, { memoryDir: globalDir });` line):
```ts
  // Phase-2 (knowledge-pipeline / ticket 10): the stale: query + revalidate tool.
  // Uses the SAME globalDir memory DB the planning mirror uses.
  registerPlanningStaleTool(pi, { memoryDir: globalDir });
```
> `globalDir` is the resolved memory dir in `index.ts` (the same var `createCardStore`/`schedulePlanningBackfill` use — confirmed by reading index.ts).

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/tools/planning-stale-tool.test.ts )`
Expected: PASS.

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/tools/planning-stale-tool.ts bun-apps/pi-agent-ext-hermes-memory/src/tools/planning-stale-tool.test.ts bun-apps/pi-agent-ext-hermes-memory/src/index.ts
git -C <WT> commit -m "feat(knowledge-pipeline): stale: query + revalidate tool (10-impl T6)"
```

**DoD:** `stale:` returns only stale cards; `stale:<effort>` filters; clean effort → empty; `revalidate` clears the flag; tool registered in index.ts; full suite green.

---

### Task 7: hermes→wayfind reverse seam

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/stale-seam.ts` (publisher side: `HERMES_STALE_CHECK_KEY` + `publishStaleCheck`/`unpublishStaleCheck`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` (publish at init; unpublish on session_shutdown)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/stale-seam.test.ts` (publisher test)
- Create: `bun-apps/pi-agent-ext-wayfind/src/stale-seam.ts` (reader side: duplicated key literal + `StaleCard` type + `readStaleDecisions`)
- Create: `bun-apps/pi-agent-ext-wayfind/tests/stale-seam.test.ts` (reader test — mirrors `grill-seam.test.ts`)

**Interfaces:**
- hermes publishes `globalThis.__piHermesStaleCheck = async (effort, cwd) => { stale: StaleCard[] }` (null/guard if the store can't open; returns `{ stale: [] }` on any error so the wayfind gate degrades to a no-op, NEVER a false block).
- wayfind `readStaleDecisions(effort, cwd): Promise<StaleCard[] | null>` — duplicated `__piHermesStaleCheck` literal, `typeof === "function"` guard, returns `fn(effort, cwd)?.stale ?? null`, null when hermes absent. `StaleCard` type duplicated (no shared import — ADR-0004).

- [ ] **Step 1: Write the failing tests**

Create `src/stale-seam.test.ts` (hermes side):
```ts
import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createCardStore } from "./store/card-store.js";
import { computeStaleness } from "./store/planning-staleness.js";
import { HERMES_STALE_CHECK_KEY, publishStaleCheck, unpublishStaleCheck } from "./stale-seam.js";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY];
});

/** Write a dep file under root (creating its parent dir). */
function writeDep(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Write a source .md ticket that cites `citesPath` in the body + declares
 *  `depends_on: <depPath>` in frontmatter, plus writes BOTH dep files (v1).
 *  ticketCard() emits a `cites` + a `depends_on` relation -> citedDeps =
 *  [citesPath, depPath]. Returns the ticket card id. (Mirrors the committed
 *  T4 seedSource idiom — Path B: deps come from the source .md, NOT the store.) */
function seedSource(root: string, effort: string, citesPath: string, depPath: string): string {
  const ticketPath = join(root, ".planning", effort, "tickets", "01-seam-ticket.md");
  mkdirSync(dirname(ticketPath), { recursive: true });
  writeFileSync(
    ticketPath,
    `---\ntype: task\nstatus: closed\ndepends_on: ${depPath}\n---\n# 01 — seam-ticket\n\n## Resolution\n\nThis decision cites ${citesPath} in the body.\n`,
  );
  writeDep(root, citesPath, "v1");
  writeDep(root, depPath, "v1");
  return `planning-ticket:${effort}:01`;
}

describe("publishStaleCheck (10-impl T7 — hermes side)", () => {
  it("publishes an async (effort, cwd) => { stale } reader under globalThis that surfaces a drifted card", async () => {
    const root = mkdtempSync(join(tmpdir(), "seam-h-root-"));
    const mem = mkdtempSync(join(tmpdir(), "seam-h-mem-"));
    try {
      // Path B: write the source .md + both dep files, upsert the id for
      // getStaleCards enumeration, then seed the baseline @ v1.
      const id = seedSource(root, "seam", "src/seam-cites.ts", "src/seam-dep.ts");
      const store = await createCardStore({ memoryDir: mem });
      await store.upsertCard({ id, kind: "planning-ticket", content: "", frontmatter: { id: "01" } });
      await computeStaleness(store, id, root); // seed baseline (clean)
      await store.close();
      // drift the cited dep -> the card is now stale against the seeded baseline.
      writeFileSync(join(root, "src", "seam-cites.ts"), "v2-EDITED");

      publishStaleCheck(mem);
      const fn = (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY];
      assert.equal(typeof fn, "function");
      const r = await (fn as (e: string, cwd: string) => Promise<{ stale: { cardId: string }[] }>)("seam", root);
      assert.ok(r.stale.some((s) => s.cardId === id), "the drifted card surfaces via the seam");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("unpublishStaleCheck clears the global", () => {
    publishStaleCheck("/nonexistent");
    assert.equal(typeof (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY], "function");
    unpublishStaleCheck();
    assert.equal((globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY], undefined);
  });

  it("degrades to { stale: [] } (never throws) when the store cannot open", async () => {
    // A memoryDir that does not exist: createCardStore will throw trying to
    // open the SQLite file (parent dir absent). The published fn MUST swallow
    // that and return { stale: [] } so a wayfind graduation never false-blocks.
    publishStaleCheck("/nonexistent/missing-dir/under/missing-parent");
    const fn = (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY] as (
      e: string,
      cwd: string,
    ) => Promise<{ stale: unknown[] }>;
    const r = await fn("any", "/nonexistent");
    assert.deepEqual(r.stale, []);
  });
});
```
Create `tests/stale-seam.test.ts` (wayfind side — mirrors `grill-seam.test.ts`):
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { readStaleDecisions } from "../src/stale-seam.js";

const KEY = "__piHermesStaleCheck";
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[KEY];
});

test("readStaleDecisions returns null when no seam published (hermes absent)", async () => {
  expect(await readStaleDecisions("eff", "/cwd")).toBeNull();
});

test("readStaleDecisions returns the stale list when hermes published it", async () => {
  (globalThis as Record<string, unknown>)[KEY] = async (_effort: string, _cwd: string) => ({
    stale: [{ cardId: "planning-ticket:e:01", effort: "e" }],
  });
  const r = await readStaleDecisions("e", "/cwd");
  expect(r).toEqual([{ cardId: "planning-ticket:e:01", effort: "e" }]);
});

test("readStaleDecisions degrades to null when the seam throws (never crashes the gate)", async () => {
  (globalThis as Record<string, unknown>)[KEY] = async () => {
    throw new Error("boom");
  };
  expect(await readStaleDecisions("e", "/cwd")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/stale-seam.test.ts )` and `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/stale-seam.test.ts )`
Expected: FAIL — `Cannot find module "./stale-seam.js"` on both sides.

- [ ] **Step 3: Write the hermes publisher**

Create `src/stale-seam.ts`:
```ts
// src/stale-seam.ts — hermes PUBLISHER of the staleness reverse seam.
//
// Mirrors wayfind's publishWayfindGrill (coordination.ts) but REVERSED: hermes
// owns staleness computation + publishes the reader; wayfind reads it (the
// graduation gate). The key literal is the contract — duplicated verbatim in
// wayfind's src/stale-seam.ts (ADR-0004: no cross-package import; globalThis is
// process-singleton, reliable across jiti-loaded extensions).
//
// The reader is ASYNC because staleness is computed from the DB + source files
// at call time (on-access, per ticket-10 Resolution γ). Hermes holds no
// long-lived planning store, so the closure opens an EPHEMERAL CardStore per
// call — exactly like mirrorPlanningToStore. Null-safe: on ANY failure it
// returns { stale: [] } so the wayfind gate degrades to a no-op, NEVER a false
// block.
import { createCardStore } from "./store/card-store.js";
import { getStaleCards } from "./store/planning-staleness.js";

/** globalThis key under which hermes publishes the async staleness reader.
 *  Duplicated in wayfind's stale-seam.ts (the contract). */
export const HERMES_STALE_CHECK_KEY = "__piHermesStaleCheck";

/** Publish the async staleness reader. `memoryDir` is the hermes memory DB dir
 *  (same dir the planning mirror uses). The closure lazily opens an ephemeral
 *  CardStore per call. */
export function publishStaleCheck(memoryDir: string): void {
  (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY] = async (
    effort: string | undefined,
    cwd: string,
  ): Promise<{ stale: Array<{ cardId: string; effort: string; missingDeps?: string[] }> }> => {
    let store;
    try {
      store = await createCardStore({ memoryDir });
    } catch {
      return { stale: [] };
    }
    try {
      const stale = await getStaleCards(store, effort, cwd);
      return { stale };
    } catch {
      return { stale: [] };
    } finally {
      try {
        await store.close();
      } catch {
        /* best effort */
      }
    }
  };
}

/** Remove the reader (session_shutdown / unload). */
export function unpublishStaleCheck(): void {
  delete (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY];
}
```

- [ ] **Step 4: Write the wayfind reader**

Create `src/stale-seam.ts` (wayfind):
```ts
// src/stale-seam.ts — wayfind READER of hermes's staleness reverse seam.
//
// Mirrors grill-seam.ts: the key literal is duplicated from hermes's
// src/stale-seam.ts (globalThis is the contract — a cross-extension import is
// not reliable under jiti). If hermes is absent or the seam throws, this returns
// null → the graduation gate (wayfinder.closeEffortReflection) degrades to a
// no-op, NEVER crashes. The StaleCard type is duplicated too (no shared import —
// ADR-0004).
const HERMES_STALE_CHECK_KEY = "__piHermesStaleCheck";

export interface StaleCard {
  cardId: string;
  effort: string;
  missingDeps?: string[];
}

/** Read stale planning decisions for `effort` from hermes-memory via globalThis.
 *  Returns null when hermes is absent (or the seam throws) — the gate then
 *  proceeds. Async because hermes computes staleness from the DB + source files. */
export async function readStaleDecisions(effort: string, cwd: string): Promise<StaleCard[] | null> {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[HERMES_STALE_CHECK_KEY];
  if (typeof fn !== "function") return null;
  try {
    const r = await (fn as (effort: string, cwd: string) => Promise<{ stale: StaleCard[] }>)(
      effort,
      cwd,
    );
    return r?.stale ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Publish at hermes init; unpublish on shutdown**

In hermes `src/index.ts`, add the import (next to the `planning-backfill` import):
```ts
import { publishStaleCheck, unpublishStaleCheck } from "./stale-seam.js";
```
Publish once in the default-export body (after `globalDir` is finalized — e.g. right after the `schedulePlanningBackfill` import line is available, or near the `registerKnowledgeIngestTool` block; `globalDir` is in scope). Add right after the `registerPlanningStaleTool(pi, { memoryDir: globalDir });` line added in T6:
```ts
  // Phase-2 (knowledge-pipeline / ticket 10): publish the staleness reverse seam
  // for wayfind's graduation gate. The closure lazily opens an ephemeral store
  // per call; null-safe (degrades to {stale:[]} on any failure). Mirrors the
  // grill seam, reversed (hermes publishes, wayfind reads).
  publishStaleCheck(globalDir);
```
Unpublish in the existing `pi.on("session_shutdown", …)` handler (add to the `try { await Promise.all([ … ]) }` drain block's sibling, or as a standalone line near the top of the shutdown handler):
```ts
    // 10-impl: clear the staleness reverse seam (mirrors unpublishWayfindGrill).
    try {
      unpublishStaleCheck();
    } catch {
      /* best effort */
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/stale-seam.test.ts )` and `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/stale-seam.test.ts )`
Expected: PASS on both.

- [ ] **Step 7: Full package regression + type-check + commit (both packages)**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )` and `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`
Expected: all green on both.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/stale-seam.ts bun-apps/pi-agent-ext-hermes-memory/src/stale-seam.test.ts bun-apps/pi-agent-ext-hermes-memory/src/index.ts bun-apps/pi-agent-ext-wayfind/src/stale-seam.ts bun-apps/pi-agent-ext-wayfind/tests/stale-seam.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): hermes->wayfind staleness reverse seam (10-impl T7)"
```

**DoD:** hermes publishes the async reader (returns stale list; degrades to `{stale:[]}` on failure); wayfind reads it (null when hermes absent or seam throws); key literal + StaleCard type duplicated (no shared import); published at hermes init + unpublished on shutdown; both suites green.

---

### Task 8: graduation gate (wayfind)

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts` (`closeEffortReflection` → `async`; add the staleness gate after the frontier-check arm)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts` (`await closeEffortReflection(...)` in `handleWayfindDone`)
- Modify: `bun-apps/pi-agent-ext-wayfind/tests/wayfinder.test.ts` (add `await` to the 3 existing `closeEffortReflection` assertions + new gate tests)

**Interfaces:**
- Produces: `closeEffortReflection` return type changes `CloseEffortReflection | CloseEffortRefused` → `Promise<CloseEffortReflection | CloseEffortRefused>`. New gate: after the frontier-check `{refused}` arm and before `fileCompletedEffort`, `const stale = await readStaleDecisions(effort, cwd); if (stale && stale.length > 0) return { refused: … };`.

> **Signature ripple (pinned, ε):** `closeEffortReflection` becomes async because the seam (β) is async (staleness is computed from DB + fs at call time). Its sole non-test caller `commands.ts:handleWayfindDone` is already async → add one `await`. The 3 existing assertions in `wayfinder.test.ts` each get one `await`. This is the only public-signature ripple in the plan.

- [ ] **Step 1: Write the failing tests (append to `tests/wayfinder.test.ts`)**

Add the import at the top (next to the existing `closeEffortReflection` import):
```ts
// (no new import needed — the seam is read inside closeEffortReflection; the
//  test fakes it by setting globalThis.__piHermesStaleCheck.)
```
Append the describe (mirrors the existing "closeEffortReflection (/wayfind done)" block; uses the same `makeCwd`/`chartMap`/`addTicket` helpers):
```ts
describe("closeEffortReflection — staleness graduation gate (10-impl T8)", () => {
  const STALE_KEY = "__piHermesStaleCheck";
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[STALE_KEY];
  });

  it("refuses when stale decisions remain (seam returns a non-empty list)", async () => {
    const cwd = makeCwd();
    chartMap(cwd, "gate-eff", "dest");
    // frontier clear (no open tickets) so the ONLY gate is staleness
    (globalThis as Record<string, unknown>)[STALE_KEY] = async () => ({
      stale: [{ cardId: "planning-ticket:gate-eff:01", effort: "gate-eff" }],
    });
    const r = await closeEffortReflection(cwd, "gate-eff");
    expect("refused" in r).toBe(true);
    if ("refused" in r) {
      expect(r.refused).toContain("1 stale decision(s)");
      expect(r.refused).toContain("gate-eff");
    }
  });

  it("proceeds when hermes is absent (seam undefined -> null -> no gate)", async () => {
    const cwd = makeCwd();
    chartMap(cwd, "gate-eff", "dest");
    // NO seam published — readStaleDecisions returns null -> gate is a no-op.
    const r = await closeEffortReflection(cwd, "gate-eff");
    expect("refused" in r).toBe(false);
  });

  it("proceeds when the seam reports zero stale", async () => {
    const cwd = makeCwd();
    chartMap(cwd, "gate-eff", "dest");
    (globalThis as Record<string, unknown>)[STALE_KEY] = async () => ({ stale: [] });
    const r = await closeEffortReflection(cwd, "gate-eff");
    expect("refused" in r).toBe(false);
  });
});
```
ALSO update the 3 existing `closeEffortReflection` assertions in the existing "closeEffortReflection (/wayfind done)" describe to `await` (they currently read `const r = closeEffortReflection(cwd, …)`; change each to `const r = await closeEffortReflection(cwd, …)`). The three sites: the "refuses when open tickets remain" test, the "refuses when the effort has no map" test, and the "harvests fog" test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/wayfinder.test.ts )`
Expected: FAIL — the new gate tests fail (`closeEffortReflection` is sync + has no staleness gate; `await` on a non-promise still works but the "refuses when stale" assertion fails because there's no gate). The 3 existing tests still pass after adding `await` (awaiting a non-thenable returns the value).

- [ ] **Step 3: Make `closeEffortReflection` async + add the gate**

In `src/wayfinder.ts`, add the import (next to the existing `completeEffort` import):
```ts
import { readStaleDecisions } from "./stale-seam.js";
```
Change the signature + add the gate. Replace:
```ts
export function closeEffortReflection(
  cwd: string,
  effort: string,
  now: Date = new Date(),
): CloseEffortReflection | CloseEffortRefused {
```
with:
```ts
export async function closeEffortReflection(
  cwd: string,
  effort: string,
  now: Date = new Date(),
): Promise<CloseEffortReflection | CloseEffortRefused> {
```
Then, AFTER the existing frontier-check `{refused}` arm (the `if (frontier.length > 0) { … return { refused: … }; }` block) and BEFORE `const deferredPrizes = …`, insert the staleness gate:
```ts
  // 10-impl (staleness dependency graph): BLOCK graduation while closed decisions
  // whose cited/declared source-file deps changed since last validation remain.
  // readStaleDecisions returns null when hermes-memory is absent → the gate is a
  // no-op (degrades, never crashes). Async because staleness is computed from
  // the DB + source files at call time (on-access, per ticket-10 Resolution γ).
  const stale = await readStaleDecisions(effort, cwd);
  if (stale && stale.length > 0) {
    const which = stale.map((s) => s.cardId).join(", ");
    return {
      refused: `${stale.length} stale decision(s) remain on "${effort}" — dependencies changed since last validation (${which}). Re-grill to resolve (re-open ticket, re-validate, update resolution) before /wayfind done`,
    };
  }
```

- [ ] **Step 4: Update the caller in commands.ts**

In `src/commands.ts` `handleWayfindDone`, change `const r = closeEffortReflection(ctx.cwd, effort);` to `const r = await closeEffortReflection(ctx.cwd, effort);` (the enclosing function is already `async`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/wayfinder.test.ts )`
Expected: PASS (new gate tests + the 3 updated existing tests + the rest of the file).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts bun-apps/pi-agent-ext-wayfind/src/commands.ts bun-apps/pi-agent-ext-wayfind/tests/wayfinder.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): staleness graduation gate (/wayfind done) (10-impl T8)"
```
> Before committing, grep for any OTHER `closeEffortReflection(` callers updated by the async change: `git -C <WT> grep -n "closeEffortReflection("` — every call site MUST now `await` (commands.ts + the tests). If a non-test caller is found that is NOT async, make it async or pre-await at the boundary.

**DoD:** stale present → `{refused}` mentioning the count + effort; hermes absent (null) → proceeds; zero stale → proceeds; the frontier-check arm still fires first; full suite green.

---

### Task 9: read-side surfacing (wayfind)

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts` (add optional `stale?: number | null` to `EffortStatusResult` + `stale?: boolean` to `EffortStatusTicket`; enrich at the TOOL layer in the `status` arm; render the count + per-ticket marker in `renderStatus`)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/effort-query.ts` (add optional `stale?: number | null` to `EffortListItem`; enrich at the TOOL layer in the `list` arm; render in `renderList` — note `renderList` lives in effort-tool.ts)
- Modify: `bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts` (status/list render: null vs 0 vs N; per-ticket marker)

**Interfaces:**
- `EffortStatusResult.stale?: number | null` — null = staleness unavailable (hermes absent); 0 = clean; N = stale count.
- `EffortStatusTicket.stale?: boolean` — per-ticket stale marker (set at the tool layer from the seam's stale card-id set).
- `EffortListItem.stale?: number | null` — same semantics as above.
- The SYNC pure functions `effortStatus`/`listEfforts` leave `stale` UNSET (staleness is an async tool-layer enrichment via `readStaleDecisions`); the tool's async `execute` populates it before rendering.

> **Design choice (pinned):** `effortStatus` + `listEfforts` are SYNC pure functions (they read only `map.md` + manifests). Making them async to await the seam would ripple into their signatures + all their tests. Instead the `stale` count is enriched at the TOOL layer (the tool's async `execute` calls `readStaleDecisions` after the sync fn returns) and rendered by `renderStatus`/`renderList`. This keeps the pure fns sync + testable without hermes, and surfaces staleness exactly where it's needed (the agent-facing tool output).

- [ ] **Step 1: Write the failing tests (append to `tests/effort-tool.test.ts`)**

Match the file's existing `bun:test` + real-fs harness idiom. The new tests assert the RENDER output for the three `stale` states + the per-ticket marker. They call `renderStatus`/`renderList` directly with pre-populated `stale` fields (sync — no seam needed):
```ts
import { renderStatus, renderList } from "../src/effort-tool.js";
import type { EffortStatusResult, EffortStatusTicket } from "../src/effort-tool.js";
import type { EffortListResult } from "../src/effort-query.js";

describe("effort status/list — stale surfacing (10-impl T9)", () => {
  it("renderStatus: null stale -> 'staleness: unavailable'", () => {
    const r: EffortStatusResult = {
      ok: true, exists: true, effort: "e", destination: "d", meta: null,
      open: 0, closed: 1, claimed: 0, fog: 0, frontier: [], tickets: [], stale: null,
    };
    expect(renderStatus(r)).toContain("staleness: unavailable");
  });
  it("renderStatus: 0 stale -> 'stale: 0 (clean)'", () => {
    const r: EffortStatusResult = {
      ok: true, exists: true, effort: "e", destination: "d", meta: null,
      open: 0, closed: 1, claimed: 0, fog: 0, frontier: [], tickets: [], stale: 0,
    };
    expect(renderStatus(r)).toContain("stale: 0 (clean)");
  });
  it("renderStatus: N>0 stale -> 'stale: N' + per-ticket marker", () => {
    const t: EffortStatusTicket = { id: "01", title: "decide", status: "closed", blocking: [], stale: true };
    const r: EffortStatusResult = {
      ok: true, exists: true, effort: "e", destination: "d", meta: null,
      open: 0, closed: 1, claimed: 0, fog: 0, frontier: [], tickets: [t], stale: 1,
    };
    const out = renderStatus(r);
    expect(out).toContain("stale: 1");
    expect(out).toContain("⚠ stale"); // per-ticket marker next to blocked-by
  });
  it("renderList: null vs 0 vs N rendered distinctly", () => {
    const base = (stale: number | null): EffortListResult => ({
      ok: true,
      efforts: [
        {
          slug: "e", status: "active", destination: "d",
          ticketCounts: { open: 0, closed: 1, claimed: 0 }, frontierSize: 0, fog: 0,
          ...(stale === null ? {} : { stale }),
        },
      ],
    });
    expect(renderList(base(null))).toContain("stale=?");
    expect(renderList(base(0))).toContain("stale=0");
    expect(renderList(base(2))).toContain("stale=2");
  });
});
```
> NOTE: confirm the exact export names (`renderStatus`/`renderList`) + the `EffortStatusResult`/`EffortStatusTicket`/`EffortListResult` field shapes in effort-tool.ts at implementation time — `renderStatus`/`renderList` are module-private `function`s in effort-tool.ts; if they are NOT exported, export them (additive `export` keyword) so the test can import them. The type fields listed match the current `EffortStatusResult`/`EffortListItem` shapes (verified by reading effort-tool.ts/effort-query.ts).

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/effort-tool.test.ts )`
Expected: FAIL — `stale` not on the result/ticket types; renderers don't emit the stale line/marker.

- [ ] **Step 3: Add the `stale` fields + tool-layer enrichment + render**

In `src/effort-tool.ts`:
1. Add to `EffortStatusResult` (additive optional field):
```ts
  /** 10-impl: # of stale decisions on this effort (deps changed since last
   *  validation). null = staleness unavailable (explicit); UNSET (undefined) =
   *  not enriched / hermes absent (render emits nothing); 0 = clean; N = count.
   *  Enriched at the TOOL layer (async) — the SYNC effortStatus leaves it unset. */
  stale?: number | null;
```
2. Add to `EffortStatusTicket`:
```ts
  /** 10-impl: true when this closed decision is stale (its cited/declared deps
   *  drifted since last validation). Set at the TOOL layer from the seam's stale
   *  card-id set; left unset when hermes is absent. */
  stale?: boolean;
```
3. Add the import + enrich the `status` arm of the tool `execute`. At the top of effort-tool.ts:
```ts
import { readStaleDecisions } from "./stale-seam.js";
```
   In the `case "status":` branch, BEFORE `return { content: […], details: r };`, enrich `r`:
```ts
          const r = effortStatus(cwd, params.effort);
          // 10-impl T9: enrich the stale count + per-ticket markers from the
          // hermes seam (async). readStaleDecisions returns null when hermes is
          // absent → leave `stale` UNSET so renderStatus emits nothing (output
          // byte-identical to pre-T9). A non-null array → stale.length (0 =
          // clean) + a ⚠ marker on each ticket whose cardId is stale. The SYNC
          // effortStatus leaves `stale` unset; staleness is a tool-layer concern.
          try {
            const stale = await readStaleDecisions(params.effort, cwd);
            if (stale !== null) {
              r.stale = stale.length;
              const staleNos = new Set(stale.map((s) => s.cardId.split(":").pop() ?? ""));
              for (const t of r.tickets) if (staleNos.has(t.id)) t.stale = true;
            }
          } catch {
            // seam threw (defensive — readStaleDecisions already catches) → leave unset
          }
          return { content: [{ type: "text" as const, text: renderStatus(r) }], details: r };
```
4. In `renderStatus`, after the `destination:` line, add the staleness line:
```ts
  const staleStr =
    r.stale === undefined
      ? ""
      : r.stale === null
        ? "staleness: unavailable"
        : r.stale === 0
          ? "stale: 0 (clean)"
          : `stale: ${r.stale}`;
  if (staleStr) lines.push(staleStr);
```
   And in the per-ticket render loop, add the marker (the existing line is `const blk = t.blocking.length > 0 ? … : "";`):
```ts
      const blk = t.blocking.length > 0 ? ` blocked-by ${t.blocking.join(",")}` : "";
      const stl = t.stale ? " ⚠ stale" : "";
      lines.push(`  ${t.id} ${t.title} [${t.status}]${blk}${stl}`);
```
5. Export `renderStatus` and `renderList` (change `function renderStatus` → `export function renderStatus`; same for `renderList`) so the tests can import them.

In `src/effort-query.ts`:
1. Add to `EffortListItem`:
```ts
  /** 10-impl: # of stale decisions on this effort (deps changed since last
   *  validation). null = explicitly unavailable; UNSET (undefined) = not
   *  enriched / hermes absent (render emits no token); 0 = clean; N = count.
   *  Enriched at the TOOL layer (async) — the SYNC listEfforts leaves it unset. */
  stale?: number | null;
```
   (`listEfforts` stays SYNC and leaves `stale` unset — enriched at the tool layer.)

In `src/effort-tool.ts` (the `list` arm):
1. Enrich each effort in the `case "list":` branch before rendering:
```ts
        case "list": {
          const r = listEfforts(cwd);
          // 10-impl T9: per-effort stale count from the hermes seam. Each call
          // opens an ephemeral store in hermes; N efforts = N calls (acceptable
          // for a manual list, not a hot path). null = hermes absent → leave
          // `stale` UNSET so renderList emits no token (byte-identical to pre-T9).
          for (const e of r.efforts) {
            try {
              const stale = await readStaleDecisions(e.slug, cwd);
              if (stale !== null) e.stale = stale.length;
            } catch {
              // seam threw → leave unset
            }
          }
          return { content: [{ type: "text" as const, text: renderList(r) }], details: r };
        }
```
2. In `renderList`, add the stale token to each effort line. The existing line pushes:
```ts
    lines.push(
      `${e.slug}  [${e.status}]  open=${c.open} closed=${c.closed} claimed=${c.claimed}  frontier=${e.frontierSize}  fog=${e.fog}${last}`,
    );
```
   Change to append a `stale=…` token:
```ts
    const staleToken =
      e.stale === undefined ? "" : e.stale === null ? "  stale=?" : `  stale=${e.stale}`;
    lines.push(
      `${e.slug}  [${e.status}]  open=${c.open} closed=${c.closed} claimed=${c.claimed}  frontier=${e.frontierSize}  fog=${e.fog}${last}${staleToken}`,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/effort-tool.test.ts )`
Expected: PASS (new stale render cases + existing status/list tests).

- [ ] **Step 5: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts bun-apps/pi-agent-ext-wayfind/src/effort-query.ts bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): stale surfacing in effort status/list (10-impl T9)"
```

**DoD:** status shows a stale count (null vs 0 vs N distinct) + a per-ticket `⚠ stale` marker; list shows `stale=?`/`stale=0`/`stale=N` per effort; pure `effortStatus`/`listEfforts` stay sync (enrichment at the tool layer); full suite green.

---

## Notes for the implementer

- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.
- **Master invariant (memory/user/failure/knowledge/planning must not regress):** every task is ADDITIVE (new table/module/seam/gate-arm). 09's mirror/reconcile/backfill/refresh and 08's serializer FILES are NOT semantically regressed — T1 ADDS `depends_on` parsing/emission ALONGSIDE the existing `blocked-by`/`cites` (does not alter them); T2 ADDS a new `card_dep_hash` table + accessors (no `memories`/`card_md_hash` change); T3/T4/T5 ADD new functions/modules; T6 ADDS a new tool; T7 ADDS a new seam; T8 ADDS a gate arm (after the existing frontier check) + flips `closeEffortReflection` to async (the one signature ripple); T9 ADDS optional `stale` fields + render. If any non-staleness test breaks at a task boundary, **STOP and fix**.
- **`card_dep_hash` is ADDITIVE (no `card_md_hash`/`memories` change) — the α reassurance.** Verified: `card_md_hash.card_id` is the SOLE PRIMARY KEY (so a `kind='validated'` row there would collide). The new table is a plain `CREATE TABLE IF NOT EXISTS` (no rebuild, no column-list drift) → the C3 column-drift trap cannot fire.
- **Typecheck per package:** hermes `bun run check` (= `tsc --noEmit`); wayfind `bun run check` (= biome lint) **AND** `bunx tsc --noEmit` (wayfind's `check` is biome, NOT tsc — its tsc runs under `build`). Full suites: `bun test` in each package.
- **The one signature ripple (ε):** `closeEffortReflection` becomes `async` because the seam is async (β). Caller `commands.ts:handleWayfindDone` + the 3 existing assertions in `wayfinder.test.ts` each get one `await`. Grep `git -C <WT> grep -n "closeEffortReflection("` before the T8 commit to catch any other caller.
- **Sweep vs revalidate (ζ):** the `session_start` sweep FLAGS via `computeStaleness` (compare-only after the first-touch seed — does NOT rebaseline, so stale state persists across sessions). `refreshStaleness` is the explicit re-validate primitive (clears the flag) — called by the `planning_stale` tool's `revalidate` action (T6), NOT by the sweep.
- **No zk import; no cross-package import (ADR-0004):** hermes↔wayfind communicate via the duplicated `__piHermesStaleCheck` globalThis literal + a duplicated `StaleCard` type. The seam is async (DB + fs at call time); the wayfind reader is null-safe (hermes absent or seam throws → null → gate degrades to a no-op, never a false block).
- **`conflict:` query is DEFERRED** (ticket 10 Resolution is staleness-only). Effort-level relations (Supersedes/Absorbed-by/Covered-by/Shares-decision-with) and per-edge granularity are also deferred.

## Implementation notes (post-merge reconciliation)

The verbatim code blocks above were reconciled **post-implementation** so the plan matches what was actually shipped under `10-impl` (T1–T9). The shipped `.ts` files are authoritative; this plan was edited to match them, not vice-versa. Key adjustments (12-item amendment):

- **T5 `refreshStaleness`** — return type is `Promise<boolean>` (returns `wasStale`, mirroring `refreshIfStale`'s boolean envelope), NOT `Promise<{ stale; missing }>`. Deps are sourced via `readSourceCard(store, cardId, fsRoot)` (Path B, decision η — re-parse of the git-canonical source `.md` → `graph.relations`), NOT `store.getCard` (the 06a store row drops `graph`). Re-baseline is `writeValidatedBaseline(store, card, fsRoot)`, not a raw `upsertCardDepHash`. The T5 test seed is a real source `.md` (`depends_on:`) + a dep file + per-case temp dirs + boolean asserts (`wasStale === true/false`), not an inline `store.upsertCard({...graph})`.
- **T6 `planning_stale` tool** — `revalidateCard` consumes the boolean: `const wasStale = await refreshStaleness(...); return { ok: true, stale: wasStale, missing: [] };` (the plan's destructure-from-a-boolean was a compile error). Tool registration uses `registerPlanningStaleTool(pi: ToolRegistrar, …)` + `const definition = defineTool({ … })` (importing `defineTool`/`ToolRegistrar` from `@earendil-works/pi-coding-agent` / `./knowledge-search-tool.js`), NOT `pi: ExtensionAPI` + a plain `const definition: ToolDefinition = {…}` object literal. Description moved to a `PLANNING_STALE_DESCRIPTION` const; render text uses `✓`/`✗` glyphs + `"had drifted (now re-baselined)"`/`"was current"`. The T6 test seed uses the `seedSource`/`writeDep` idiom (real source `.md` + a `store.upsertCard` row WITHOUT `graph`).
- **T7 hermes seam test** — seeds via a real source `.md` (`seedSource`/`writeDep`) + a `store.upsertCard` row WITHOUT `graph` (η), then `computeStaleness` to seed the baseline + a dep edit to drift it — NOT `store.upsertCard({…graph:{relations:[…]}})` + `computeStaleness(store, id, root)` off the store row.
- **T9 effort status/list (null-vs-unset invariant)** — both the `status` and `list` arms now gate enrichment on `if (stale !== null)` and, on hermes-absence or a seam throw, **leave `stale` UNSET (undefined)** (`catch { /* leave unset */ }`) rather than assigning `null`. Because `renderStatus`/`renderList` already map `undefined → emit nothing`, the tool output is **byte-identical to pre-T9** when hermes is absent. `null` is reserved for explicit "staleness unavailable". The three `stale` field JSDocs (`EffortStatusResult`, `EffortStatusTicket`, `EffortListItem`) were aligned to this null-vs-unset semantics.

(No shipped `.ts` file was modified by this reconciliation — it is DOC-ONLY, amending this plan to track the shipped implementation.)
