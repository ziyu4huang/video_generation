# Hermes Memory Metadata Channel + Provenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured per-entry metadata channel to hermes's §-delimited memory Markdown files and use it to carry `provenance` + `sources[]` (Markdown-resident, **no DB column**) — the foundational seam that later memory-worth counters (Plan 2) and supersession-lineage fields (Plan 3) will reuse.

**Architecture:** Hermes stores memory as §-delimited Markdown (source of truth) with a SQLite/SurrealDB search index. Per-entry machine metadata today is a trailing inline HTML comment `<!-- created=…, last=… -->`, parsed by **two parallel functions** (`MemoryStore.decodeEntry` private + `memory-format.ts parseMetadataComment` pure). This plan (1) unifies those two paths behind one pure parse/serialize pair in `memory-format.ts`, (2) extends the comment with an OPTIONAL trailing `<!-- meta:{json} -->` segment for structured fields, and (3) adds `provenance` + `sources[]` as its first consumers. The DB schema and `MemoryEntry` (the DB row shape) are **unchanged** — provenance is Markdown-resident only (not read at query time, per spec 06).

**Tech Stack:** TypeScript, `bun test` (tests use `node:test` + `node:assert/strict`, matching `tests/store/memory-store.test.ts`), on-disk tmpdir fixtures.

**Spec reconciliation (from wayfinder spec 06):** The spec said "frontmatter `sources[]`, no DB column." Hermes has **no YAML frontmatter** — per-entry metadata is an inline HTML comment. This plan honors the spec's *intent* (provenance is Markdown-resident, no DB column, not query-time-read) via the meta-comment channel, correcting the mechanism. `MemoryEntry` (DB row) is untouched; the richer `ParsedMarkdownMemoryEntry` carries provenance.

## Global Constraints

