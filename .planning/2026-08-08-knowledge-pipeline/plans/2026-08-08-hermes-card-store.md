# Hermes card-agnostic store — Implementation Plan (06a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the hermes store from memory-shape-specific (`MemoryEntry`) to a **card-agnostic store** over `Card { id, kind, content, frontmatter, embed?, graph? }`, behind a pluggable serializer (memory + knowledge) and a pluggable dedup strategy (memory + knowledge), so the existing vault-md knowledge-graph corpus round-trips through the SQLite backend while memory-cards stay byte-for-byte unchanged.

**Architecture:** The Card model + interfaces are **hermes-local** (`src/store/card.ts`), not in core-interface (they are store-internal, not a cross-extension seam). Two `CardSerializer` impls: `MemorySerializer` (EXTRACT the existing §-md logic from `memory-format.ts` unchanged) and `KnowledgeSerializer` (parse vault obsidian-md → Card). Two `DedupStrategy` impls: `MemoryDedupStrategy` (compose the existing near-dup / hash / topic-key primitives) and `KnowledgeDedupStrategy` (idempotent upsert by `Card.id`). The store gains a per-kind registry and dispatches kind-agnostic CRUD on `card.kind`. SQLite mapping: widen `memories.target` CHECK to include `'knowledge'` + add a nullable JSON `frontmatter` column; `Card.id`↔`memories.md_id` (existing join key); `memory_fts` (FTS5) covers knowledge for free. SurrealDB graph persistence for knowledge is a no-op placeholder in 06a.

**Spec:** `.planning/2026-08-08-knowledge-pipeline/specs/2026-08-08-hermes-card-store.md` (load-bearing: quote its §2/§3/§4 TS verbatim into the impl).

**Tech Stack:** TypeScript, Bun, SQLite (`bun:sqlite`), YAML (`yaml` pkg already a dep).

## Global Constraints
- Platform: Apple Silicon, Bun (no build step; `bunx tsc --noEmit` for type-checking).
- Workspace: `bun-apps/` root with isolated linker — every imported package MUST be a declared dep of the importing package.
- NEVER use a top-level `cd` — use `( cd <dir> && ... )` or `--cwd`.
- NEVER `git add -A` — stage exact paths.
- **Memory-cards MUST NOT regress mid-plan.** Task order is deliberate: Task 1 adds pure types; Task 2 EXTRACTS (relocates) the existing §-md logic unchanged behind the serializer interface and re-points `MemoryStore` at it; every later task is additive. The full existing hermes suite is re-run after Tasks 2, 5, and 6.
- The store reads the vault-md knowledge corpus via `KnowledgeSerializer`; **zk code is NOT modified** (the 4 zk primitives keep writing vault-md). 06a only adds the store's ability to READ/HOLD knowledge-cards.
- hermes is a STATIC extension (in `bun-apps/pi-agent/src/static-extensions.ts`, NOT manifest.json) — this plan adds NO extension registration.
- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.

---

### Task 1: Card model + CardKind + graph types (`src/store/card.ts`)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts`
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/store/card.test.ts`

**Interfaces:**
- Consumes: nothing (pure types).
- Produces: `CardKind`, `Card`, `CardGraph` (spec §2, verbatim).

- [ ] **Step 1: Write the failing test** `src/store/card.test.ts` (type-level + a runtime sanity check that a knowledge Card satisfies the type):
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Card, CardKind, CardGraph } from "./card.js";

describe("Card model", () => {
  it("CardKind includes the 3 memory targets + knowledge", () => {
    const kinds: CardKind[] = ["memory", "user", "failure", "knowledge"];
    assert.deepEqual([...new Set(kinds)].sort(), ["failure", "knowledge", "memory", "user"]);
  });
  it("a knowledge Card satisfies the Card type", () => {
    const c: Card = {
      id: "ltx:cfg-scale-7-lever",
      kind: "knowledge",
      content: "LTX prefers cfg-scale 7 for …",
      frontmatter: { id: "ltx:cfg-scale-7-lever", record_type: "lever", status: "active" },
      graph: { links: ["ltx:cfg-scale-baseline"], entities: [{ type: "param", name: "cfg-scale" }] },
    };
    assert.equal(c.kind, "knowledge");
  });
  it("a memory Card omits optional embed/graph", () => {
    const c: Card = { id: "mem-uuid", kind: "memory", content: "x", frontmatter: { id: "mem-uuid" } };
    assert.equal(c.embed, undefined);
    assert.equal(c.graph, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/card.test.ts )` — Expected: FAIL (cannot resolve `./card.js`).

- [ ] **Step 3: Write** `src/store/card.ts` — copy the `CardKind` / `Card` / `CardGraph` blocks VERBATIM from spec §2. Include the doc-comments (they record the `Card.id ↔ memories.md_id` join + the 06a non-persistence of embed/graph).

