# Hermes spine orchestrator — Implementation Plan (06b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the hermes spine for knowledge: an on-demand orchestrator `walkAndIngest(input, opts)` that walks an input with the ticket-06 policy, detects source family, ingests via zk's leaf `ingestRecords` (zk writes vault-md), heals the vault graph via a NEW leaf `healGraph` published on the seam, and mirrors the resulting vault-md knowledge-cards into the 06a card-store (DB mirror, single dedup site). Plus an agent-facing `knowledge_search` tool (reads the vault graph via `retrieveRecords`), vault-path plumbing (env-only, no obsidian import), and a Tier-1 drift hook stub.

**Architecture:** Hermes is the orchestrator (Decision 1): it composes zk LEAVES (`ingestRecords` + the new `healGraph`) via the `KnowledgePipeline` seam and NEVER calls `runConvergenceLoop`. `walkAndIngest` owns the policy walk + family detection (Decision 2), adapts `.knowledge.jsonl` → `KnowledgeRecord[]` itself (Option A; generic-md deferred), ingests, heals, then mirrors vault-md → `KnowledgeSerializer` → `card-store.upsertCard` (Decision 4; single dedup site = `KnowledgeDedupStrategy`, id-upsert). `knowledge_search` wraps `retrieveRecords` (Decision 3). The ONE seam addition is `healGraph` (Decision 1) — zk ALREADY implements it in `retrieve.ts`; 06b only adds it to the interface + publishes it (one-line). zk's `retrieve.ts`/`loop.ts`/`ingest.ts` are UNCHANGED.

**Spec:** `.planning/2026-08-08-knowledge-pipeline/specs/2026-08-08-hermes-spine-orchestrator.md` (load-bearing: quote its "Seam addition — `healGraph`" TS block + the `walkAndIngest` flow + the `knowledge_search` contract verbatim into the impl).

**Tech Stack:** TypeScript, Bun, SQLite (`bun:sqlite` via the 06a `card-store`), typebox (tool params), `@repo/pi-agent-ext-core-interface` (the typed seam).

## Global Constraints
- Platform: Apple Silicon, Bun (no build step; `bunx tsc --noEmit` for type-checking).
- Workspace: `bun-apps/` root with isolated linker — every imported package MUST be a declared dep of the importing package. hermes already depends on `@repo/pi-agent-ext-core-interface` (06a); confirm zk + core-interface do too.
- NEVER use a top-level `cd` — use `( cd <dir> && ... )` or `--cwd`.
- NEVER `git add -A` — stage exact paths.
- **Memory-cards MUST NOT regress mid-plan.** Every task is ADDITIVE: Task 1 adds a seam method + zk publish line (zk leaves unchanged); Tasks 2–7 are new hermes modules + one new tool (no `MemoryStore`/memory-path edits); Task 8 is acceptance. The full hermes suite is re-run after Tasks 1, 6, and 8.
- **zk is read-published, not modified in logic.** `retrieve.ts`/`loop.ts`/`ingest.ts` stay UNCHANGED. The ONLY zk edit is the one-line `publishKnowledgePipeline({...})` addition in `extensions/knowledge-card.ts` (Task 1) — `healGraph` is already imported there.
- hermes is a STATIC extension (`bun-apps/pi-agent/src/static-extensions.ts`, NOT manifest.json) — the new `knowledge_search`/`knowledge_ingest` tools are registered in `src/index.ts` at session init (mirroring `registerMemoryTool`); this plan adds NO extension registration.
- hermes resolves the vault via ENV ONLY (`KNOWLEDGE_VAULT_PATH` ?? `OB_VAULT_PATH`) — NEVER imports `obsidian` or `knowledge-card`. (Task 3.)
- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.
- **Option A is the default path** (workflow-jsonl via hermes JSONL parse → `ingestRecords`; generic-md deferred). Option B (a 6th `ingestFiles` seam leaf) is a flagged alternative — do NOT implement it unless the grader chooses it.

---