- **Markdown is source of truth; DB is a search index rebuilt via `sync-markdown-memories`.** New metadata MUST round-trip through `.md` to survive re-sync.
- **Two parse paths exist** (`memory-store.ts:decodeEntry` + `memory-format.ts:parseMetadataComment`); both MUST agree. This plan **unifies** them (`MemoryStore` delegates to `memory-format`) to eliminate the duplicated regex.
- **Backward compatibility:** existing entries without the meta comment MUST parse unchanged (`provenance`/`sources` undefined).
- **Provenance is `.md`-only** — NO SQLite column, NO SurrealDB field, NO `MemoryEntry` change. (The dual-backend doubling from the wayfinder surprises does NOT apply to this plan.)
- Run tests from `bun-apps/pi-agent-ext-hermes-memory/`: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`. Repo venv NOT needed (pure TS).
- Shell discipline: never top-level `cd` in commands — use `( cd … && … )`.

## File Structure

- **Create:** `tests/store/memory-format.test.ts` — pure-fn tests for parse/serialize round-trip.
- **Create:** `tests/store/memory-metadata.test.ts` — MemoryStore-level tests for add/replace meta threading.
- **Modify:** `src/types.ts` — ADD exported types `Provenance`, `MemorySource`, `EntryMeta`.
- **Modify:** `src/store/memory-format.ts` — EXTEND `parseMetadataComment` (read optional meta) + `parseMarkdownMemoryEntry` (thread meta) + `ParsedMarkdownMemoryEntry`; ADD `serializeMetadataComment` + `EntryMeta`.
- **Modify:** `src/store/memory-store.ts` — `encodeEntry`/`decodeEntry` delegate to `memory-format` fns (eliminate duplicated regex); thread `provenance`/`sources` through `add`/`addFailure` → `_add`/`_addInner` → `encodeEntry`; preserve meta in `_replaceInner`.

**Untouched (important — confirms scope):** `src/store/sqlite/*`, `src/store/surreal/*`, `src/store/repository.ts` (`MemoryEntry`/`MemoryRepository`), `src/store/sqlite/schema.ts`. Provenance never reaches the DB.

---

## Task 1: Types + parse the optional meta comment

**Files:**
- Modify: `src/types.ts` (add `Provenance`, `MemorySource`)
- Modify: `src/store/memory-format.ts:82-92` (`ParsedMarkdownMemoryEntry`), `:45-61` (`parseMetadataComment`), `:94-145` (`parseMarkdownMemoryEntry`)
- Create: `tests/store/memory-format.test.ts`

**Interfaces:**
- Produces: `Provenance` = `"verified" | "unverified" | "none"`; `MemorySource` = `{ kind: string; locator: string; capture: string }`; `parseMetadataComment(raw)` now returns `{ text; created; lastReferenced; provenance?; sources? }`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/memory-format.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMetadataComment, parseMarkdownMemoryEntry } from "../../src/store/memory-format.js";

describe("parseMetadataComment — optional meta segment", () => {
  it("parses created/last only (legacy)", () => {
    const r = parseMetadataComment("use pnpm not npm <!-- created=2026-05-09, last=2026-05-10 -->");
    assert.strictEqual(r.text, "use pnpm not npm");
    assert.strictEqual(r.created, "2026-05-09");
    assert.strictEqual(r.lastReferenced, "2026-05-10");
    assert.strictEqual(r.provenance, undefined);
    assert.strictEqual(r.sources, undefined);
  });

  it("parses a trailing meta comment with provenance + sources", () => {
    const raw = 'use pnpm <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{"provenance":"verified","sources":[{"kind":"quote","locator":"s12","capture":"use pnpm"}]} -->';
    const r = parseMetadataComment(raw);
    assert.strictEqual(r.text, "use pnpm");
    assert.strictEqual(r.provenance, "verified");
    assert.deepStrictEqual(r.sources, [{ kind: "quote", locator: "s12", capture: "use pnpm" }]);
  });

  it("falls back to today for entries with no comment at all", () => {
    const r = parseMetadataComment("bare entry text");
    assert.strictEqual(r.text, "bare entry text");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.created));
  });

  it("ignores a malformed meta comment (keeps created/last)", () => {
    const raw = 'x <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{not json} -->';
    const r = parseMetadataComment(raw);
    assert.strictEqual(r.text, "x");
    assert.strictEqual(r.provenance, undefined);
  });
});

describe("parseMarkdownMemoryEntry — threads meta", () => {
  it("carries provenance through the memory-target parse", () => {
    const raw = 'use pnpm <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{"provenance":"unverified"} -->';
    const e = parseMarkdownMemoryEntry(raw, "memory", null);
    assert.strictEqual(e.content, "use pnpm");
    assert.strictEqual(e.provenance, "unverified");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format.test.ts )`
Expected: FAIL — `parseMetadataComment` returns no `provenance`/`sources` (and the meta text leaks into `text`).

- [ ] **Step 3: Add the types**

In `src/types.ts`, add (near the `MemoryCategory` definition around line 135):

```typescript
/** Trust/auditability marker for a memory entry. Markdown-resident only. */
export type Provenance = "verified" | "unverified" | "none";