- [ ] **Step 4: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/card.test.ts )` — Expected: PASS (3 tests).

- [ ] **Step 5: Type-check.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — Expected: no errors.

- [ ] **Step 6: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card.test.ts` then `git -C <WT> commit -m "feat(hermes): card-agnostic Card model + CardKind (task 06a-1)"`.

**DoD:** `CardKind = "memory" | "user" | "failure" | "knowledge"` exported; `Card`/`CardGraph` exported with `id`/`kind`/`content`/`frontmatter` + optional `embed?`/`graph?`; types-only, zero behavior change; `tsc` clean; no existing file touched.

---

### Task 2: Serializer interface + MemorySerializer (EXTRACT §-md unchanged)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-serializer.ts` (interface)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-serializer.ts` (impl)
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-serializer.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts` (`encodeEntry`/`decodeEntry`/`mdIdOf`/load/save → delegate to `MemorySerializer`; ~lines 677-720, 1703-1832, 1915-1948)

**Interfaces:**
- Consumes: `Card`/`CardKind` from Task 1; `memory-format.ts` (`serializeMetadataFrontmatter`, `parseMarkdownMemoryEntry`, `parseMetadataFrontmatter`, `detectEntryShape`), `constants.ts` (`ENTRY_DELIMITER`).
- Produces: `CardSerializer` (spec §3, verbatim); `MemorySerializer` (impl for kinds memory/user/failure).

- [ ] **Step 1: Write the interface** `src/store/card-serializer.ts` — copy the `CardSerializer<K>` block VERBATIM from spec §3.

- [ ] **Step 2: Write the failing test** `src/store/memory-serializer.test.ts` (byte-identical round-trip vs the existing codec — the regression anchor):
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { MemorySerializer } from "./memory-serializer.js";
import { serializeMetadataFrontmatter, parseMetadataFrontmatter } from "./memory-format.js";
import { ENTRY_DELIMITER } from "../constants.js";
import type { Card } from "./card.js";

describe("MemorySerializer (extracted §-md)", () => {
  const ser = new MemorySerializer();

  it("serialize→deserialize is byte-identical to memory-format for one entry", () => {
    const card: Card = {
      id: "uuid-1", kind: "memory", content: "prefers MLX bf16",
      frontmatter: { id: "uuid-1", created: "2026-08-09", last: "2026-08-09" },
    };
    const frag = ser.serialize(card);
    const expected = serializeMetadataFrontmatter({ id: "uuid-1", text: "prefers MLX bf16", created: "2026-08-09", last: "2026-08-09" });
    assert.equal(frag, expected); // EXTRACT, not a rewrite
  });

  it("deserialize splits a multi-entry section-md file into N cards", () => {
    const file = [ser.serialize({ id: "a", kind: "memory", content: "one", frontmatter: { id: "a", created: "2026-08-09", last: "2026-08-09" } }),
                  ser.serialize({ id: "b", kind: "memory", content: "two", frontmatter: { id: "b", created: "2026-08-09", last: "2026-08-09" } })]
                  .join(ENTRY_DELIMITER);
    const cards = ser.deserialize(file);
    assert.equal(cards.length, 2);
    assert.equal(cards[0]!.id, "a");
    assert.equal(cards[1]!.id, "b");
    assert.equal(cards[0]!.kind, "memory");
  });

  it("preserves content + frontmatter through round-trip", () => {
    const card: Card = { id: "uuid-2", kind: "memory", content: "body text", frontmatter: { id: "uuid-2", created: "2026-08-09", last: "2026-08-09" } };
    const [back] = ser.deserialize(ser.serialize(card));
    assert.equal(back!.id, card.id);
    assert.equal(back!.content, card.content);
    assert.equal(back!.frontmatter.created, "2026-08-09");
  });

  it("kind === the constructor kind (memory/user/failure)", () => {
    assert.equal(new MemorySerializer("failure").kind, "failure");
    assert.equal(new MemorySerializer("user").kind, "user");
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/memory-serializer.test.ts )` — Expected: FAIL (cannot resolve `./memory-serializer.js`).

- [ ] **Step 4: Write** `src/store/memory-serializer.ts`:
  - `constructor(private readonly kind: "memory" | "user" | "failure" = "memory")`.
  - `serialize(card)` → read `id`/`created`/`last`/`state`/`severity`/`pin`/`provenance`/`sources`/`mwSuccess`/`mwFail` from `card.frontmatter` and delegate to `serializeMetadataFrontmatter(...)`. This is a THIN ADAPTER over the existing pure function — identical bytes.
  - `deserialize(fileBytes)` → `fileBytes.split(ENTRY_DELIMITER)`, and for each entry call the SAME shape-aware parse the store does today (`detectEntryShape` → `parseMetadataFrontmatter` / `parseMetadataComment`, mirroring `MemoryStore.decodeEntry` + `parseMarkdownMemoryEntry`), mapping to `Card { id: fm.id ?? <fallback>, kind: this.kind, content: fm.text, frontmatter: <decoded envelope> }`. Skip empty fragments. Return `Card[]`.
  - **No logic is invented** — every parse branch is a 1:1 move of the existing `MemoryStore.decodeEntry`/`mdIdOf`/`dedupNormalize` parse into a reusable, store-independent function. `memory-format.ts` itself is NOT modified (the pure helpers stay).