### Task 1: `healGraph` seam leaf — core-interface contract + zk publish + hermes read

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts` (add `HealOptions`/`HealReceipt` + the `healGraph` method to `KnowledgePipeline`).
- Modify: `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` (line 654: add `healGraph` to the `publishKnowledgePipeline({...})` object — it is already imported at line 69).
- Modify (test): `bun-apps/pi-agent-ext-knowledge-card/__tests__/knowledge-pipeline-seam.test.ts` (assert `healGraph` is a function on the published object).
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-heal.ts` (defensive `healKnowledgeGraph(opts)` helper over `getKnowledgePipeline()`).
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-heal.test.ts`

**Interfaces:**
- Consumes: zk's `healGraph` (retrieve.ts, unchanged) + `getKnowledgePipeline()` (hermes seam reader).
- Produces: `HealOptions`/`HealReceipt` (core-interface, spec "Seam addition" verbatim); `healKnowledgeGraph(opts): Promise<HealReceipt | undefined>` (hermes helper).

- [ ] **Step 1: Write the failing tests.**
  - zk seam test (`__tests__/knowledge-pipeline-seam.test.ts`): add an assertion that after `publishKnowledgePipeline({ collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords, healGraph })`, `typeof (globalThis as any).__piKnowledgePipeline.healGraph === "function"`.
  - hermes test (`src/knowledge-heal.test.ts`):
    ```ts
    import { describe, it } from "node:test";
    import * as assert from "node:assert/strict";
    import { healKnowledgeGraph } from "./knowledge-heal.js";

    describe("healKnowledgeGraph (defensive seam read)", () => {
      it("returns undefined when the zk seam is absent (graceful, no throw)", async () => {
        // Ensure the seam is unset for this test (delete globalThis.__piKnowledgePipeline).
        delete (globalThis as any).__piKnowledgePipeline;
        const r = await healKnowledgeGraph({ vaultPath: "/nonexistent" });
        assert.equal(r, undefined);
      });
    });
    ```
- [ ] **Step 2: Run tests to verify they fail.** `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/knowledge-pipeline-seam.test.ts )` and `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/knowledge-heal.test.ts )` — Expected: FAIL (zk object lacks `healGraph`; hermes cannot resolve `./knowledge-heal.js`).
- [ ] **Step 3: Add the contract types + method** to `core-interface/src/interfaces/knowledge-pipeline.ts` — copy the `HealOptions`/`HealReceipt` blocks + the `healGraph` method VERBATIM from the spec's "Seam addition — `healGraph`" section. Add `healGraph` to the `KnowledgePipeline` interface (now 5 methods).
- [ ] **Step 4: Publish in zk.** `extensions/knowledge-card.ts:654` → change to `publishKnowledgePipeline({ collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords, healGraph });` (`healGraph` is imported at line 69 — add nothing else). Update the comment on line 651 ("4-function" → "5-function").
- [ ] **Step 5: Write** `src/knowledge-heal.ts` (hermes):
  ```ts
  import { getKnowledgePipeline, type HealOptions, type HealReceipt } from "./knowledge-pipeline-seam.js";
  /** Defensive graph-heal over the zk seam. Returns undefined when zk is absent
   *  (graceful — the caller degrades to no-op, never throws). */
  export async function healKnowledgeGraph(opts: HealOptions): Promise<HealReceipt | undefined> {
    const kp = getKnowledgePipeline();
    if (!kp) return undefined;
    return kp.healGraph(opts);
  }
  ```
  (Re-export `HealOptions`/`HealReceipt` from `knowledge-pipeline-seam.ts` if not already re-exported.)
- [ ] **Step 6: Run tests to verify they pass.** zk seam test + hermes heal test — Expected: PASS.
- [ ] **Step 7: Type-check + seam-contract guard.**
  ```
  ( cd bun-apps/pi-agent-ext-core-interface && bunx tsc --noEmit )
  ( cd bun-apps/pi-agent-ext-knowledge-card && bunx tsc --noEmit && bun test )
  ( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )
  ( cd bun-apps && bun run test:seam )   # 8 keys, no orphans/dead/self-only
  ```
  Expected: ALL green. The seam-contract guard key count is UNCHANGED (same `__piKnowledgePipeline`, one more method — methods are not keys).
- [ ] **Step 8: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts bun-apps/pi-agent-ext-knowledge-card/__tests__/knowledge-pipeline-seam.test.ts bun-apps/pi-agent-ext-hermes-memory/src/knowledge-heal.ts bun-apps/pi-agent-ext-hermes-memory/src/knowledge-heal.test.ts` then `git -C <WT> commit -m "feat(seam): publish zk healGraph as a KnowledgePipeline leaf (task 06b-1)"`.