/** A grounding source attached to a memory entry (quote, doc ref, etc.). */
export interface MemorySource {
  kind: string;     // e.g. "quote", "doc", "url"
  locator: string;  // stable ref into the source (session id, url, line)
  capture: string;  // the verbatim text/anchor
}
```

- [ ] **Step 4: Extend `ParsedMarkdownMemoryEntry` and `parseMetadataComment`**

In `src/store/memory-format.ts`:

Extend the import from `../types.js` to include `Provenance, MemorySource`. Extend `ParsedMarkdownMemoryEntry` (line 82-92) — add two optional fields:

```typescript
export interface ParsedMarkdownMemoryEntry {
  content: string;
  target: MemoryTarget;
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
  provenance?: Provenance | null;
  sources?: MemorySource[] | null;
}
```

Replace `parseMetadataComment` (line 45-61) with a two-stage version (strips optional trailing meta, then the unchanged created/last regex):

```typescript
export function parseMetadataComment(raw: string): {
  text: string;
  created: string;
  lastReferenced: string;
  provenance?: Provenance;
  sources?: MemorySource[];
} {
  let rest = raw;
  let provenance: Provenance | undefined;
  let sources: MemorySource[] | undefined;

  // Stage 1: optional trailing <!-- meta:{...} --> (always last).
  const metaMatch = rest.match(/<!--\s*meta:(\{.*\})\s*-->\s*$/);
  if (metaMatch && metaMatch.index !== undefined) {
    try {
      const parsed = JSON.parse(metaMatch[1]) as { provenance?: Provenance; sources?: MemorySource[] };
      provenance = parsed.provenance;
      sources = Array.isArray(parsed.sources) ? parsed.sources : undefined;
    } catch {
      // malformed meta — ignore, keep created/last below
    }
    rest = rest.slice(0, metaMatch.index).trimEnd();
  }

  // Stage 2: unchanged created/last regex on the remainder.
  const match = rest.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^>]+)\s*-->\s*$/);
  if (match) {
    return {
      text: match[1].trim(),
      created: match[2].trim(),
      lastReferenced: match[3].trim(),
      ...(provenance ? { provenance } : {}),
      ...(sources ? { sources } : {}),
    };
  }

  const fallback = today();
  return {
    text: rest.trim(),
    created: fallback,
    lastReferenced: fallback,
    ...(provenance ? { provenance } : {}),
    ...(sources ? { sources } : {}),
  };
}
```

In `parseMarkdownMemoryEntry` (line 94+), destructure the new fields from `parseMetadataComment` and include them in the returned object. Change the destructure line `const { text, created, lastReferenced } = parseMetadataComment(rawEntry);` to also pull `provenance, sources`, and add them to BOTH the non-failure return object and (if you keep a shared shape) the failure return. Minimal edit — add to the non-failure return first:

```typescript
  const { text, created, lastReferenced, provenance, sources } = parseMetadataComment(rawEntry);
  const parsedProject = normalizeNullable(project);

  if (target !== "failure") {
    return {
      content: text,
      target,
      project: parsedProject,
      created,
      lastReferenced,
      ...(provenance ? { provenance } : {}),
      ...(sources ? { sources } : {}),
    };
  }
  // ... existing failure parsing; add the same provenance/sources spread to its return
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format.test.ts )`
Expected: PASS (all 5 assertions).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/types.ts bun-apps/pi-agent-ext-hermes-memory/src/store/memory-format.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-format.test.ts
git commit -m "feat(hermes-memory): parse optional meta comment for provenance/sources"
```

---

## Task 2: Serialize the meta comment + round-trip

**Files:**
- Modify: `src/store/memory-format.ts` (add `serializeMetadataComment`)
- Modify: `tests/store/memory-format.test.ts` (round-trip test)

**Interfaces:**
- Produces: `serializeMetadataComment({ text, created, lastReferenced, provenance?, sources? })` → `string` (the full encoded entry text).

- [ ] **Step 1: Write the failing test**

Append to `tests/store/memory-format.test.ts`:

```typescript
import { serializeMetadataComment } from "../../src/store/memory-format.js";

describe("serializeMetadataComment", () => {
  it("omits the meta comment when no provenance/sources", () => {
    const out = serializeMetadataComment({ text: "hi", created: "2026-05-09", lastReferenced: "2026-05-10" });
    assert.strictEqual(out, "hi <!-- created=2026-05-09, last=2026-05-10 -->");
  });

  it("emits the meta comment with provenance + sources", () => {
    const out = serializeMetadataComment({
      text: "hi",
      created: "2026-05-09",
      lastReferenced: "2026-05-10",
      provenance: "verified",
      sources: [{ kind: "quote", locator: "s1", capture: "hi" }],
    });
    assert.ok(out.includes("<!-- created=2026-05-09, last=2026-05-10 -->"));
    assert.ok(out.includes('<!-- meta:{"provenance":"verified","sources":'));
  });

  it("round-trips through parseMetadataComment", () => {
    const original = {
      text: "use bun not npm",
      created: "2026-05-09",
      lastReferenced: "2026-05-10",
      provenance: "unverified" as const,
      sources: [{ kind: "quote", locator: "s3", capture: "use bun" }],
    };
    const encoded = serializeMetadataComment(original);
    const decoded = parseMetadataComment(encoded);
    assert.deepStrictEqual(decoded, original);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format.test.ts )`
Expected: FAIL — `serializeMetadataComment` is not exported.

- [ ] **Step 3: Add `serializeMetadataComment`**