- [ ] **Step 5: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/memory-serializer.test.ts )` — Expected: PASS (4 tests).

- [ ] **Step 6: Re-point `MemoryStore` at the extracted serializer** (`src/store/memory-store.ts`):
  - Construct a private `private readonly memorySerializer = new MemorySerializer("memory");` (and per-target instances for user/failure) OR a single instance parameterized at call-site.
  - Replace the BODY of `encodeEntry` with `return this.memorySerializer.serialize(card);` (adapt the call shape — `encodeEntry`'s positional args become a `Card`/frontmatter object at the call boundary).
  - Replace the BODY of `decodeEntry` with a delegate to the serializer's internal parse (expose a `decodeOne(raw): DecodedEntry` if needed, OR keep `decodeEntry` calling `memory-format.ts` directly — the key invariant is **bytes unchanged**; if delegating risks drift, keep `decodeEntry` as-is and only route the NEW kind-agnostic ingest path through the serializer).
  - **Guidance:** the minimum-risk extraction is to make `MemorySerializer.serialize`/`deserialize` CALL `memory-format.ts` (which they already do in Step 4), and leave `MemoryStore.encodeEntry`/`decodeEntry` ALSO calling `memory-format.ts` — i.e. both share the single source of truth. Do NOT delete `memory-format.ts` functions. The goal is "the serializer exists and is byte-identical", not "the store is fully rewired". Full rewire of `MemoryStore` internals is 06b.

- [ ] **Step 7: Full memory regression.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bunx tsc --noEmit )` — Expected: ALL green, no type errors. **This is the regression anchor** — if any memory/user/failure test breaks, the extraction drifted; fix before committing.

- [ ] **Step 8: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/card-serializer.ts bun-apps/pi-agent-ext-hermes-memory/src/store/memory-serializer.ts bun-apps/pi-agent-ext-hermes-memory/src/store/memory-serializer.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts` then `git -C <WT> commit -m "feat(hermes): extract §-md codec into MemorySerializer (task 06a-2)"`.

**DoD:** `CardSerializer` interface exported (spec §3 verbatim); `MemorySerializer` round-trips a memory Card byte-identically to `memory-format.ts`; the FULL existing hermes suite is green (memory/user/failure unchanged); `memory-format.ts` is not deleted.

---

### Task 3: KnowledgeSerializer (read vault-md → Card)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-serializer.ts`
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-serializer.test.ts`
- Fixture: `bun-apps/pi-agent-ext-hermes-memory/src/store/__fixtures__/knowledge-card.md` (one real-shaped vault card)

**Interfaces:**
- Consumes: `Card`/`CardGraph` from Task 1; `CardSerializer` from Task 2; the YAML parser (`yaml` pkg, already a hermes dep via `memory-format.ts`).
- Produces: `KnowledgeSerializer` (impl for kind knowledge); parses obsidian frontmatter + `## 核心想法`/`## 連結` body sections + `entities`/`relations` additive frontmatter.

- [ ] **Step 1: Write the fixture** `src/store/__fixtures__/knowledge-card.md` — a real-shaped zk card (mirror `ingest.ts:renderCard` output):
```markdown
---
id: ltx:cfg-scale-7-lever
created: 2026-08-08
tags: [zettel, lever, ltx, video]
sources: [workflow-jsonl:mlx-ltx]
source: workflow-jsonl
source_id: ltx:cfg-scale-7-lever
record_type: lever
status: active
superseded_by: ""
confidence: 0.93
dimension: ltx-video
entities: [param:cfg-scale, model:ltx-video]
---
# cfg-scale 7 is the LTX sweet spot

## 核心想法
LTX-2.3 prefers cfg-scale 7 — lower collapses, higher burns.

## 證據 / 脈絡
- type: lever
- confidence: 0.93
- status: active
- provenance: workflow-jsonl:mlx-ltx

## 連結
- 相關：[[ltx:cfg-scale-baseline]]
```