**DoD:** `HealOptions`/`HealReceipt` + `healGraph` are in core-interface; zk publishes the 5-method object (type-checks at `publishSeam`); hermes `healKnowledgeGraph` returns `undefined` gracefully when the seam is absent; zk's `retrieve.ts`/`loop.ts`/`ingest.ts` UNCHANGED; seam-contract guard green; core-interface + zk + hermes type-check clean.

---

### Task 2: Vault-path plumbing (env-only, no obsidian import)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-vault-path.ts`
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-vault-path.test.ts`

**Interfaces:**
- Consumes: nothing (pure env read + existence check).
- Produces: `resolveKnowledgeVaultPath(): string` (throws clear error when unset/missing); `KNOWLEDGE_FOLDER_DEFAULT`, `KNOWLEDGE_MOC_DEFAULT` constants.

- [ ] **Step 1: Write the failing test** `src/knowledge-vault-path.test.ts`:
  ```ts
  import { describe, it, beforeEach } from "node:test";
  import * as assert from "node:assert/strict";
  import { resolveKnowledgeVaultPath, KNOWLEDGE_FOLDER_DEFAULT } from "./knowledge-vault-path.js";

  describe("resolveKnowledgeVaultPath (env-only)", () => {
    beforeEach(() => { delete process.env.KNOWLEDGE_VAULT_PATH; delete process.env.OB_VAULT_PATH; });
    it("prefers KNOWLEDGE_VAULT_PATH", () => {
      process.env.KNOWLEDGE_VAULT_PATH = "/vault/knowledge";
      process.env.OB_VAULT_PATH = "/vault/obsidian";
      assert.equal(resolveKnowledgeVaultPath(), "/vault/knowledge");
    });
    it("falls back to OB_VAULT_PATH", () => {
      process.env.OB_VAULT_PATH = "/vault/obsidian";
      assert.equal(resolveKnowledgeVaultPath(), "/vault/obsidian");
    });
    it("throws a clear error when both unset", () => {
      assert.throws(() => resolveKnowledgeVaultPath(), /KNOWLEDGE_VAULT_PATH|OB_VAULT_PATH/);
    });
    it("default folder is Zettelkasten/knowledge-graph", () => {
      assert.equal(KNOWLEDGE_FOLDER_DEFAULT, "Zettelkasten/knowledge-graph");
    });
  });
  ```
- [ ] **Step 2: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/knowledge-vault-path.test.ts )` — Expected: FAIL (cannot resolve `./knowledge-vault-path.js`).
- [ ] **Step 3: Write** `src/knowledge-vault-path.ts`:
  ```ts
  import { existsSync } from "node:fs";
  export const KNOWLEDGE_FOLDER_DEFAULT = "Zettelkasten/knowledge-graph";
  export const KNOWLEDGE_MOC_DEFAULT = "Tags/Knowledge Graph.md";
  /** Resolve the knowledge vault path from env ONLY (no obsidian/zk import).
   *  Precedence: KNOWLEDGE_VAULT_PATH (knowledge-pipeline alias) > OB_VAULT_PATH
   *  (obsidian Tier-1a key). Throws a clear, actionable error when both unset or
   *  the resolved path does not exist. */
  export function resolveKnowledgeVaultPath(): string {
    const path = process.env.KNOWLEDGE_VAULT_PATH ?? process.env.OB_VAULT_PATH;
    if (!path) {
      throw new Error(
        "knowledge vault path not configured: set KNOWLEDGE_VAULT_PATH (preferred) or OB_VAULT_PATH to the absolute vault directory.",
      );
    }
    if (!existsSync(path)) {
      throw new Error(`knowledge vault path does not exist: ${path}`);
    }
    return path;
  }
  ```
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS (4 tests).
- [ ] **Step 5: Type-check.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — Expected: clean. **Confirm no `obsidian`/`knowledge-card` import** (`rg -n "obsidian|knowledge-card" src/knowledge-vault-path.ts` → empty).
- [ ] **Step 6: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/knowledge-vault-path.ts bun-apps/pi-agent-ext-hermes-memory/src/knowledge-vault-path.test.ts` then `git -C <WT> commit -m "feat(hermes): env-only knowledge vault-path resolver (task 06b-2)"`.

**DoD:** `resolveKnowledgeVaultPath()` prefers `KNOWLEDGE_VAULT_PATH` then `OB_VAULT_PATH`, throws a clear error when unset/missing, imports NO obsidian/zk module; additive only.

---

### Task 3: Policy walk + source-family detection (`walkKnowledgeSources`)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-walk.ts`
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-walk.test.ts`
- Fixture: `bun-apps/pi-agent-ext-hermes-memory/src/__fixtures__/walk-tree/` (a small tree with a `.knowledge.jsonl`, a generic `.md`, a `.git/` junk dir, a symlink, a binary, an image)

**Interfaces:**
- Consumes: nothing (pure FS walk; NO seam call, NO ingest, NO writes).
- Produces: `walkKnowledgeSources(input, opts): WalkResult` — `{ files: { "workflow-jsonl": string[]; generic: string[] }, skipped: { dirs: string[]; binaries: string[]; symlinks: string[]; deferredFamily: string[] } }`.

- [ ] **Step 1: Write the fixture tree** `src/__fixtures__/walk-tree/`:
  - `workflows/run-a.knowledge.jsonl` (2–3 records)
  - `notes/readme.md` (generic)
  - `.git/config` (junk dir — must be skipped)
  - `node_modules/pkg/index.js` (junk dir)
  - `_archive/old.knowledge.jsonl` (junk dir)
  - `.planning/sdd/x.md` (junk dir)
  - `link.knowledge.jsonl` → symlink to `workflows/run-a.knowledge.jsonl` (must be skipped)
  - `blob.zip` (binary — must be skipped)
  - `pic.png` (image — must be skipped by default, OPT-IN off)
- [ ] **Step 2: Write the failing test** `src/knowledge-walk.test.ts` — walk the fixture tree; assert: `files["workflow-jsonl"]` has exactly the 1 real `.knowledge.jsonl`; `files.generic` has the 1 `.md`; `.git`/`node_modules`/`_archive`/`.planning/sdd` are in `skipped.dirs`; the symlink, `blob.zip`, `pic.png` are in the right `skipped.*` buckets; unlimited depth (a nested `.knowledge.jsonl` 3 levels deep is collected).
- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/knowledge-walk.test.ts )` — Expected: FAIL (cannot resolve `./knowledge-walk.js`).
- [ ] **Step 4: Write** `src/knowledge-walk.ts`:
  - Skip-dir set: `.git`, `node_modules`, `_archive`, `.planning/sdd` (basename/dirname match). Unlimited depth otherwise.
  - Symlinks: `lstat` — skip (`isSymbolicLink()`); never follow.
  - Binary denylist by extension: archives (`.zip`/`.gz`/`.tar`/`.7z`/`.rar`), executables (`.exe`/`.dll`/`.so`/`.dylib`/`.bin`), media (`.mp4`/`.mov`/`.mp3`/`.pdf` — note pdf is ticket 02, not 06b).
  - Images: OPT-IN, default OFF (`opts.includeImages ?? false`); when off, `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp` are skipped.
  - Family detection by extension: `.knowledge.jsonl` → `workflow-jsonl`; `.md` → `generic`; `.agents/memory/**` paths → SKIPPED (memory cards, out of scope) — recorded in `skipped.deferredFamily` for visibility.
  - Returns absolute, sorted, unique paths grouped by family + the `skipped` breakdown.