In `src/store/memory-format.ts` (right after `parseMetadataComment`):

```typescript
export function serializeMetadataComment(input: {
  text: string;
  created: string;
  lastReferenced: string;
  provenance?: Provenance | null;
  sources?: MemorySource[] | null;
}): string {
  let out = `${input.text} <!-- created=${input.created}, last=${input.lastReferenced} -->`;
  const meta: { provenance?: Provenance; sources?: MemorySource[] } = {};
  if (input.provenance) meta.provenance = input.provenance;
  if (input.sources && input.sources.length > 0) meta.sources = input.sources;
  if (meta.provenance || meta.sources) {
    out += ` <!-- meta:${JSON.stringify(meta)} -->`;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-format.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-format.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-format.test.ts
git commit -m "feat(hermes-memory): serializeMetadataComment pure fn (meta channel encode)"
```

---

## Task 3: Unify MemoryStore encode/decode onto the pure fns (behavior-preserving)

**Files:**
- Modify: `src/store/memory-store.ts:846-867` (`encodeEntry`, `decodeEntry`, `stripMetadata`)
- Create: `tests/store/memory-metadata.test.ts` (round-trip regression)

**Interfaces:**
- Consumes: `serializeMetadataComment`, `parseMetadataComment` from `memory-format.js`; `Provenance`, `MemorySource` from `../types.js`.
- Produces: `MemoryStore.encodeEntry` now accepts an optional 4th `meta` arg; `decodeEntry` returns `{ text; created; lastReferenced; provenance?; sources? }`. All existing callers still work (they ignore new fields).

- [ ] **Step 1: Write the failing test (regression: existing round-trip unchanged + meta round-trips)**