- [ ] **Step 2: Write the failing test** `src/store/knowledge-serializer.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeSerializer } from "./knowledge-serializer.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "__fixtures__/knowledge-card.md"), "utf8");

describe("KnowledgeSerializer (read vault-md)", () => {
  const ser = new KnowledgeSerializer();
  it("kind === knowledge", () => assert.equal(ser.kind, "knowledge"));
  it("deserialize a valid zettel → 1 Card", () => {
    const cards = ser.deserialize(fixture, { filePath: "Zettelkasten/knowledge-graph/ltx-cfg-scale-7-lever.md" });
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "knowledge");
    assert.equal(c.id, "ltx:cfg-scale-7-lever");
    assert.match(c.content, /prefers cfg-scale 7/);            // ## 核心想法 body
    assert.equal(c.frontmatter.record_type, "lever");
    assert.equal(c.frontmatter.status, "active");
    assert.equal(c.frontmatter.confidence, 0.93);
  });
  it("parses wiki-links into graph.links", () => {
    const [c] = ser.deserialize(fixture);
    assert.deepEqual(c!.graph?.links, ["ltx:cfg-scale-baseline"]);
  });
  it("parses typed entities frontmatter into graph.entities", () => {
    const [c] = ser.deserialize(fixture);
    assert.deepEqual(c!.graph?.entities, [{ type: "param", name: "cfg-scale" }, { type: "model", name: "ltx-video" }]);
  });
  it("returns [] for a non-zettel file (does not throw)", () => {
    assert.deepEqual(ser.deserialize("# just a heading\n\nno frontmatter"), []);
    assert.deepEqual(ser.deserialize("---\nid: x\n---\nbody"), []); // tags[0] != zettel
  });
  it("serialize round-trips the Card body-preserving (store does not call this in 06a)", () => {
    const [c] = ser.deserialize(fixture);
    const out = ser.serialize(c!);
    assert.match(out, /id: ltx:cfg-scale-7-lever/);
    assert.match(out, /cfg-scale 7 is the LTX sweet spot/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/knowledge-serializer.test.ts )` — Expected: FAIL (cannot resolve `./knowledge-serializer.js`).

- [ ] **Step 4: Write** `src/store/knowledge-serializer.ts`:
  - `implements CardSerializer<"knowledge">`, `readonly kind = "knowledge"`.
  - `deserialize(fileBytes, opts?)`:
    1. Split frontmatter block (`---\n…\n---`) from body (reuse the fence logic; tolerate a missing block → return `[]`).
    2. Parse YAML frontmatter. **Validate zettel:** require `id`, `created`, `tags` with `tags[0] === "zettel"` (mirror `validateZettelNote`). Invalid → return `[]` (defensive — never throw on one malformed vault file).
    3. `content` = the body under `## 核心想法` (the section between `## 核心想法` and the next `## `); fall back to the whole body if the section is absent.
    4. `graph.links` = parse `## 連結` lines of form `- 相關：[[<slug>]]` → `slug` list.
    5. `graph.entities` = parse additive `entities: [type:name, …]` frontmatter (split on `:`).
    6. `graph.relations` = parse additive `relations: [{s, rel, o}, …]` frontmatter if present (ticket 03; absent in the fixture → undefined).
    7. Return `[{ id: String(fm.id), kind: "knowledge", content, frontmatter: fm, graph }]`.
  - `serialize(card)` — byte-preserving rendering: re-emit the frontmatter (`id, created, tags, …` from `card.frontmatter`) + body (`# <title?>\n\n## 核心想法\n<content>`). Provided for symmetry; the store does NOT call it in 06a.

- [ ] **Step 5: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/knowledge-serializer.test.ts )` — Expected: PASS (6 tests).

- [ ] **Step 6: Type-check + memory regression.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit && bun test )` — Expected: no type errors; full suite green (knowledge-serializer is additive).

- [ ] **Step 7: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-serializer.ts bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-serializer.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/__fixtures__/knowledge-card.md` then `git -C <WT> commit -m "feat(hermes): KnowledgeSerializer reads vault-md → Card (task 06a-3)"`.

**DoD:** `KnowledgeSerializer.deserialize` parses a real-shaped vault card into `Card{kind:"knowledge"}` preserving `id`/`content`/`frontmatter` + populating `graph.links`/`graph.entities`; returns `[]` (no throw) for non-zettel files; `serialize` is byte-preserving; additive only (no memory regression).

---

### Task 4: DedupStrategy interface + 2 impls

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/dedup-strategy.ts` (interface + `DedupDecision`)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-dedup.ts` (impl)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-dedup.ts` (impl)
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/store/dedup-strategy.test.ts`

**Interfaces:**
- Consumes: `Card`/`CardKind` from Task 1; `near-dup.ts` (`findNearDuplicate`, `DEFAULT_NEAR_DUP_THRESHOLD`), `topic-key.ts` (`findTopicRecurrence`), `merge-plan.ts` (`hashEntry`) for memory; nothing new for knowledge.
- Produces: `DedupStrategy` + `DedupDecision` (spec §4, verbatim); `MemoryDedupStrategy`; `KnowledgeDedupStrategy`.

- [ ] **Step 1: Write the interface** `src/store/dedup-strategy.ts` — copy the `DedupStrategy<K>` + `DedupDecision` blocks VERBATIM from spec §4.

- [ ] **Step 2: Write the failing test** `src/store/dedup-strategy.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { MemoryDedupStrategy } from "./memory-dedup.js";
import { KnowledgeDedupStrategy } from "./knowledge-dedup.js";
import type { Card } from "./card.js";

