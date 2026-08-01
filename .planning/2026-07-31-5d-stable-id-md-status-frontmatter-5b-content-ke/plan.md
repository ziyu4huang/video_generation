# 5d Stable-ID Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `.md` memory-entry metadata from HTML-comment trailers to YAML frontmatter carrying a stable uuid `id`, and retire 5b's content-key DB↔`.md` bridge in favor of id-based matching.

**Architecture:** Add an `md_id` column/field to both backends (SQLite + SurrealDB) as a nullable secondary unique-indexed join key (DB-native `id` stays the PK). Introduce frontmatter parse/serialize + a dual-shape parser that upgrades legacy comment entries on touch. A one-shot idempotent backfill (riding the `normalizeLegacyMemoryIds` startup seam) assigns uuids, rewrites every entry to frontmatter, and mirrors `md_id` to the matched DB row. Steady-state eviction/offload/transfer then match by `md_id`; the content-key bridge is fully retired.

**Tech Stack:** TypeScript (Bun), `bun:sqlite`, SurrealDB v3 (SurrealQL), the `yaml` package (new dep), the `pi-agent-ext-hermes-memory` extension.

## Global Constraints

- **Backend-abstraction seam:** `MemoryStore` (`.md` ground-truth) stays free of a direct `MemoryRepository` reference. DB knowledge reaches it via injected providers — mirror the existing `setConsolidator` / `setSupersededContentProvider` / `setPerfTimed` injection pattern in `src/store/memory-store.ts`.
- **Startup migrations are best-effort, never throw** — mirror `normalizeLegacyMemoryIds` (`try { … } catch { return 0; }`): a migration failure must NEVER trip `createBackendBundleWithFallback`'s sqlite fallback or abort agent startup.
- **`md_id` is nullable during backfill, trends to `NOT NULL` post-completion** (+1-release safety net before enforcing). SQLite unique indexes permit multiple NULLs; **verify SurrealDB `UNIQUE` permits multiple `NONE`/absent** (Task 1 verification).
- **Content-key is fully retired** from the steady-state bridge (no fallback) — per ticket 04. The backfill is the SOLE transient content-key user.
- **Idempotent:** every migration re-run is a strict no-op (skip frontmatter+has-id entries; never overwrite a present id).
- **Frontmatter schema (ticket 05):** field order `id → created → last → provenance → sources → memworth`; omit absent/empty fields; native YAML (no JSON-in-string). Renames: `lastReferenced`→`last`, `mwSuccess`/`mwFail`→`memworth.{success,fail}`.
- **Id lifecycle (ticket 03):** ids born (uuid), immutable through life incl. supersession, die tracelessly on consolidation/offload (DB row + `md_id` deleted together). The vault-offload `.knowledge.jsonl` archive carries the retired `md_id` as provenance.
- **No vendor edits.** TDD. Frequent commits. Run tests: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`.

---

### Task 1: `md_id` column + unique index on both backends

Add the nullable secondary join key to both stores. No matching logic yet — just the schema + a `getMdIdByContent` read helper the backfill (Task 4) uses.

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` — add `md_id TEXT` to the `memories` CREATE TABLE + a unique index.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts:702` (`ensureMemoriesColumns`) — ALTER-guard for existing DBs.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/schema.ts` — `DEFINE INDEX memories_md_id … UNIQUE`.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts` — interface `getMdIdByContent(content, options): Promise<string | null>`.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts` + `src/store/surreal/surreal-memory-repo.ts` — impls.
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/md-id-schema.test.ts`

**Interfaces:**
- Produces: `getMdIdByContent(content: string, options: MemoryRemoveOptions): Promise<string | null>` on `MemoryRepository` — returns the `md_id` of the (scope-matched) row whose `content = content.trim()`, or `null`. Used by the Task 4 backfill to avoid double-assigning.

- [ ] **Step 1: Write the failing test**

`tests/store/md-id-schema.test.ts`:
```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { rmSync } from "node:fs";