Create `tests/store/memory-metadata.test.ts` (mirrors `tests/store/memory-store.test.ts`'s tmpdir + `node:test` setup):

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { MemoryStore } from "../../src/store/memory-store.js";
import { ENTRY_DELIMITER, DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hm-meta-"));
after(() => { fs.rmSync(MEMORY_DIR, { recursive: true, force: true }); });

function makeStore(): MemoryStore {
  const config: MemoryConfig = {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: MEMORY_DIR,
  };
  return new MemoryStore(config);
}

describe("MemoryStore metadata channel (unified encode/decode)", () => {
  it("round-trips a plain entry (no regression)", async () => {
    const store = makeStore();
    await store.add("memory", "plain entry");
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    assert.match(raw, /plain entry <!-- created=\d{4}-\d{2}-\d{2}, last=\d{4}-\d{2}-\d{2} -->/);
    const withMeta = store.entriesWithMeta("memory");
    assert.strictEqual(withMeta[0].text, "plain entry");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-metadata.test.ts )`
Expected: PASS already (this is a regression guard) — if it PASSES, the refactor in Step 4 must keep it green. If it fails first, fix the fixture before refactoring.

- [ ] **Step 3: Refactor — make encode/decode delegate**

In `src/store/memory-store.ts`, add to the existing imports from `./memory-format.js` (or add the import line if absent):

```typescript
import { parseMetadataComment, serializeMetadataComment } from "./memory-format.js";
```

and ensure `Provenance, MemorySource` are imported from `../types.js`.

Replace `encodeEntry` and `decodeEntry` (line 846-867):

```typescript
  private encodeEntry(
    text: string,
    created: string,
    lastReferenced: string,
    meta?: { provenance?: Provenance | null; sources?: MemorySource[] | null },
  ): string {
    return serializeMetadataComment({
      text,
      created,
      lastReferenced,
      provenance: meta?.provenance,
      sources: meta?.sources,
    });
  }

  private decodeEntry(raw: string): {
    text: string;
    created: string;
    lastReferenced: string;
    provenance?: Provenance;
    sources?: MemorySource[];
  } {
    return parseMetadataComment(raw);
  }
```

`stripMetadata` (line 868) stays `return this.decodeEntry(text).text;` — unchanged, now backed by the unified parser.

- [ ] **Step 4: Run the full store + new test to verify no regression**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/ )`
Expected: PASS (memory-store, memory-metadata, add-category, etc. all green — the unified parser is behavior-identical for entries without meta).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-metadata.test.ts
git commit -m "refactor(hermes-memory): unify encode/decode onto memory-format pure fns"
```

---

## Task 4: Thread provenance/sources through `add` + `addFailure`

**Files:**
- Modify: `src/store/memory-store.ts:314-345` (`add`, `addFailure`), `:425-467` (`_add`, `_addInner` encode site)
- Modify: `tests/store/memory-metadata.test.ts`

**Interfaces:**
- Produces: `store.add(target, content, { ...options, provenance?, sources? })` and `store.addFailure(content, { ...options, provenance?, sources? })` now persist the meta comment to `.md`.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/memory-metadata.test.ts`:

```typescript
  it("add() persists provenance + sources to the meta comment", async () => {
    const store = makeStore();
    await store.add("memory", "verified fact", {
      provenance: "verified",
      sources: [{ kind: "quote", locator: "s42", capture: "verified fact" }],
    });
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    assert.ok(raw.includes('<!-- meta:{"provenance":"verified","sources":'));
    // And it decodes back:
    const decoded = store.entriesWithMeta("memory")[0];
    assert.strictEqual((decoded as { provenance?: string }).provenance, "verified");
  });

  it("addFailure() persists provenance to the meta comment", async () => {
    const store = makeStore();
    await store.addFailure("don't use npm", {
      category: "correction",
      failureReason: "user corrected",
      provenance: "unverified",
    });
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "failures.md"), "utf-8");
    assert.ok(raw.includes('"provenance":"unverified"'));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-metadata.test.ts )`
Expected: FAIL — `add`/`addFailure` don't accept `provenance`/`sources` (TS error / meta not written).

- [ ] **Step 3: Thread the meta through `_add` → `_addInner` → `encodeEntry`**

In `src/store/memory-store.ts`:

(a) `_add` (line ~425) — add a trailing `meta?` param and pass it through:

```typescript
  private async _add(
    target: "memory" | "user" | "failure",
    content: string,
    signal?: AbortSignal,
    _retriesLeft = 1,
    addedMessage = "Entry added.",
    onProgress?: (message: string) => void,
    meta?: { provenance?: Provenance | null; sources?: MemorySource[] | null },
  ): Promise<MemoryResult> {
    return this.runExclusive(() => this.withFileLock(target, () => this._addInner(target, content, signal, _retriesLeft, addedMessage, onProgress, meta)));
  }
```

(b) `_addInner` (line ~436) — add the same trailing `meta?` param, and at the encode site (the line `const encoded = this.encodeEntry(content, today, today);`) pass it:

```typescript
  private async _addInner(
    target: "memory" | "user" | "failure",
    content: string,
    signal?: AbortSignal,
    _retriesLeft = 1,
    addedMessage = "Entry added.",
    onProgress?: (message: string) => void,
    meta?: { provenance?: Provenance | null; sources?: MemorySource[] | null },
  ): Promise<MemoryResult> {
    // ... unchanged body until the encode line ...
    const encoded = this.encodeEntry(content, today, today, meta);
    // ... unchanged rest ...
  }
```

(c) `add` (line 314) — extend `options` and pass `meta` into both `_add` calls:

```typescript
  async add(
    target: "memory" | "user" | "failure",
    content: string,
    options?: {
      category?: MemoryCategory;
      signal?: AbortSignal;
      onProgress?: (message: string) => void;
      provenance?: Provenance;
      sources?: MemorySource[];
    },
  ): Promise<MemoryResult> {
    const signal = options?.signal;
    const onProgress = options?.onProgress;
    const meta = options?.provenance || options?.sources
      ? { provenance: options?.provenance, sources: options?.sources }
      : undefined;
    if (options?.category) {
      const tagged = `[${options.category}] ${content.trim()}`;
      return this._add(target, tagged, signal, undefined, undefined, onProgress, meta);
    }
    return this._add(target, content, signal, undefined, undefined, onProgress, meta);
  }
```

(d) `addFailure` (line 330) — add `provenance?`/`sources?` to its options type and pass `meta`:

```typescript
  async addFailure(content: string, options: {
    category: MemoryCategory;
    failureReason?: string;
    toolState?: string;
    correctedTo?: string;
    project?: string;
    onProgress?: (message: string) => void;
    provenance?: Provenance;
    sources?: MemorySource[];
  }): Promise<MemoryResult> {
    const failureText = this.buildFailureMemoryText(content, options);
    const meta = options.provenance || options.sources
      ? { provenance: options.provenance, sources: options.sources }
      : undefined;
    return this._add("failure", failureText, undefined, 1, "Failure memory saved: " + options.category, options.onProgress, meta);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-metadata.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-metadata.test.ts
git commit -m "feat(hermes-memory): thread provenance/sources through add + addFailure"
```

---

## Task 5: Preserve meta across `replace`

**Files:**
- Modify: `src/store/memory-store.ts:720-740` (`_replaceInner` encode site)
- Modify: `tests/store/memory-metadata.test.ts`

**Interfaces:**
- Consumes: the extended `decodeEntry` return (now includes `provenance`/`sources`).
- Produces: `store.replace(target, oldText, newContent)` keeps the matched entry's provenance/sources on the rewritten entry.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/memory-metadata.test.ts`:

```typescript
  it("replace() preserves provenance on the rewritten entry", async () => {
    const store = makeStore();
    await store.add("memory", "original fact", {
      provenance: "verified",
      sources: [{ kind: "quote", locator: "s1", capture: "original fact" }],
    });
    const res = await store.replace("memory", "original fact", "updated fact");
    assert.strictEqual(res.success, true);
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    assert.ok(raw.includes("updated fact"));
    assert.ok(raw.includes('"provenance":"verified"'), "provenance must survive replace");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-metadata.test.ts )`
Expected: FAIL — `_replaceInner` calls `encodeEntry(newContent, decoded.created, today)` without meta, so provenance is dropped.

- [ ] **Step 3: Preserve the decoded meta in `_replaceInner`**

In `src/store/memory-store.ts`, in `_replaceInner` (line ~738), change the encode call to pass the decoded meta:

```typescript
    const decoded = this.decodeEntry(matches[0]);
    const today = new Date().toISOString().split("T")[0];
    const encoded = this.encodeEntry(newContent, decoded.created, today, {
      provenance: decoded.provenance,
      sources: decoded.sources,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-metadata.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-metadata.test.ts
git commit -m "fix(hermes-memory): preserve provenance/sources across replace"
```

---

## Self-Review

1. **Spec coverage (wayfinder spec 06, item #2 Provenance):** `sources[]` `{kind, locator, capture}` + `provenance` enum (`verified`/`unverified`/`none`) → Task 1 (types + parse), Task 2 (serialize), Task 4 (write via add/addFailure). "Frontmatter only, no DB column" → confirmed: `MemoryEntry`/schema/sqlite/surreal untouched. `verified requires a surviving source` → **GAP**: no enforcement yet that `provenance:"verified"` implies a non-empty `sources[]`. Add as a follow-up assertion or accept it as a convention for now (the spec 07/08 consumers attach sources at write time). → Decision: note as a known soft-constraint; hard enforcement deferred (it's a write-path guard, trivially added when the memory tool exposes provenance in a later plan).
2. **Placeholder scan:** every code step contains real code; commit messages concrete; file:line refs exact. No "TODO/TBD/similar to".
3. **Type consistency:** `Provenance`/`MemorySource` defined once (types.ts), used identically in `ParsedMarkdownMemoryEntry`, `parseMetadataComment` return, `serializeMetadataComment` input, `encodeEntry` meta param, `add`/`addFailure` options. `decodeEntry` return matches `parseMetadataComment` return.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-hermes-memory-metadata-channel-provenance.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session via executing-plans, batch with checkpoints.

**Which approach?**

This is **Plan 1 of 3** for wayfinder Tier 1. Sequence: **Plan 1** (this — metadata channel + provenance) → **Plan 2** (memory-worth scoring: counters via the same meta channel + dual-backend columns + `graph-ranker` multiplier) → **Plan 3** (supersession: status/lineage + the `.md`-id problem + `memory_supersede` tool + verification probe + correction-detector trigger + consolidation prompt/write-path lineage propagation). Plans 2 and 3 are written after this one lands (they build on its meta channel + unified parser).