const mk = (id: string, content: string, kind: Card["kind"] = "memory"): Card =>
  ({ id, kind, content, frontmatter: { id } });

describe("DedupStrategy", () => {
  describe("MemoryDedupStrategy", () => {
    const s = new MemoryDedupStrategy();
    it("keep when no existing match", () => {
      assert.equal(s.dedup(mk("a", "totally novel content here"), []).action, "keep");
    });
    it("skip on exact-stripped duplicate (same normalized content)", () => {
      const existing = [mk("a", "prefers MLX bf16 for generation")];
      const d = s.dedup(mk("b", "prefers MLX bf16 for generation"), existing);
      assert.equal(d.action, "skip");
      assert.equal(d.existingId, "a");
    });
    it("skip on a near-duplicate above the containment threshold", () => {
      const existing = [mk("a", "the mupdf renderer fails on encrypted pdfs with a permission error consistently")];
      const d = s.dedup(mk("b", "the mupdf renderer fails on encrypted pdfs with a permission error"), existing);
      assert.equal(d.action, "skip");
    });
  });
  describe("KnowledgeDedupStrategy", () => {
    const s = new KnowledgeDedupStrategy();
    it("keep when the canonical id is new", () => {
      assert.equal(s.dedup(mk("ltx:cfg", "x", "knowledge"), []).action, "keep");
    });
    it("skip (idempotent) when the canonical id already exists", () => {
      const existing = [mk("ltx:cfg", "old body", "knowledge")];
      const d = s.dedup(mk("ltx:cfg", "new body", "knowledge"), existing);
      assert.equal(d.action, "skip");
      assert.equal(d.existingId, "ltx:cfg");
    });
    it("keep when a DIFFERENT canonical id arrives even with identical body", () => {
      const existing = [mk("ltx:cfg", "same body", "knowledge")];
      assert.equal(s.dedup(mk("ltx:other", "same body", "knowledge"), existing).action, "keep");
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/dedup-strategy.test.ts )` — Expected: FAIL (cannot resolve the impls).

- [ ] **Step 4: Write** `src/store/memory-dedup.ts`:
  - `implements DedupStrategy<"memory" | "user" | "failure">`.
  - `dedup(incoming, existing)`:
    1. **Exact stripped-equality:** if any existing card's normalized `content` equals `incoming.content`'s normalized form (strip + trim + collapse ws, mirroring `MemoryStore.dedupNormalize`) → `{ action: "skip", existingId, reason }`.
    2. **Near-dup containment:** `findNearDuplicate(incoming.content, existing.map(e => e.content))` ≥ `DEFAULT_NEAR_DUP_THRESHOLD` → `{ action: "skip", existingId, reason: preview }`.
    3. **Topic recurrence:** `findTopicRecurrence(incoming.content, existing.map(e => e.content))` → `{ action: "skip" | "merge", existingId, reason: formatTopicRecurrenceWarning(hit) }` (reuse the existing warning formatter).
    4. else `{ action: "keep" }`.
  - Logic is COMPOSED from the existing modules — no reinvention.

- [ ] **Step 5: Write** `src/store/knowledge-dedup.ts`:
  - `implements DedupStrategy<"knowledge">`, `readonly kind = "knowledge"`.
  - `dedup(incoming, existing)`: `const hit = existing.find(e => e.id === incoming.id);`
    - `hit` → `{ action: "skip", existingId: incoming.id, reason: "idempotent re-ingest (same canonical id)" }`.
    - else → `{ action: "keep" }`.
  - Doc-comment the 06a rationale + "revisitable in 06b" (spec §6).

- [ ] **Step 6: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/dedup-strategy.test.ts )` — Expected: PASS (6 tests).

- [ ] **Step 7: Type-check.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — Expected: no errors.

- [ ] **Step 8: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/dedup-strategy.ts bun-apps/pi-agent-ext-hermes-memory/src/store/memory-dedup.ts bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-dedup.ts bun-apps/pi-agent-ext-hermes-memory/src/store/dedup-strategy.test.ts` then `git -C <WT> commit -m "feat(hermes): DedupStrategy seam + memory/knowledge impls (task 06a-4)"`.

**DoD:** `DedupStrategy`/`DedupDecision` exported (spec §4 verbatim); `MemoryDedupStrategy` composes the existing near-dup/topic/exact primitives (returns skip/merge/keep); `KnowledgeDedupStrategy` is idempotent-upsert-by-id (skip on id-match, else keep); additive only.

---

### Task 5: Store generalization + SQLite backend mapping

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts` (add per-kind `serializers`/`dedupStrategies` registries + a kind-agnostic ingest path; ~constructor + new methods near `add`/`_addInner`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` (widen `memories.target` CHECK to include `'knowledge'` + add nullable `frontmatter TEXT` column; ~lines 72-96)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts` (additive migration: re-apply the CHECK widen + `frontmatter` column on existing DBs, mirroring the existing `memories_new` table-rewrite pattern at ~lines 815/855)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts` (round-trip `Card.frontmatter` JSON for knowledge rows; `MEMORY_SELECT_COLUMNS` + `mapRow` + the INSERT/UPDATE sites; ~lines 40-66, 252, 361, 383)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (the thin kind-agnostic façade over the existing repo, OR an adapter method on `MemoryStore` — see Step 4)
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts`

**Interfaces:**
- Consumes: `Card` (T1), `CardSerializer`+`MemorySerializer` (T2), `KnowledgeSerializer` (T3), `DedupStrategy`+2 impls (T4); the existing `BackendBundle`/`MemoryRepository`/SQLite repo.
- Produces: a kind-agnostic `upsertCard(card)`/`getCard(id)`/`getCardsByKind(kind)` path over the SQLite backend; `memories.target` accepts `'knowledge'`; `memories.frontmatter` JSON column.

- [ ] **Step 1: Write the failing test** `__tests__/card-store.test.ts` (uses a temp SQLite DB; in-process, no vault):
```ts
import { describe, it, beforeAll, afterAll } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCardStore } from "../src/store/card-store.js";
import { KnowledgeSerializer } from "../src/store/knowledge-serializer.js";
import type { Card } from "../src/store/card.js";

const dir = mkdtempSync(join(tmpdir(), "card-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("card-agnostic store (SQLite round-trip)", () => {
  let store: ReturnType<typeof createCardStore>;
  beforeAll(async () => { store = await createCardStore({ memoryDir: dir, dbBackend: "sqlite" }); });

  it("persists + retrieves a knowledge Card through SQLite", async () => {
    const card: Card = {
      id: "ltx:cfg-scale-7-lever", kind: "knowledge",
      content: "LTX prefers cfg-scale 7",
      frontmatter: { id: "ltx:cfg-scale-7-lever", record_type: "lever", status: "active", confidence: 0.93 },
    };
    await store.upsertCard(card);
    const back = await store.getCard(card.id);
    assert.ok(back);
    assert.equal(back.kind, "knowledge");
    assert.equal(back.id, card.id);
    assert.equal(back.content, card.content);
    assert.equal(back.frontmatter.record_type, "lever");
    assert.equal(back.frontmatter.confidence, 0.93);
  });

  it("re-ingesting the same knowledge id is idempotent (no dup row)", async () => {
    const card: Card = { id: "dup:test", kind: "knowledge", content: "x", frontmatter: { id: "dup:test" } };
    await store.upsertCard(card);
    await store.upsertCard(card);
    const ofKind = await store.getCardsByKind("knowledge");
    assert.equal(ofKind.filter(c => c.id === "dup:test").length, 1);
  });

  it("getCardsByKind('knowledge') returns only knowledge cards", async () => {
    const ofKind = await store.getCardsByKind("knowledge");
    assert.ok(ofKind.every(c => c.kind === "knowledge"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )` — Expected: FAIL (cannot resolve `createCardStore`; CHECK constraint rejects `'knowledge'`).

- [ ] **Step 3: Widen the SQLite schema** (`src/store/sqlite/schema.ts`):
  - `CREATE TABLE … memories`: change `target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure'))` → `… IN ('memory', 'user', 'failure', 'knowledge')`.
  - Add column: `frontmatter TEXT` (nullable, no default) to the `memories` CREATE.
  - `memory_fts` FTS5 + triggers are unchanged (they key on `content`/`id` — knowledge rides them for free).

- [ ] **Step 4: Additive migration for existing DBs** (`src/store/sqlite/sqlite-backend.ts`):
  - Add an idempotent migration step (mirroring the existing `memories_new` table-rewrite at ~815/855): if `memories.target` CHECK lacks `'knowledge'` OR `frontmatter` column is absent, rebuild `memories` into `memories_new` with the widened schema + copy rows (memory rows get `frontmatter = NULL`), swap, re-create the FTS triggers + `idx_memories_md_id`.
  - Prefer a 2-step migration: (a) cheap `ALTER TABLE memories ADD COLUMN frontmatter TEXT` (nullable, no rewrite); (b) the table rewrite is needed ONLY for the `target` CHECK widen. This minimizes the rewrite scope vs. a single combined `memories_new`.
  - **Column-preservation requirement (data-loss guard):** The new `memories_new` CREATE + the INSERT … SELECT MUST carry the FULL current column set — `id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced, mw_success, mw_fail, status, supersedes, superseded_by, parent_ids, md_id, state, severity, pin` — PLUS the new nullable `frontmatter`. **Do NOT copy the column list from the legacy `migrateLegacyMemoriesTargetConstraint` template** (it predates `md_id/state/severity/pin` and omits them — copy-pasting it would silently drop those columns = data loss). Add a migration test that seeds a memory row with non-default `md_id`, `state`, `severity`, `pin` and asserts they survive the rewrite.
  - Gate the migration on `PRAGMA table_info(memories)` / `sqlite_master` SQL-text inspection (the codebase precedent at `sqlite-backend.ts` ~lines 802–808). Note: `extension_metadata` is used only for opaque key/value copy (~lines 423–435), **never** for migration gating — do not repurpose it for that.

- [ ] **Step 5: Round-trip knowledge frontmatter in the SQLite repo** (`src/store/sqlite/sqlite-memory-repo.ts`):
  - Add `frontmatter` to `MEMORY_SELECT_COLUMNS` + `MemoryRow` + `mapRow` (decode JSON → object; `null` → leave absent).
  - At INSERT/UPDATE: when `kind === "knowledge"` (target), serialize `card.frontmatter` → JSON into the `frontmatter` column; for memory kinds, write `NULL` (their metadata stays in dedicated columns).
  - **Do not change any memory-kind column behavior** — memory rows keep `category`/`failure_reason`/`state`/`severity`/`pin` exactly as today; only `frontmatter` is added (and it is NULL for them).

- [ ] **Step 6: Write the kind-agnostic façade** `src/store/card-store.ts`:
  - `createCardStore({ memoryDir, dbBackend })`: build the `BackendBundle` via the existing `createBackendBundle`, register `serializers` (MemorySerializer ×3 kinds + KnowledgeSerializer) and `dedupStrategies` (MemoryDedupStrategy + KnowledgeDedupStrategy), return `{ upsertCard, getCard, getCardsByKind }`.
  - `upsertCard(card)`: look up `dedupStrategies.get(card.kind)`, call `dedup(card, await getCardsByKind(card.kind))`:
    - `keep` → INSERT. When upserting a **knowledge** Card, construct the `memories` row with: `target='knowledge'`, `category=NULL` (knowledge has no category; column is nullable), `state='active'` (NOT NULL DEFAULT), `pin=0` (NOT NULL DEFAULT), `severity=NULL` (nullable), `md_id=Card.id` (the join key), `content=Card.content`, `frontmatter=JSON.stringify(Card.frontmatter)`. Other memory-specific columns (`failure_reason`, `tool_state`, `corrected_to`, `supersedes*`, `mw_*`, `parent_ids`) = NULL for knowledge rows.
    - `skip`/`merge` → no-op in 06a (knowledge `merge` is 06b; memory `merge` already handled by the existing consolidation path — out of scope to rewire here).
  - `getCard(id)` → SELECT by `md_id` → map row → `Card` (decode `frontmatter` JSON for knowledge).
  - `getCardsByKind(kind)` → SELECT by `target` → map rows → `Card[]`.
  - **This façade is ADDITIVE** — it does not replace `MemoryStore`'s memory path. `MemoryStore` keeps driving memory-cards exactly as today; `card-store.ts` is the new kind-agnostic surface knowledge (and, at 06b, the orchestrator) uses.

- [ ] **Step 7: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )` — Expected: PASS (3 tests).

- [ ] **Step 8: Full memory regression + type-check.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bunx tsc --noEmit )` — Expected: ALL green. **Critical:** the schema migration must not alter a single memory row's existing columns; if a memory test breaks, the migration drifted (most likely the `memories_new` rewrite dropped a column or the FTS trigger) — fix before committing.

- [ ] **Step 9: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts` then `git -C <WT> commit -m "feat(hermes): kind-agnostic card store + SQLite knowledge mapping (task 06a-5)"`.

**DoD:** `createCardStore` exposes `upsertCard`/`getCard`/`getCardsByKind`; a knowledge Card round-trips through SQLite with `id`/`kind`/`content`/`frontmatter` preserved; re-ingest is idempotent; `memories.target` accepts `'knowledge'`; memory rows are byte-for-byte unchanged (full suite green); SurrealDB knowledge path is a no-op (not exercised by this task).

---

### Task 6: Round-trip acceptance (real vault corpus) + full regression

**Files:**
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-corpus-roundtrip.test.ts`
- (Optional) fixture generator: a small synthetic vault folder under `__tests__/__fixtures__/vault/` if the real corpus is not available in CI.

**Interfaces:**
- Consumes: `createCardStore` (T5), `KnowledgeSerializer` (T3), `KnowledgeDedupStrategy` (T4).

- [ ] **Step 1: Write the failing acceptance test** `__tests__/knowledge-corpus-roundtrip.test.ts` — build a small synthetic vault folder (3–5 real-shaped zk cards across `lever`/`gotcha`/`pattern` types, one malformed non-zettel file that must be skipped), deserialize each via `KnowledgeSerializer`, `upsertCard` each into a fresh `createCardStore` (temp SQLite dir), then assert the round-trip:
```ts
import { describe, it, beforeAll, afterAll } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createCardStore } from "../src/store/card-store.js";
import { KnowledgeSerializer } from "../src/store/knowledge-serializer.js";

const here = dirname(fileURLToPath(import.meta.url));
const vaultDir = join(here, "__fixtures__/vault");   // 3-5 cards + 1 malformed
const dbDir = mkdtempSync(join(tmpdir(), "corpus-"));
afterAll(() => rmSync(dbDir, { recursive: true, force: true }));

describe("knowledge corpus round-trip (acceptance)", () => {
  it("ingests the vault corpus, retrieves it, preserves id/kind/content/frontmatter", async () => {
    const store = await createCardStore({ memoryDir: dbDir, dbBackend: "sqlite" });
    const ser = new KnowledgeSerializer();
    const files = readdirSync(vaultDir).filter(f => f.endsWith(".md"));
    let ingested = 0;
    for (const f of files) {
      for (const card of ser.deserialize(readFileSync(join(vaultDir, f), "utf8"), { filePath: f })) {
        await store.upsertCard(card); ingested++;
      }
    }
    assert.ok(ingested >= 3, `expected ≥3 valid cards, got ${ingested}`);

    const all = await store.getCardsByKind("knowledge");
    assert.equal(all.length, ingested);
    for (const c of all) {
      assert.equal(c.kind, "knowledge");
      assert.ok(c.id);
      assert.ok(c.content.length > 0);
      assert.ok(c.frontmatter && typeof c.frontmatter === "object");
    }
  });

  it("re-ingesting the whole corpus is fully idempotent", async () => {
    const store = await createCardStore({ memoryDir: mkdtempSync(join(tmpdir(), "corpus2-")), dbBackend: "sqlite" });
    const ser = new KnowledgeSerializer();
    const files = readdirSync(vaultDir).filter(f => f.endsWith(".md"));
    const cards = files.flatMap(f => ser.deserialize(readFileSync(join(vaultDir, f), "utf8")));
    for (const c of cards) await store.upsertCard(c);
    for (const c of cards) await store.upsertCard(c);   // second pass
    assert.equal((await store.getCardsByKind("knowledge")).length, cards.length);
  });
});
```
  - Create the fixture vault `__tests__/__fixtures__/vault/*.md` (3–5 cards mirroring the Task-3 fixture shape across types; include exactly one non-zettel `.md` that the serializer must skip).

- [ ] **Step 2: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/knowledge-corpus-roundtrip.test.ts )` — Expected: FAIL until the fixture vault + (if needed) minor serializer robustness land; iterate to GREEN.

- [ ] **Step 3: Iterate to GREEN.** If a real-shaped corpus card exposes a `KnowledgeSerializer` edge case (e.g. a multi-line `detail`, a `relations:` block, a card with no `## 連結`), fix the serializer minimally; re-run Task-3 tests to confirm no regression.

- [ ] **Step 4: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/knowledge-corpus-roundtrip.test.ts )` — Expected: PASS (2 tests).

- [ ] **Step 5: FULL regression across the affected packages.**
  ```
  ( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bunx tsc --noEmit )
  ( cd bun-apps/pi-agent-ext-knowledge-card && bun test && bunx tsc --noEmit )   # zk UNCHANGED — must stay green untouched
  ( cd bun-apps && bun run test:seam )                                            # seam-contract guard
  ```
  Expected: ALL green. **zk must pass without any modification** (acceptance criterion 3).

- [ ] **Step 6: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-corpus-roundtrip.test.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/__fixtures__/vault/` then `git -C <WT> commit -m "test(hermes): knowledge corpus round-trip acceptance (task 06a-6)"`.

**DoD:** a multi-card vault corpus round-trips through the card-agnostic store (id/kind/content/frontmatter preserved); re-ingest is idempotent; the full hermes suite + the UNCHANGED zk suite + the seam-contract guard are all green.

---

## Notes for the implementer
- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.
- **Memory-cards never regress mid-plan** is the master invariant: Task 1 is types-only; Task 2 is an EXTRACT (relocate, not rewrite) with a byte-identical regression anchor; Tasks 3/4 are additive; Task 5's schema change is additive (CHECK widen + nullable column) with the full suite re-run; Task 6 is acceptance-only. If any memory/user/failure test breaks at a task boundary, STOP and fix — do not proceed.
- **zk is read-only in 06a.** The 4 zk functions are NOT modified. `KnowledgeSerializer` reads what zk already writes; if the serializer mis-parses a real card, fix the SERIALIZER, never zk.
- **SurrealDB knowledge persistence is a placeholder.** Do not add knowledge-graph edges or embed persistence — those are tickets 03/04/06b. The 06a acceptance is SQLite-only.
- The repo disables remote CI and removes branch protection — `gh ship` (squash) merges with zero checks after local self-verification. (For 06a the planning-only PR is left OPEN for review — do not merge automatically.)
- **Out of scope** (do not implement): 06b orchestrator (`ingestPath`/`walkAndIngest`, zk→store mirror wiring), embed index (04), graph indexing (03), drift hooks (05), memory-card migration (13).
---