describe("md_id schema", () => {
  let dir: string;
  beforeEach(() => { dir = join(tmpdir(), `mdid-${Date.now()}-${Math.random()}`); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("SQLite: md_id column exists and is nullable; UNIQUE permits multiple NULLs", async () => {
    const backend = new SqliteBackend(dir); await backend.init();
    const repo = new SqliteMemoryRepository(backend);
    // Two rows, no md_id yet — both NULL must coexist under the UNIQUE index.
    await repo.addMemory({ target: "memory", project: null, content: "a", created: "2026-08-01", lastReferenced: "2026-08-01" });
    await repo.addMemory({ target: "memory", project: null, content: "b", created: "2026-08-01", lastReferenced: "2026-08-01" });
    const cols = backend["getColumnNames"](backend["db"], "memories");
    expect(cols.has("md_id")).toBe(true);
    expect(await repo.getMdIdByContent("a", { target: "memory" })).toBeNull();
  });

  test("SQLite: md_id is unique among non-NULL values", async () => {
    const backend = new SqliteBackend(dir); await backend.init();
    const repo = new SqliteMemoryRepository(backend);
    await repo.addMemory({ target: "memory", project: null, content: "a", created: "2026-08-01", lastReferenced: "2026-08-01" });
    await expect(repo.setMdIdByContent("a", "dup", { target: "memory" })).resolves.toBe(1);
    await repo.addMemory({ target: "memory", project: null, content: "b", created: "2026-08-01", lastReferenced: "2026-08-01" });
    await expect(repo.setMdIdByContent("b", "dup", { target: "memory" })).rejects.toThrow();
  });
});
```
> NOTE: `setMdIdByContent` is added in Task 4; for Task 1 leave that second test `test.skip` or move it to Task 4's test file. Keep only the column/nullable test green in Task 1.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/md-id-schema.test.ts )`
Expected: FAIL — `md_id` not a column / `getMdIdByContent` not a function.

- [ ] **Step 3: SQLite schema + ALTER-guard**

In `schema.ts`, inside the `memories` CREATE TABLE (after `parent_ids TEXT`):
```sql
    md_id TEXT,
```
and in the indexes block:
```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_md_id ON memories(md_id);
```
In `sqlite-backend.ts` `ensureMemoriesColumns` (after the `status` guard, ~`:727`):
```ts
    if (!names.has('md_id')) {
      db.exec('ALTER TABLE memories ADD COLUMN md_id TEXT');
    }
```
> SQLite `UNIQUE` indexes treat NULLs as distinct, so multiple un-backfilled rows (NULL `md_id`) coexist. The ALTER runs once per existing DB; new DBs get the column from CREATE TABLE.

- [ ] **Step 4: Surreal schema**

In `schema.ts` `SURREAL_BOOTSTRAP_SQL`, add after the `memories_content` DEFINE INDEX:
```sql
DEFINE INDEX IF NOT EXISTS memories_md_id ON TABLE memories FIELDS md_id UNIQUE;
```

- [ ] **Step 5: `getMdIdByContent` interface + impls**

`repository.ts` (add to `MemoryRepository`):
```ts
  getMdIdByContent(content: string, options: MemoryRemoveOptions): Promise<string | null>;
```
SQLite impl (`sqlite-memory-repo.ts`, next to `removeExactSyncedMemories`):
```ts
  async getMdIdByContent(content: string, options: MemoryRemoveOptions): Promise<string | null> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const params: unknown[] = [];
      const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
      conditions.push("content = ?"); params.push(content.trim());
      const row = this.db.prepare(`SELECT md_id AS mdId FROM memories WHERE ${conditions.join(" AND ")} LIMIT 1`).get(...params) as { mdId?: string | null } | undefined;
      return row?.mdId ?? null;
    }));
  }
```
Surreal impl (`surreal-memory-repo.ts`, next to `removeExactSyncedMemories`):
```ts
  async getMdIdByContent(content: string, options: MemoryRemoveOptions): Promise<string | null> {
    const scope = buildScope(options.target, options.project ?? undefined);
    const rows = await this.c.query<Array<{ mdId?: string | null }>>(
      `SELECT mdId FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content LIMIT 1;`,
      { ...scope.params, content: content.trim() },
    );
    return rows[0]?.mdId ?? null;
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/md-id-schema.test.ts )`
Expected: PASS.

- [ ] **Step 7: Verification — SurrealDB UNIQUE permits multiple NONE**

Run against a local SurrealDB v3 (manual, record in task notes):
```sql
DEFINE INDEX memories_md_id ON TABLE memories FIELDS mdId UNIQUE;
CREATE memories SET content="x"; CREATE memories SET content="y";  -- both mdId absent
-- EXPECT: succeeds (no unique violation). If it fails, UNIQUE must be replaced with
-- a guarded application-level uniqueness check until backfill completes.
```

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/schema.ts bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/md-id-schema.test.ts
git commit -m "feat(hermes-memory): add nullable md_id column + unique index (SQLite + Surreal)"
```

---

### Task 2: Frontmatter parse / serialize / detect

Add the YAML frontmatter format layer in `memory-format.ts`, implementing ticket 05's exact schema. No `.md` I/O yet — pure functions.

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/package.json` — add `yaml` dep (`( cd bun-apps/pi-agent-ext-hermes-memory && bun add yaml )`).
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-format.ts` — add `parseMetadataFrontmatter`, `serializeMetadataFrontmatter`, `detectEntryShape`, `FRONTMATTER_FENCE`.
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-format-frontmatter.test.ts`

**Interfaces:**
- Consumes: `ParsedMarkdownMemoryEntry` (existing) + the `MemorySource`/`Provenance` types.
- Produces:
  - `detectEntryShape(raw: string): "frontmatter" | "comment"` — `frontmatter` iff the entry starts with `---\n`.
  - `serializeMetadataFrontmatter(entry: { id: string; text: string; created: string; last: string; provenance?: Provenance | null; sources?: MemorySource[] | null; mwSuccess?: number | null; mwFail?: number | null }): string` — emits `---\n<yaml>\n---\n<text>`, omitting empty/optional fields, applying the renames.
  - `parseMetadataFrontmatter(raw: string): ParsedMarkdownMemoryEntry & { id: string }` — inverse, mapping `last`→`lastReferenced`, `memworth`→`mwSuccess/mwFail`.

- [ ] **Step 1: Write the failing test**

`tests/store/memory-format-frontmatter.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { serializeMetadataFrontmatter, parseMetadataFrontmatter, detectEntryShape } from "../../src/store/memory-format";

describe("frontmatter format", () => {
  const id = "01846a3e-7c9b-4f2a-9e1d-2b5f8a1c3d47";

  test("minimal entry round-trips with only id/created/last", () => {
    const out = serializeMetadataFrontmatter({ id, text: "hello world", created: "2026-08-01", last: "2026-08-01" });
    expect(out).toBe("---\nid: 01846a3e-7c9b-4f2a-9e1d-2b5f8a1c3d47\ncreated: 2026-08-01\nlast: 2026-08-01\n---\nhello world");
    expect(detectEntryShape(out)).toBe("frontmatter");
    const parsed = parseMetadataFrontmatter(out);
    expect(parsed.id).toBe(id);
    expect(parsed.text).toBe("hello world");
    expect(parsed.created).toBe("2026-08-01");
    expect(parsed.lastReferenced).toBe("2026-08-01");
  });

  test("omits empty optionals; full entry round-trips sources + memworth", () => {
    const out = serializeMetadataFrontmatter({
      id, text: "body", created: "2026-08-01", last: "2026-08-01",
      provenance: "verified",
      sources: [{ kind: "quote", locator: "session:abc", capture: "line with: colon" }],
      mwSuccess: 3, mwFail: 1,
    });
    expect(out).toContain("memworth:\n  success: 3\n  fail: 1");
    expect(out).toContain('capture: "line with: colon"');
    const parsed = parseMetadataFrontmatter(out);
    expect(parsed.provenance).toBe("verified");
    expect(parsed.sources?.[0].capture).toBe("line with: colon");
    expect(parsed.mwSuccess).toBe(3);
    expect(parsed.mwFail).toBe(1);
  });

  test("zero memworth is omitted entirely", () => {
    const out = serializeMetadataFrontmatter({ id, text: "x", created: "2026-08-01", last: "2026-08-01", mwSuccess: 0, mwFail: 0 });
    expect(out).not.toContain("memworth");
  });

  test("detectEntryShape distinguishes comment vs frontmatter", () => {
    expect(detectEntryShape("---\nid: x\n---\nbody")).toBe("frontmatter");
    expect(detectEntryShape("body <!-- created=2026-08-01, last=2026-08-01 -->")).toBe("comment");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format-frontmatter.test.ts )`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement (add `yaml` dep first)**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun add yaml )
```

In `memory-format.ts` (top): `import { parse as parseYaml, stringify as stringifyYaml } from "yaml";`
```ts
export const FRONTMATTER_FENCE = "---";

export function detectEntryShape(raw: string): "frontmatter" | "comment" {
  return raw.startsWith(FRONTMATTER_FENCE + "\n") ? "frontmatter" : "comment";
}

export function serializeMetadataFrontmatter(input: {
  id: string; text: string; created: string; last: string;
  provenance?: Provenance | null; sources?: MemorySource[] | null;
  mwSuccess?: number | null; mwFail?: number | null;
}): string {
  const fm: Record<string, unknown> = { id: input.id, created: input.created, last: input.last };
  if (input.provenance && input.provenance !== "none") fm.provenance = input.provenance;
  if (input.sources && input.sources.length > 0) fm.sources = input.sources;
  if ((input.mwSuccess && input.mwSuccess > 0) || (input.mwFail && input.mwFail > 0)) {
    const mw: Record<string, number> = {};
    if (input.mwSuccess && input.mwSuccess > 0) mw.success = input.mwSuccess;
    if (input.mwFail && input.mwFail > 0) mw.fail = input.mwFail;
    fm.memworth = mw;
  }
  const yaml = stringifyYaml(fm, { lineWidth: 0 }).trimEnd(); // keep capture on one quoted line
  return `${FRONTMATTER_FENCE}\n${yaml}\n${FRONTMATTER_FENCE}\n${input.text}`;
}

export function parseMetadataFrontmatter(raw: string): ParsedMarkdownMemoryEntry & { id: string } {
  const lines = raw.split("\n");
  // first line is "---"; find closing "---"
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === FRONTMATTER_FENCE) { close = i; break; }
  if (close === -1) throw new Error("malformed frontmatter: no closing fence");
  const fm = parseYaml(lines.slice(1, close).join("\n")) as Record<string, unknown>;
  const text = lines.slice(close + 1).join("\n");
  const mw = (fm.memworth ?? {}) as { success?: number; fail?: number };
  return {
    content: text,
    target: "memory", // caller overrides; format is shape-only
    id: String(fm.id),
    created: String(fm.created),
    lastReferenced: String(fm.last),
    ...(fm.provenance ? { provenance: fm.provenance as Provenance } : {}),
    ...(Array.isArray(fm.sources) ? { sources: fm.sources as MemorySource[] } : {}),
    ...(typeof mw.success === "number" ? { mwSuccess: mw.success } : {}),
    ...(typeof mw.fail === "number" ? { mwFail: mw.fail } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format-frontmatter.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/package.json bun-apps/pi-agent-ext-hermes-memory/bun.lock bun-apps/pi-agent-ext-hermes-memory/src/store/memory-format.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-format-frontmatter.test.ts
git commit -m "feat(hermes-memory): YAML frontmatter parse/serialize/detect (ticket 05 schema)"
```

---

### Task 3: Dual-shape transition parser

Make `parseMarkdownMemoryEntry` shape-aware (parse frontmatter OR comment), and add `upgradeEntryToFrontmatter` (comment → frontmatter, assigning a uuid + applying renames). This is the per-entry transform the backfill (Task 4) applies.

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-format.ts` — branch `parseMarkdownMemoryEntry` on `detectEntryShape`; add `upgradeEntryToFrontmatter`.
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-format-transition.test.ts`

**Interfaces:**
- Produces:
  - `upgradeEntryToFrontmatter(raw: string, target: MemoryTarget, project: string | null, id: string): string` — parse a legacy comment entry, return its frontmatter serialization with the given `id`, renaming `lastReferenced`→`last` and `mwSuccess/mwFail`→`memworth`. Preserves all failure fields (`[category]` prefix + ` — ` segments stay in `text`).
  - `parseMarkdownMemoryEntry` now: if `detectEntryShape(rawEntry) === "frontmatter"`, delegate to `parseMetadataFrontmatter` (carrying `id`); else the existing comment path.

- [ ] **Step 1: Write the failing test**

`tests/store/memory-format-transition.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { upgradeEntryToFrontmatter, parseMarkdownMemoryEntry, detectEntryShape } from "../../src/store/memory-format";

describe("dual-shape transition", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  test("upgrade rewrites a comment entry to frontmatter with id, preserving failure fields", () => {
    const legacy = "[failure] boom — Failed: timeout <!-- created=2026-07-30, last=2026-07-31 -->";
    const out = upgradeEntryToFrontmatter(legacy, "failure", null, id);
    expect(detectEntryShape(out)).toBe("frontmatter");
    expect(out).toContain(`id: ${id}`);
    expect(out).toContain("created: 2026-07-30");
    expect(out).toContain("last: 2026-07-31");   // renamed
    // body intact — failure parsing still works on the upgraded entry
    const reparsed = parseMarkdownMemoryEntry(out, "failure", null);
    expect(reparsed.category).toBe("failure");
    expect(reparsed.failureReason).toBe("timeout");
    expect((reparsed as any).id).toBe(id);
  });

  test("parseMarkdownMemoryEntry handles both shapes", () => {
    const legacy = "note <!-- created=2026-08-01, last=2026-08-01 -->";
    expect(parseMarkdownMemoryEntry(legacy, "memory", null).content).toBe("note");
    const fm = "---\nid: x\ncreated: 2026-08-01\nlast: 2026-08-01\n---\nnote";
    const parsed = parseMarkdownMemoryEntry(fm, "memory", null);
    expect(parsed.content).toBe("note");
    expect((parsed as any).id).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format-transition.test.ts )`
Expected: FAIL — `upgradeEntryToFrontmatter` not exported; frontmatter not parsed.

- [ ] **Step 3: Implement**

In `parseMarkdownMemoryEntry`, add the shape branch at the top:
```ts
export function parseMarkdownMemoryEntry(rawEntry: string, target: MemoryTarget, project: string | null = null): ParsedMarkdownMemoryEntry {
  if (detectEntryShape(rawEntry) === "frontmatter") {
    const fm = parseMetadataFrontmatter(rawEntry);
    // re-derive failure fields from the body for the failure target (same logic as below)
    if (target !== "failure") return { ...fm, target, project: normalizeNullable(project) };
    return { ...deriveFailureFields(fm.content), ...fm, target, project: normalizeNullable(project) };
  }
  // …existing comment path unchanged…
}
```
Add a small `deriveFailureFields(text)` helper factoring the existing `[category]` / ` — ` segment parsing (extract from the current failure branch; both shapes reuse it). Add the upgrader:
```ts
export function upgradeEntryToFrontmatter(raw: string, _target: MemoryTarget, _project: string | null, id: string): string {
  const { text, created, lastReferenced, provenance, sources, mwSuccess, mwFail } = parseMetadataComment(raw);
  return serializeMetadataFrontmatter({ id, text, created, last, provenance, sources, mwSuccess, mwFail });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format-transition.test.ts )`
Expected: PASS. Also run the full format suite to confirm no comment-path regression:
`( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format-frontmatter.test.ts )`

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-format.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-format-transition.test.ts
git commit -m "feat(hermes-memory): dual-shape parser — frontmatter detect/parse + comment→frontmatter upgrade"
```

---

### Task 4: One-shot idempotent backfill

The eager migration: on startup, scan every `.md` entry; for each legacy comment entry assign a uuid, rewrite to frontmatter, match its DB row by content-key (Task 1's `getMdIdByContent`), and mirror `md_id` to both sides. Idempotent + resume-safe. Rides the injected-provider seam (no direct repo ref in `MemoryStore`).

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts` — add `setMdIdByContent(content, mdId, options): Promise<number>` (rows updated).
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts` + `surreal-memory-repo.ts` — impls.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts` — add `backfillStableIds(provider)` + the injected `StableIdBackfillProvider` type.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` — wire the provider + invoke `backfillStableIds` at startup (after backend init + `loadFromDisk`).
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/backfill-stable-ids.test.ts`

**Interfaces:**
- Produces:
  - `MemoryRepository.setMdIdByContent(content: string, mdId: string, options: MemoryRemoveOptions): Promise<number>` — `UPDATE memories SET md_id = ? WHERE <scope> AND content = ?`, returns rows changed.
  - `MemoryStore.backfillStableIds(provider: StableIdBackfillProvider): Promise<{ upgraded: number; mdIdsMirrored: number }>` where:
    ```ts
    export interface StableIdBackfillProvider {
      getMdIdByContent(target: MemoryTarget, content: string, project: string | null): Promise<string | null>;
      setMdIdByContent(target: MemoryTarget, content: string, mdId: string, project: string | null): Promise<number>;
    }
    ```

- [ ] **Step 1: Write the failing test**

`tests/store/backfill-stable-ids.test.ts` (uses an in-memory fake provider; no real DB):
```ts
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../../src/store/memory-store";
import type { MemoryConfig } from "../../src/types";

function makeStore(config: Partial<MemoryConfig> = {}): MemoryStore {
  return new MemoryStore({ memoryDir: "/tmp/unused", memoryCharLimit: 10000, userCharLimit: 10000, ...config } as MemoryConfig);
}

describe("backfillStableIds", () => {
  test("upgrades legacy comment entries to frontmatter + assigns uuid; idempotent re-run is a no-op", async () => {
    const store = makeStore();
    // seed two legacy entries directly into the private arrays
    (store as any).memoryEntries = [
      "alpha note <!-- created=2026-08-01, last=2026-08-01 -->",
      "beta note <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    const seen = new Map<string, string>(); // content -> mdId assigned
    const provider = {
      getMdIdByContent: async (_t: any, content: string) => seen.get(content) ?? null,
      setMdIdByContent: async (_t: any, content: string, mdId: string) => { seen.set(content, mdId); return 1; },
    };
    const r1 = await store.backfillStableIds(provider);
    expect(r1.upgraded).toBe(2);
    expect(r1.mdIdsMirrored).toBe(2);
    // both entries now frontmatter with distinct uuids
    const entries = (store as any).memoryEntries as string[];
    expect(entries.every((e) => e.startsWith("---\n"))).toBe(true);
    const ids = entries.map((e) => e.match(/^id: (.+)$/m)![1]);
    expect(new Set(ids).size).toBe(2);

    const r2 = await store.backfillStableIds(provider); // re-run: everything already frontmatter+has-id
    expect(r2.upgraded).toBe(0);
    expect(r2.mdIdsMirrored).toBe(0);
  });

  test("resume-safe: a mix of legacy + already-frontmatter only upgrades the legacy", async () => {
    const store = makeStore();
    (store as any).memoryEntries = [
      "---\nid: 11111111-2222-3333-4444-555555555555\ncreated: 2026-08-01\nlast: 2026-08-01\n---\ndone",
      "legacy <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    const provider = { getMdIdByContent: async () => null, setMdIdByContent: async () => 1 };
    const r = await store.backfillStableIds(provider);
    expect(r.upgraded).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/backfill-stable-ids.test.ts )`
Expected: FAIL — `backfillStableIds` not a method.

- [ ] **Step 3: `setMdIdByContent` repo impls**

`repository.ts` interface: add `setMdIdByContent(content: string, mdId: string, options: MemoryRemoveOptions): Promise<number>;`
SQLite impl:
```ts
  async setMdIdByContent(content: string, mdId: string, options: MemoryRemoveOptions): Promise<number> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const params: unknown[] = [mdId];
      const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
      conditions.push("content = ?"); params.push(content.trim());
      const res = this.db.prepare(`UPDATE memories SET md_id = ? WHERE ${conditions.join(" AND ")}`).run(...params);
      return res.changes;
    }));
  }
```
Surreal impl:
```ts
  async setMdIdByContent(content: string, mdId: string, options: MemoryRemoveOptions): Promise<number> {
    const scope = buildScope(options.target, options.project ?? undefined);
    const res = await this.c.query<Array<{ id: string }>>(
      `UPDATE type::thing("memories", "seq") SET mdId = $mdId ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content;`,
      { ...scope.params, mdId, content: content.trim() },
    );
    return res.length;
  }
```
> SQLite stores the column as `md_id`; Surreal stores the field as `mdId` (camelCase per the bootstrap convention). The provider adapter in `index.ts` normalizes.

- [ ] **Step 4: `MemoryStore.backfillStableIds`**

In `memory-store.ts` (imports: add `crypto` from `node:crypto`, `detectEntryShape`/`upgradeEntryToFrontmatter`/`stripMetadata` from `./memory-format.js`):
```ts
export interface StableIdBackfillProvider {
  getMdIdByContent(target: "memory" | "user" | "failure", content: string, project: string | null): Promise<string | null>;
  setMdIdByContent(target: "memory" | "user" | "failure", content: string, mdId: string, project: string | null): Promise<number>;
}

async backfillStableIds(provider: StableIdBackfillProvider): Promise<{ upgraded: number; mdIdsMirrored: number }> {
  let upgraded = 0, mdIdsMirrored = 0;
  for (const target of ["memory", "user", "failure"] as const) {
    const entries = this.entriesFor(target);
    let changed = false;
    for (let i = 0; i < entries.length; i++) {
      const raw = entries[i];
      if (detectEntryShape(raw) === "frontmatter") continue;       // idempotent: already done
      const stripped = this.stripMetadata(raw);
      const id = crypto.randomUUID();
      entries[i] = upgradeEntryToFrontmatter(raw, target, null, id);
      upgraded++; changed = true;
      try {
        if (await provider.setMdIdByContent(target, stripped, id, null) > 0) mdIdsMirrored++;
      } catch { /* best-effort: next startup re-matches by content + completes */ }
    }
    if (changed) await this.saveToDisk(target);
  }
  return { upgraded, mdIdsMirrored };
}
```
> Idempotency: a frontmatter entry is always skipped (it has `id`). Resume: a mid-vault crash leaves every rewritten entry independently valid; the next run skips them and continues. Content-key dup → distinct uuids (ticket 01 edge case); dedup resolves post-backfill.

- [ ] **Step 5: Wire from `index.ts` at startup**

In `index.ts`, after the store is constructed + `loadFromDisk()` + the repo is available (where `setSupersededContentProvider` is wired), add:
```ts
store.setStableIdBackfillProvider?.({
  getMdIdByContent: (target, content, project) => memoryRepo.getMdIdByContent(content, { target, ...(project ? { project } : {}) }),
  setMdIdByContent: (target, content, mdId, project) => memoryRepo.setMdIdByContent(content, mdId, { target, ...(project ? { project } : {}) }),
});
try { await store.backfillStableIds(...); } catch { /* never block startup */ }
```
> Prefer storing the provider via a `setStableIdBackfillProvider` injector (mirroring `setSupersededContentProvider`) and calling `backfillStableIds` with no args, so the store stays repo-free. Adjust the test's `backfillStableIds(provider)` signature accordingly if you take this route (pass provider through the setter, call `backfillStableIds()`).

- [ ] **Step 6: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/backfill-stable-ids.test.ts )`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts bun-apps/pi-agent-ext-hermes-memory/src/index.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/backfill-stable-ids.test.ts
git commit -m "feat(hermes-memory): one-shot idempotent backfill — uuid + frontmatter + md_id mirror"
```

---

### Task 5: Retire the content-key bridge (full replace)

Replace content-key matching in `removeExactSyncedMemories` (both repos) + the `.md`-side `purgeSupersededFromMarkdown` with `md_id` matching. Add the retired `md_id` to the vault-offload archive. The backfill's transient content-key use (Task 4) stays — it's the migration matcher, not the steady-state bridge.

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts` — add `removeByMdId(mdId, options): Promise<MemoryRemoveResult>`; deprecate `removeExactSyncedMemories`.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts:452` + `surreal-memory-repo.ts:566` — `removeByMdId` impls (match `md_id`).
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts:611` (`purgeSupersededFromMarkdown`) — match by `md_id`, not stripped content.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts:1008` (`decodeEntry` archive shape) + `:742` (`writeKnowledgeArchive`) — include retired `md_id` in the `.knowledge.jsonl` archive.
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts:277` (`syncEvictionsFromSqlite`) + `src/handlers/review-memory-ops.ts:276` (`syncEvictions`) + the transfer call (`memory-tool.ts:442`) — call `removeByMdId`.
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/retire-content-key.test.ts`

**Interfaces:**
- Produces: `MemoryRepository.removeByMdId(mdId: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>`.
- Consumes: `parseMetadataFrontmatter` (to read `id` from a frontmatter entry for `.md`-side matching).

- [ ] **Step 1: Write the failing test**

`tests/store/retire-content-key.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../../src/store/memory-store";
import type { MemoryConfig } from "../../src/types";

describe("retire content-key bridge", () => {
  test("purgeSupersededFromMarkdown matches by md_id, not content", async () => {
    const store = new MemoryStore({ memoryDir: "/tmp/x", memoryCharLimit: 10000, userCharLimit: 10000 } as MemoryConfig);
    const TARGET_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    (store as any).memoryEntries = [
      `---\nid: ${TARGET_ID}\ncreated: 2026-08-01\nlast: 2026-08-01\n---\nkeep me`,
      `---\nid: ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee\ncreated: 2026-08-01\nlast: 2026-08-01\n---\nevict me`,
    ];
    // internal purge takes md_ids now
    const purged = await (store as any).purgeSupersededFromMarkdown("memory", ["ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"]);
    expect(purged).toEqual(["ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"]);
    expect((store as any).memoryEntries.length).toBe(1);
    expect((store as any).memoryEntries[0]).toContain(TARGET_ID);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/retire-content-key.test.ts )`
Expected: FAIL — `purgeSupersededFromMarkdown` still matches on stripped content.

- [ ] **Step 3: `removeByMdId` repo impls**

`repository.ts`: add `removeByMdId(mdId: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;` and mark `removeExactSyncedMemories` `/** @deprecated backfill-only — use removeByMdId in steady state */`.
SQLite:
```ts
  async removeByMdId(mdId: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const params: unknown[] = [mdId];
      const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
      conditions.push("md_id = ?"); params.push(mdId); // md_id added once via conditions
      const ids = this.db.prepare(`SELECT id FROM memories WHERE ${conditions.join(" AND ")}`).all(...params) as Array<{ id: number }>;
      if (ids.length === 0) return { matched: 0, removed: 0 };
      const ph = ids.map(() => "?").join(",");
      const res = this.db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...ids.map((r) => r.id));
      return { matched: ids.length, removed: res.changes };
    }));
  }
```
Surreal:
```ts
  async removeByMdId(mdId: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Array<{ id: string }>>(
      `SELECT id FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} mdId = $mdId;`, { ...scope.params, mdId });
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} mdId = $mdId;`, { ...scope.params, mdId });
    return { matched: matched.length, removed: matched.length };
  }
```

- [ ] **Step 4: `.md`-side purge → id-based**

Rewrite `purgeSupersededFromMarkdown(target, supersededMdIds: string[])`: for each entry, read its `id` via `parseMetadataFrontmatter` (frontmatter entries) — if `id ∈ want`, purge; return the purged ids. (Superseded contents now arrive as md_ids from the provider, which reads DB `mdId`.)

- [ ] **Step 5: Vault archive carries retired `md_id`**

Widen `decodeEntry`'s archive projection + `vaultOffloadAndAdd`'s `evictedDecoded` to include `mdId` (read from frontmatter `id`), and have `writeKnowledgeArchive` emit a `md_id` field per record (provenance, not a join key).

- [ ] **Step 6: Rewire callers to `removeByMdId`**

In `memory-tool.ts` `syncEvictionsFromSqlite` and `review-memory-ops.ts` `syncEvictions`: the eviction list now carries md_ids (from the store's purge). Replace `removeExactSyncedMemories(entry, …)` with `removeByMdId(mdId, …)`. Same for the transfer call at `memory-tool.ts:442`.

- [ ] **Step 7: Run test to verify it passes + full suite**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/retire-content-key.test.ts && bun test )`
Expected: PASS (and the full suite stays green — eviction/offload/transfer paths now key on md_id).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/repository.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts bun-apps/pi-agent-ext-hermes-memory/src/handlers/review-memory-ops.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/retire-content-key.test.ts
git commit -m "feat(hermes-memory): retire content-key bridge — md_id matching + vault archive provenance"
```

---

### Task 6: Id-lifecycle contract tests (integration)

Encode ticket 03's contract as integration tests: ids are born (uuid), immutable through supersession, die tracelessly on consolidation/offload. These are the acceptance gate before the 1-release safety net + `NOT NULL` enforcement.

**Files:**
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/integration/id-lifecycle.test.ts`

**Interfaces:**
- Consumes: the full store + repo (via the existing `tests/integration/flow.test.ts` harness pattern).

- [ ] **Step 1: Write the contract tests**

`tests/integration/id-lifecycle.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
// reuse the integration harness from tests/integration/flow.test.ts (tmp memoryDir + sqlite backend)

describe("id-lifecycle contract (ticket 03)", () => {
  test("consolidation: merged entry gets a FRESH uuid; consumed entries' md_id hard-deleted (no tombstone)", async () => {
    // seed two active entries; trigger consolidation; assert merged row.md_id != either consumed md_id,
    // and neither consumed md_id remains in the DB (traceless).
  });

  test("offload (both D2 superseded + vault-offload floor): DB row + md_id deleted together", async () => {
    // fill a target past its char limit with superseded entries → D2 purge deletes rows + md_id;
    // fill past limit with active entries → vault-offload deletes rows + md_id, archive carries retired md_id.
  });

  test("supersession: status flip active→superseded leaves .md id + DB md_id UNCHANGED", async () => {
    // supersede an entry; assert the .md frontmatter id and the DB md_id are byte-identical pre/post.
  });

  test("id immutability: re-backfill never changes a present id", async () => {
    // run backfill twice; assert every entry's id is stable across runs.
  });
});
```
> Fill each test body using the harness from `tests/integration/flow.test.ts` (open the file; mirror its `setup()` for a tmp dir + `SqliteBackend` + `MemoryStore` + `SqliteMemoryRepository` wiring). These are the real acceptance assertions — no skips.

- [ ] **Step 2: Run + verify**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/id-lifecycle.test.ts )`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/tests/integration/id-lifecycle.test.ts
git commit -m "test(hermes-memory): id-lifecycle contract — birth/immutable/death-traceless (ticket 03)"
```

---

## Self-Review

**1. Spec coverage** (5d tickets → tasks):
- 00 (identity=uuid frontmatter) → Task 2 (`id` field) + Task 3 (upgrade assigns uuid). ✓
- 01 (eager one-shot backfill) → Task 4. ✓
- 02 (agnostic md_id, lineage DB-only) → Task 1 (column/index) + Task 4 (`md_id` mirror, lineage untouched). ✓
- 03 (lifecycle contract) → Task 6. ✓
- 04 (retire content-key, full replace) → Task 5. ✓
- 05 (frontmatter schema) → Task 2 (exact schema + renames). ✓
- 06 (dual-shape parser) → Task 3. ✓
- Gap check: the `NOT NULL` enforcement + legacy read-path retirement (+1-release safety net) are deliberately deferred post-merge — not a task here, recorded as a follow-up below.

**2. Placeholder scan:** no "TBD"/"TODO"; integration test bodies in Task 6 reference the `flow.test.ts` harness by name (the implementer opens + mirrors it) — acceptable per "skilled developer" assumption, not a placeholder. Surreal `setMdIdByContent` uses `type::thing("memories","seq")` — verify the exact record-id form against `normalizeLegacyMemoryIds` (which uses `type::record("memories", ${seq})`) during implementation; prefer `type::record` for consistency.

**3. Type consistency:** `md_id` (SQLite column) vs `mdId` (Surreal field + DTO) — the casing split matches the existing convention (`last_referenced` column vs `lastReferenced` DTO). `last` (frontmatter) vs `lastReferenced` (DTO) rename is applied in Task 2 parse/serialize only. `removeByMdId` / `setMdIdByContent` / `getMdIdByContent` names are consistent across tasks.

## Post-merge follow-up (not in this plan)
- Enforce `md_id NOT NULL` + retire the legacy comment read-path after 1 release of clean backfill observability (the safety net from ticket 01/06).
- Verify SurrealDB `UNIQUE`-on-absent behavior in production before relying on it (Task 1 Step 7).

## Execution Handoff

Plan complete and saved to `.planning/2026-07-31-5d-stable-id-md-status-frontmatter-5b-content-ke/plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