- [ ] **Step 5: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 6: Type-check + memory regression.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — clean. Additive (no memory-path edit).
- [ ] **Step 7: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/knowledge-walk.ts bun-apps/pi-agent-ext-hermes-memory/src/knowledge-walk.test.ts bun-apps/pi-agent-ext-hermes-memory/src/__fixtures__/walk-tree/` then `git -C <WT> commit -m "feat(hermes): knowledge policy walk + source-family detection (task 06b-3)"`.

**DoD:** `walkKnowledgeSources` applies the ticket-06 skip policy (junk dirs/symlinks/binary denylist/image opt-in), detects family by extension, skips `.agents/memory`, walks unlimited depth, makes NO seam call and NO writes; additive only.

---

### Task 4: workflow-jsonl adapter (hermes-side JSONL parse) + `walkAndIngest` ingest + heal step

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-jsonl.ts` (hermes-side `parseKnowledgeJsonl` against the core-interface `KnowledgeRecord` type — Option A)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (the orchestrator; Tasks 4–6 grow it)
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-jsonl.test.ts`
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts`

**Interfaces:**
- Consumes: `KnowledgeRecord` (core-interface type), `getKnowledgePipeline()` + `healKnowledgeGraph()` (Task 1), `resolveKnowledgeVaultPath()` (Task 2), `walkKnowledgeSources()` (Task 3).
- Produces: `parseKnowledgeJsonl(content): { records: KnowledgeRecord[]; parseErrors: {line;reason}[] }`; `walkAndIngest(input, opts): Promise<WalkAndIngestReceipt>` (ingest + heal ONLY this task; mirror added in Task 6).

- [ ] **Step 1: Write the failing test** `src/knowledge-jsonl.test.ts` — parse a 3-line fixture (1 valid record, 1 missing-id, 1 blank/comment); assert records + parseErrors shape; assert it imports the `KnowledgeRecord` TYPE from `@repo/pi-agent-ext-core-interface` (no zk import).
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL (cannot resolve `./knowledge-jsonl.js`).
- [ ] **Step 3: Write** `src/knowledge-jsonl.ts` — mirror zk's `parseKnowledgeJsonl` shape (split on newlines, skip blank/`#` lines, `JSON.parse`, require non-empty `id`+`title`, coerce/deflate optional fields) against the core-interface `KnowledgeRecord` type. Pure; no zk import.
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Write the failing orchestrator test** `__tests__/walk-and-ingest.test.ts` — set up a temp vault dir + `KNOWLEDGE_VAULT_PATH`; publish a REAL zk-shaped `KnowledgePipeline` stub (or the real zk functions if importable in-test) onto `globalThis.__piKnowledgePipeline`; call `walkAndIngest(fixtureDir)`; assert: `receipt.ok === true`, `receipt.ingest.created + updated ≥ 3`, `receipt.heal` is a non-empty `HealReceipt` (MOC regenerated), vault-md files exist under `<vault>/<folder>/`, `receipt.seamPresent === true`. Also assert graceful `{ ok:false, reason }` when the seam is deleted.
- [ ] **Step 6: Run test to verify it fails.** Expected: FAIL (cannot resolve `./walk-and-ingest.js`).
- [ ] **Step 7: Write** `src/walk-and-ingest.ts` — implement steps 1–7 + 10 of the spec's `walkAndIngest` flow (resolve vault → read seam [graceful] → `walkKnowledgeSources` → parse `workflow-jsonl` via `parseKnowledgeJsonl` → `kp.ingestRecords(records, opts)` → `healKnowledgeGraph({vaultPath,folder,mocPath})` → return receipt with `mirrored:0` placeholder + `driftStub:{filesHashed:0}` placeholder). The mirror (step 8) + drift stub (step 9) are Tasks 6–7. **generic family is detected + reported in `skipped.deferredFamily` (Option A); not ingested.**
- [ ] **Step 8: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 9: Type-check.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — clean.
- [ ] **Step 10: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/knowledge-jsonl.ts bun-apps/pi-agent-ext-hermes-memory/src/knowledge-jsonl.test.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` then `git -C <WT> commit -m "feat(hermes): walkAndIngest ingest (workflow-jsonl) + heal step (task 06b-4)"`.

**DoD:** `parseKnowledgeJsonl` parses against the core-interface type (no zk import); `walkAndIngest` walks → adapts workflow-jsonl → `ingestRecords` (zk writes vault-md) → `healGraph`; returns a real receipt; degrades gracefully when the seam is absent; generic family detected-but-deferred; additive only.

---

### Task 5: DB-mirror via `card-store` (single dedup site) wired into `walkAndIngest`

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (add the mirror step — spec flow step 8).
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (extend).

**Interfaces:**
- Consumes: `createCardStore` + `KnowledgeSerializer` (06a), `getKnowledgePipeline()`.
- Produces: the mirror step reads `<vaultPath>/<folder>/*.md` → `KnowledgeSerializer.deserialize` → `card-store.upsertCard` (idempotent via `KnowledgeDedupStrategy`).

- [ ] **Step 1: Write the failing test extension** — after `walkAndIngest(fixtureDir)` (Task 4 setup), assert `receipt.mirrored === <#vault-md cards>` and a `card-store.getCardsByKind("knowledge")` (constructed against the same memoryDir) returns the same ids as the vault-md filenames; re-run `walkAndIngest` and assert `mirrored` is stable + no duplicate rows (idempotent).
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL (`mirrored` stays 0; store empty).
- [ ] **Step 3: Implement the mirror** in `walk-and-ingest.ts`: after ingest+heal, open a `card-store` (`createCardStore({ memoryDir: opts.memoryDir ?? <vaultPath>/.knowledge-db, dbBackend:"sqlite" })`), `readdirSync(<vaultPath>/<folder>)` for `*.md`, for each `KnowledgeSerializer.deserialize(readFileSync(abs), {filePath:rel}).forEach(c => store.upsertCard(c))`, set `receipt.mirrored`. Use the store's `serializerFor("knowledge")` (the 06a registry) rather than constructing a new `KnowledgeSerializer`, to honour the single-registry invariant. Close the store in a `finally`.
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS (mirror + idempotency).
- [ ] **Step 5: Type-check + memory regression.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit && bun test )` — ALL green. The mirror is additive; `card-store` is the 06a façade (unchanged). **Memory-cards untouched** — the mirror reads `<vault>/<folder>`, never `.agents/memory`.
- [ ] **Step 6: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` then `git -C <WT> commit -m "feat(hermes): walkAndIngest DB-mirror via card-store (task 06b-5)"`.

**DoD:** after `walkAndIngest`, the vault-md knowledge-cards are mirrored into the 06a `card-store` (id/kind/content/frontmatter preserved); re-ingest is idempotent (no dup rows); single dedup site = `KnowledgeDedupStrategy`; memory-cards untouched; full hermes suite green.

---

### Task 6: `knowledge_search` tool + `knowledge_ingest` tool wiring

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/tools/knowledge-search-tool.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/tools/knowledge-ingest-tool.ts` (thin wrapper over `walkAndIngest`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` (register both tools at session init, mirroring `registerMemoryTool`).
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-search-tool.test.ts`

**Interfaces:**
- Consumes: `getKnowledgePipeline()` + `retrieveRecords` (zk), `resolveKnowledgeVaultPath()` (Task 2), `walkAndIngest` (Tasks 4–5).
- Produces: `registerKnowledgeSearchTool(pi, vaultResolver): ToolDefinition`; `registerKnowledgeIngestTool(pi, opts): ToolDefinition`.

- [ ] **Step 1: Write the failing test** `__tests__/knowledge-search-tool.test.ts` — publish a `KnowledgePipeline` stub whose `retrieveRecords` returns a fixed `RetrieveResult`; invoke the registered tool's `execute` with `{ query:"cfg-scale" }`; assert the returned `text` contains the card title + the `details` carries the `RetrieveResult`; assert graceful "zk not present" text when the seam is deleted.
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL (cannot resolve `./tools/knowledge-search-tool.js`).
- [ ] **Step 3: Write** `src/tools/knowledge-search-tool.ts` — mirror the spec's `knowledge_search` contract VERBATIM: `registerKnowledgeSearchTool(pi, vaultResolver)`; `parameters: Type.Object({ query, tags?, topK?, semantic?, excludeIds? })`; `execute` resolves vault/folder, reads the seam (graceful), calls `kp.retrieveRecords({ vaultPath, folder, tags: tags ?? tokenize(query), queryText: query, topK: topK ?? 10, semantic: semantic ?? false, bodyMatch:true, slugDom:true, excludeIds })`, formats `RetrieveResult.cards` (grouped by `type`, highest-shared first) + `digest` into `text` (mirror `formatMemoryResultLine` for the one-line summary), attaches `RetrieveResult` as `details`.
- [ ] **Step 4: Write** `src/tools/knowledge-ingest-tool.ts` — thin wrapper: `registerKnowledgeIngestTool(pi, opts)`; `parameters: Type.Object({ path: Type.String({description:"dir or .knowledge.jsonl to ingest"}) })`; `execute` calls `walkAndIngest([path], opts)` and formats the `WalkAndIngestReceipt` (ingest counts + heal + mirrored + skipped) into `text` + `details`.
- [ ] **Step 5: Wire both tools** in `src/index.ts` near `registerMemoryTool` (line ~387): `registerKnowledgeSearchTool(pi, resolveKnowledgeVaultPathSafe);` + `registerKnowledgeIngestTool(pi, { memoryDir: ... });`. Use a safe resolver that catches the throw and surfaces a clear message (do NOT crash session init when the vault env is unset — the tools degrade to a clear error at call time).
- [ ] **Step 6: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 7: Type-check + FULL memory regression.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit && bun test )` — ALL green (the 2 new tools are additive; memory tool unchanged).
- [ ] **Step 8: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/tools/knowledge-search-tool.ts bun-apps/pi-agent-ext-hermes-memory/src/tools/knowledge-ingest-tool.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-search-tool.test.ts bun-apps/pi-agent-ext-hermes-memory/src/index.ts` then `git -C <WT> commit -m "feat(hermes): knowledge_search + knowledge_ingest tools (task 06b-6)"`.

**DoD:** `knowledge_search` surfaces `retrieveRecords` results (grouped, digest) + graceful "zk not present"; `knowledge_ingest` wraps `walkAndIngest`; both registered at session init without crashing when the vault env is unset; memory tool + full suite unchanged.

---

### Task 7: Tier-1 drift hook stub in the mirror path

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (capture md-hashes around the mirror; log; no re-index action).
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (extend).

**Interfaces:**
- Consumes: the mirror step (Task 5); `node:crypto` for md-hash.
- Produces: `receipt.driftStub = { filesHashed: number; previousHashes?: Record<string,string>; currentHashes: Record<string,string> }`.

- [ ] **Step 1: Write the failing test extension** — after two `walkAndIngest` runs on the SAME input (unchanged vault-md), assert `receipt.driftStub.filesHashed === <#vault-md>` and `driftStub.currentHashes` is a stable `Record<relPath, sha256>`; mutate one vault-md file between runs and assert that file's hash changed in the second receipt.
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL (`driftStub.filesHashed` stays 0).
- [ ] **Step 3: Implement the stub** in `walk-and-ingest.ts`: before the mirror, hash each `<vaultPath>/<folder>/*.md` (sha256 of file bytes) into `currentHashes`; compare to an optional `previousHashes` (passed via opts or read from a sidecar `.knowledge-drift.json` — keep it OPTIONAL/in-memory for 06b); populate `receipt.driftStub`. **NO re-index action** — full Tier-1/2/3 drift is ticket 05. Log `driftStub` at debug only.
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Type-check.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — clean.
- [ ] **Step 6: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` then `git -C <WT> commit -m "feat(hermes): Tier-1 md-hash drift hook stub in mirror path (task 06b-7)"`.

**DoD:** the mirror captures a stable sha256 per mirrored vault-md file into `receipt.driftStub.currentHashes`; hash changes are detectable across runs; NO re-index action (stub only); additive.

---

### Task 8: End-to-end acceptance + full regression

**Files:**
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-pipeline-e2e.test.ts`
- Fixture: reuse the Task-3 `walk-tree/` fixture (or a richer one with 3–5 `.knowledge.jsonl` records across `lever`/`gotcha`/`pattern` types).

**Interfaces:**
- Consumes: everything (Tasks 1–7).

- [ ] **Step 1: Write the failing acceptance test** `__tests__/knowledge-pipeline-e2e.test.ts` — set up a temp vault (`KNOWLEDGE_VAULT_PATH`) + publish the REAL zk `KnowledgePipeline` (the 5-method object: `collectInputFiles`/`ingestRecords`/`runConvergenceLoop`/`retrieveRecords`/`healGraph`) onto the seam; `walkAndIngest(fixtureDir)`; then drive `knowledge_search({ query })` for a tag in the ingested records; assert end-to-end:
  1. vault-md cards written under `<vault>/<folder>/` (zk ingestRecords);
  2. `healGraph` receipt non-empty (MOC regenerated);
  3. DB mirror holds the cards (`card-store.getCardsByKind("knowledge")` ids == vault-md filenames);
  4. `knowledge_search` surfaces ≥1 matching card via `retrieveRecords`;
  5. `.git`/symlink/binary/image are in `walkAndIngest`'s `skipped`;
  6. `.agents/memory` (if present in the fixture) is untouched;
  7. re-running `walkAndIngest` is idempotent (no dup rows; vault-md byte-stable).
- [ ] **Step 2: Run test to verify it fails / iterate to GREEN.** If a real-shaped `.knowledge.jsonl` record exposes a `parseKnowledgeJsonl` edge case, fix the hermes parser minimally (NEVER zk). Expected: PASS.
- [ ] **Step 3: FULL regression across the affected packages.**
  ```
  ( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bunx tsc --noEmit )
  ( cd bun-apps/pi-agent-ext-knowledge-card && bun test && bunx tsc --noEmit )   # zk: ONLY the publish line changed; retrieve/loop/ingest UNCHANGED
  ( cd bun-apps/pi-agent-ext-core-interface && bun test && bunx tsc --noEmit )
  ( cd bun-apps && bun run test:seam )                                            # 8 keys, no orphans/dead/self-only
  ```
  Expected: ALL green. **zk must pass with retrieve.ts/loop.ts/ingest.ts byte-unchanged** (acceptance criterion 7) — the only zk diff is the one-line publish addition.
- [ ] **Step 4: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-pipeline-e2e.test.ts` (+ any fixture additions) then `git -C <WT> commit -m "test(hermes): knowledge-pipeline 06b end-to-end acceptance (task 06b-8)"`.

**DoD:** the full walkAndIngest → heal → mirror → knowledge_search loop works end-to-end against the real zk seam; ingest is idempotent; the full hermes + zk + core-interface + seam-contract suites are green; zk's core library files are unchanged.

---

## Sub-split recommendation
**One plan (default).** The 8 tasks are cohesive and each is independently shippable behind the memory-regression invariant. If the build proves too large in practice, the natural seam is **06b-1 (ingest/mirror/heal = Tasks 1–5 + 7 + 8a)** and **06b-2 (retrieve/drift-UX = Task 6 + 8b)** — i.e. split the `knowledge_search` tool + retrieve-UX follow-ons into a second plan. But the shared `walkAndIngest` orchestrator + seam addition make a single plan the lower-coordination default; the split only pays off if the mirror wiring (Tasks 4–5) uncovers unexpected `card-store` integration friction.

## Notes for the implementer
- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.
- **Memory-cards never regress mid-plan** is the master invariant: Task 1 is a seam publish (zk leaves unchanged); Tasks 2–7 are new hermes modules + 2 new tools (no `MemoryStore`/`memory-tool`/memory-column edits); Task 8 is acceptance. If any memory/user/failure test breaks at a task boundary, STOP and fix — do not proceed.
- **zk is read-published, not logic-modified.** `retrieve.ts`/`loop.ts`/`ingest.ts` stay UNCHANGED. The ONLY zk diff is the one-line `publishKnowledgePipeline({...})` addition (Task 1) — `healGraph` is already imported. If a zk test breaks, the publish addition drifted (most likely the object literal is missing `healGraph` or a type widened) — fix the publish, never zk's library.
- **Option A is the default.** workflow-jsonl via hermes JSONL parse → `ingestRecords`; generic-md detected-but-deferred. Do NOT implement Option B (`ingestFiles` seam leaf) unless the grader explicitly chooses it — it adds a 6th seam method + a zk implementation.
- **hermes never imports obsidian or zk.** Vault resolution is ENV-ONLY (`KNOWLEDGE_VAULT_PATH`/`OB_VAULT_PATH`); the JSONL parse is hermes-side against the core-interface `KnowledgeRecord` type; the mirror uses the 06a `KnowledgeSerializer` + `card-store` (hermes-internal). Every zk call goes through `getKnowledgePipeline()`.
- **`Card.embed`/`Card.graph` stay unpopulated** in 06b (04/03). The mirror does not index them; `knowledge_search(semantic:true)` passes through but has no embed index.
- The repo disables remote CI and removes branch protection — `gh ship` (squash) merges with zero checks after local self-verification. (For 06b the planning-only PR is left OPEN for review — do not merge automatically.)
- **Out of scope** (do not implement): `runConvergenceLoop` call from hermes (Decision 1), embed index (04), full drift (05), graph indexing (03), memory-card migration (13), image ingest (07), `.planning` self-ingest (08/09), Option B `ingestFiles` (unless chosen).
