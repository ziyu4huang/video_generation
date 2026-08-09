---
status: draft
effort: 2026-08-08-knowledge-pipeline
ticket: "06b"
date: 2026-08-09
---
# Hermes spine orchestrator — design (knowledge-pipeline task 06b)

> **Split note:** Ticket 06 ("hermes-as-spine orchestration") implementation is
> split into **06a — card-agnostic store** (SHIPPED, #1141; spec
> `specs/2026-08-08-hermes-card-store.md`, plan
> `plans/2026-08-08-hermes-card-store.md`) and **06b — spine orchestrator**
> (this spec + its plan). 06a made the hermes store kind-agnostic and
> knowledge-capable (`Card`, `CardSerializer`/`MemorySerializer`/
> `KnowledgeSerializer`, `DedupStrategy`/`MemoryDedupStrategy`/
> `KnowledgeDedupStrategy`, the `card-store.ts` façade `createCardStore` →
> `{ upsertCard, getCard, getCardsByKind, serializerFor, close }`). 06b builds
> ON 06a: it wires the zk primitives → vault-md → DB-mirror orchestration loop
> (`walkAndIngest`), adds the `healGraph` seam leaf, and ships the agent-facing
> `knowledge_search` tool. It does NOT touch embed (04), full drift (05), or
> memory-card migration (13).

## Context
Task 06b of the knowledge-pipeline effort — the second half of ticket 06. The
orchestration contract is pinned across the load-bearing tickets:

- **Ticket 06** (closed) — hermes is the spine: it owns the pipeline
  orchestration entry + the store; zk is a primitives provider. The 06
  resolution names `ingestPath`/`walkAndIngest` as the hermes-owned entry,
  calls zk's primitives (`ingestRecords`/`retrieveRecords`/…), and pins the
  conservative walk policy (unlimited depth; skip `.git`/`node_modules`/
  `_archive`/`.planning/sdd`; images OPT-IN default off; symlinks skipped;
  binary denylist). **06b implements the orchestration half.**
- **Ticket 01** (closed, 06-amended) — the unified `Card` model + kind-agnostic
  store via pluggable serializer + **dedup as a single store call-site** behind
  a pluggable strategy. 06a shipped all three; 06b is the first CONSUMER of the
  06a store (the DB-mirror routes every write through `card-store.upsertCard`
  → `KnowledgeDedupStrategy`).
- **Ticket 05** (closed) — DB↔md drift resolves by field-classification (Tier 1
  md-canonical re-index, Tier 2 derived-cache regenerate, Tier 3 DB-authoritative
  opt-in). **06b stubs ONLY the Tier-1 md-hash hook point** in the mirror path;
  full drift logic is ticket 05.
- **Ticket 11/12** (closed/shipped) — the typed `KnowledgePipeline` seam lives
  in `@repo/pi-agent-ext-core-interface`; zk publishes via
  `publishSeam("__piKnowledgePipeline", …)`, hermes reads defensively via
  `getKnowledgePipeline()` (→ `readSeam` → typed-or-undefined). 06b **adds one
  method to this interface** (`healGraph`) — see Decisions.

This spec is grounded in the real post-06a code:
- `bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts`
  (the 4-method `KnowledgePipeline` interface + contract types — `KnowledgeRecord`,
  `IngestOptions`/`IngestSummary`, `RetrieveOptions`/`RetrieveResult`,
  `SourceFamily`, `LinkWeighting`).
- `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-pipeline-seam.ts`
  (`getKnowledgePipeline()`), `src/store/card-store.ts` (the 06a façade),
  `src/store/knowledge-serializer.ts`, `src/store/knowledge-dedup.ts`,
  `src/tools/memory-tool.ts` (the tool-registration pattern to mirror).
- `bun-apps/pi-agent-ext-knowledge-card/src/retrieve.ts`
  (`healGraph`/`graphHealth` — ALREADY standalone leaf primitives),
  `src/loop.ts` (`runConvergenceLoop` composes them as Phase B),
  `src/ingest.ts` (`ingestRecords`, `collectInputFiles`, the per-family adapters),
  `extensions/knowledge-card.ts` (line 654: `publishKnowledgePipeline({
  collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords })` —
  `healGraph` is imported at line 69 but NOT yet published).
- `bun-apps/pi-agent-ext-obsidian/src/lib/vault-resolution.ts`
  (`resolveVault` 3-tier; Tier 1a = `OB_VAULT_PATH` env).

## Goal
Land the hermes spine for knowledge: an on-demand orchestrator
`walkAndIngest(input, opts)` that (a) walks an input dir/file with the ticket-06
policy, (b) detects source family per file, (c) ingests via zk's leaf
`ingestRecords` (zk writes vault-md), (d) heals the vault graph via a NEW leaf
`healGraph` published on the seam, and (e) mirrors the resulting vault-md
knowledge-cards into the 06a card-store (DB mirror, single dedup site). Plus an
agent-facing `knowledge_search` tool that reads the vault graph back via zk's
`retrieveRecords`. Plus vault-path plumbing (env-only, no obsidian import) and a
Tier-1 drift hook stub.

Memory-cards stay on their current path byte-for-byte (regression-green);
`walkAndIngest`/`knowledge_search` target KNOWLEDGE sources, never `.agents/memory`.

## Key findings (from code exploration)
- **`healGraph` is ALREADY a standalone leaf primitive.** It lives in
  `knowledge-card/src/retrieve.ts` as `healGraph(opts: GraphHealthOptions):
  Promise<HealResult>` (regenerate MOC + prune dead canonical `[[…]]` links +
  dedup `## 連結` lines, scoped to the convergence folder). `loop.ts`'s
  `runConvergenceLoop` COMPOSES it as Phase B (the heal-until-dry loop). zk's
  `extensions/knowledge-card.ts` already imports `healGraph` (line 69) and calls
  it for the obsidian garden tool (line 592) — **it is just not on the seam.**
  → Decision 1's "extract the heal phase" is in practice a **publish** (add the
  method to `KnowledgePipeline` + pass it to `publishKnowledgePipeline`), NOT a
  logic extraction. zk's `retrieve.ts`/`loop.ts` are unchanged.
- **`runConvergenceLoop` re-orchestrates** (Phase A ingest + Phase B heal + Phase
  C probe, with collect+adapt per source). Calling it from hermes would
  re-introduce exactly the layering ticket 06 killed. → hermes composes the
  LEAVES (`ingestRecords` + `healGraph`) itself; it never calls
  `runConvergenceLoop`.
- **`ingestRecords` consumes `KnowledgeRecord[]`, not file paths.** Its signature
  is `ingestRecords(records: KnowledgeRecord[], opts: IngestOptions)`. Decision 2's
  "feeds the filtered file list to `ingestRecords`" therefore has an **adapt gap**:
  walked files must become `KnowledgeRecord[]` before the seam call. zk's per-family
  adapters (`parseKnowledgeJsonl`, `adaptHermesMarkdown`, `adaptAutoMemoryMarkdown`,
  `adaptGenericMarkdown`) are a deep dependency web (`parseFrontmatter` from
  obsidian + `extractEntities`/`slugify`/`normTag`/`extractFeatures` from
  `ingest.ts`) that hermes must neither import nor reimplement wholesale. →
  resolved as a flagged secondary fork (§"Secondary forks").
- **`collectInputFiles` is a walk helper, not an adapter.** It expands dirs →
  file paths per family extension; it does NOT produce records. Decision 2 keeps
  it on the seam for other callers but hermes does NOT use it for the policy walk
  (hermes owns the walk so it can apply the ticket-06 skip policy + binary
  denylist + image opt-in, which `collectInputFiles` does not).
- **`OB_VAULT_PATH` is the established vault-path env** (Tier 1a in obsidian's
  `resolveVault`; zk's extension resolves it via `resolveVault(cwd)` /
  `resolveKnowledgeVault(cwd)`). hermes must NOT import obsidian or zk → it reads
  the env directly. A knowledge-pipeline-specific alias (`KNOWLEDGE_VAULT_PATH`)
  takes precedence so the knowledge sink can be pointed independently of the
  obsidian app vault.
- **ADR-0001 auto-converge already runs at `session_shutdown`.** zk's extension
  (line 664) adapts hermes `§`-entries via `adaptHermesMarkdown` and ingests them
  into the vault graph on shutdown (config-gated `OB_HERMES_AUTOCONVERGE`). 06b's
  `walkAndIngest` is the **on-demand, agent-driven** orchestrator for
  workflow-jsonl sources + the DB mirror; it COEXISTS with the shutdown
  auto-converge (both write vault-md via `ingestRecords`; both feed the mirror).
  06b does NOT modify the shutdown path.
- **The 06a store is the mirror sink.** `createCardStore({ memoryDir, dbBackend:
  "sqlite" })` exposes `upsertCard`/`getCard`/`getCardsByKind`/`serializerFor`.
  `KnowledgeSerializer.deserialize(vaultMdBytes, { filePath })` → `Card[]`. The
  mirror is: read `<vaultPath>/<folder>/*.md` → `KnowledgeSerializer` →
  `upsertCard` (single dedup site = `KnowledgeDedupStrategy`, id-upsert →
  idempotent re-mirror).
- **The tool-registration pattern is `registerMemoryTool`.** `registerKnowledgeSearchTool`
  mirrors it: `pi.registerTool({ name, label, gating:{core:true}, description,
  parameters: Type.Object({...}), async execute(...) {...} })`, returns the
  `ToolDefinition`, formats a human-readable `text` + structured `details`.

## The 4 grilled decisions (quoted verbatim + rationale)

> **Decision 1 — Orchestration = leaf primitives only.** Hermes owns
> `walkAndIngest` (walk + ingest + orchestration); calls zk's leaf primitives via
> `getKnowledgePipeline()`. Does NOT call `runConvergenceLoop` (it re-orchestrates
> — re-introduces the layering 06 killed). Graph-heal: **RECOMMEND adding a new
> leaf primitive `healGraph(opts): Promise<HealReceipt>` to the `KnowledgePipeline`
> interface** (core-interface), published by zk (extract the heal phase from
> runConvergenceLoop into a standalone fn), called by hermes after ingest. This
> keeps hermes as orchestrator (decides WHEN to heal) while zk provides the heal
> primitive — cleaner than reimplementing zk's heal in hermes.

**Grounding + rationale.** Verified above: `healGraph` is ALREADY a standalone
leaf in `retrieve.ts` (`loop.ts` composes it). So "extract the heal phase" is in
practice **publish an existing leaf** onto the typed seam — zero heal-logic
changes in zk. hermes calls it ONCE after the ingest batch (it decides WHEN;
zk provides the primitive). This is strictly cleaner than reimplementing
MOC-regen + dead-link pruning in hermes (which would duplicate the
`graphDeadLinks`/`writeMoc`/`isValidSlug` machinery and drift). **Revisitable:**
if a later ticket wants heal unconditionally bundled with ingest, the leaf stays
useful (hermes just always calls it); the recommendation is the addition itself.

> **Decision 2 — Walk policy = hermes owns it.** `walkAndIngest` implements the
> policy walk (skip `.git`/`node_modules`/`_archive`/`.planning/sdd`, skip
> symlinks, binary denylist, images OPT-IN default OFF, unlimited depth) +
> source-family detection (workflow-jsonl vs hermes vs auto-memory vs generic via
> ext/headers). Feeds the filtered file list to `ingestRecords`. Does NOT use
> `collectInputFiles` for the policy walk (it stays on the seam for other callers).

**Grounding + rationale.** `collectInputFiles` only globs by family extension
(no junk-dir skip, no binary denylist, no image opt-in, no symlink guard) — it
cannot express the ticket-06 policy. hermes owns the walk so the policy lives in
ONE place (the spine). Family detection is extension-based (`.knowledge.jsonl` →
`workflow-jsonl`; `.md` → `generic`; the hermes/auto-memory families are
memory-card sources, out of `walkAndIngest`'s default scope — see Secondary
forks). The "feeds the filtered file list to `ingestRecords`" clause has an
adapt gap (`ingestRecords` takes records, not files) — resolved in Secondary
forks (Option A: hermes parses `.knowledge.jsonl` → records; generic deferred).

> **Decision 3 — Retrieve UX = new `knowledge_search` tool.** A hermes tool that
> calls `retrieveRecords` (zk) via the seam and surfaces results to the agent.
> Mirror the `memory-tool.ts` registration pattern.

**Grounding + rationale.** `retrieveRecords(opts)` scans the convergence folder,
matches tags/body/slug, ranks, and returns `RetrieveResult { cards, digest, … }`.
A hermes tool wraps it: resolves vaultPath/folder, calls
`getKnowledgePipeline()?.retrieveRecords(...)`, formats the digest for the TUI.
Graceful "zk not present" when the seam is undefined. It reads the vault-md graph
(lexical + graph; `semantic:true` opt-in is wired but needs the embed index =
ticket 04). The 06a DB mirror is NOT the retrieve path in 06b (the mirror is for
CRUD/dedup; retrieve goes through zk's graph) — flagged for later.

> **Decision 4 — Store writes = DB-mirror only.** zk's `ingestRecords` writes
> vault-md; hermes reads the resulting vault-md knowledge-cards →
> `KnowledgeSerializer` → `card-store.upsertCard` (DB mirror). Hermes does NOT
> drive vault-md writes (consistent with ticket 01: "zk keeps obsidian-md card
> FILE ops"). Single dedup call-site = the 06a `DedupStrategy` (knowledge =
> id-upsert).

**Grounding + rationale.** zk stays the sole writer of vault-md (the git-canonical
card files). hermes is a READ-then-mirror consumer: after ingest, it reads the
vault-md zk just wrote, deserializes via the 06a `KnowledgeSerializer`, and
upserts into the 06a `card-store`. Every store write funnels through
`KnowledgeDedupStrategy.dedup` (id-upsert → re-mirror is idempotent). This honors
ticket 01's single-call-site mandate and keeps zk/obsidian-md writes untouchable
by hermes.

## Secondary forks — resolved with flagged defaults

- **Dedup single-call-site (no conflict).** All store writes route through the
  06a `DedupStrategy` (knowledge = `KnowledgeDedupStrategy`, id-upsert). zk's
  md-layer merge (wiki-aware convergence at `wikiThreshold` ≈ 0.85, inside
  `ingestRecords`) is a VAULT-LAYER concern, NOT a store dedup site → it does not
  compete with ticket 01's single-store-call-site mandate. **Resolved; not
  revisitable unless 01 reopens.**
- **The adapt gap (Decision 2's "file list → ingestRecords").** `ingestRecords`
  takes `KnowledgeRecord[]`, so walked files must be adapted first. zk's family
  adapters are a deep-dep web hermes must not import/reimplement wholesale.
  **Resolved default (Option A, REVISITABLE):** 06b `walkAndIngest` ingests the
  **workflow-jsonl** family (`.knowledge.jsonl`) — hermes parses JSONL itself
  (~40 lines against the core-interface `KnowledgeRecord` type; pure `JSON.parse`
  + field coercion → low drift risk) → `ingestRecords`. **Low drift risk BECAUSE** (a) the shared `KnowledgeRecord` type in core-interface pins the field contract at the seam, AND (b) workflow-jsonl is trivial JSONL with no obsidian/frontmatter/entity deep-dependency coupling. The genuinely drift-prone family (generic-md, which pulls in the deep-dep parse web) is correctly DEFERRED — swap to Option B (a 6th `ingestFiles` seam leaf) exactly when generic-md ingest becomes in-scope.
  The **generic-md** family (needs the deep-dep `adaptGenericMarkdown`) is
  DETECTED by the walk but its ingest is **deferred** behind a future seam leaf
  (Option B). The hermes/auto-memory families are memory-card sources, out of
  `walkAndIngest`'s default scope (no double-ingest of memory-cards).
  **Alternative (Option B, flagged):** add a 6th seam leaf
  `ingestFiles(family, files, opts): Promise<IngestSummary>` that folds all four
  family adapters (zk-internal, no re-orchestration); `walkAndIngest` then ingests
  any family in one seam call. More general, +1 seam method, more zk surface. If
  the grader/implementer prefers full generality now, swap to Option B — the
  `healGraph` addition is unaffected.
- **Vault-path without obsidian import.** hermes resolves the vault via
  `process.env.KNOWLEDGE_VAULT_PATH ?? process.env.OB_VAULT_PATH` (a new
  knowledge-pipeline alias takes precedence; falls back to the established
  obsidian Tier-1a key). Throws a clear error if both are unset/missing. hermes
  does NOT import obsidian's `resolveVault` (that would couple hermes→obsidian,
  violating ticket 06 fork 3) and does NOT import zk's `resolveKnowledgeVault`.
  **Resolved; REVISITABLE** if a config-file key (`~/.pi/.../knowledge.json` or
  hermes `loadConfig()`) is later preferred over env.
- **ingestPath ↔ memory-tool coexistence.** Two entry points into one store via
  two serializers. `walkAndIngest`/`knowledge_search` target KNOWLEDGE sources
  (`.knowledge.jsonl`, vault-md) — NOT `.agents/memory` files → no double-ingest
  of memory-cards. The ADR-0001 shutdown auto-converge (zk-owned) keeps writing
  vault-md from hermes memory; the 06b mirror reads that vault-md too. **Resolved;
  revisit interleaving at ticket 13 (migration).**
- **Default backend.** SQLite (06a default). SurrealDB graph indexing for
  knowledge is deferred (06b/03/04); `createCardStore` already rejects non-sqlite
  for knowledge rows. **Resolved.**
- **Drift hooks (05).** 06b stubs the **Tier-1 md-hash re-index hook point** in
  the mirror path (capture + log the md-hash set of mirrored vault-md files).
  Full Tier-1/2/3 drift logic is ticket 05. **Resolved (stub); REVISITABLE at 05.**
- **Embed index (04).** Out of scope for 06b. `retrieveRecords(semantic:true)` is
  passed through by `knowledge_search` but has no populated index yet; lexical +
  graph retrieval is the 06b path. **Resolved; REVISITABLE at 04.**
- **Test corpus / .planning self-application.** Deferred to tickets 08/09. 06b
  acceptance uses a small synthetic fixture dir (`.knowledge.jsonl` + junk to
  skip). **Resolved.**

## Seam addition — `healGraph` (verbatim TS, added to `KnowledgePipeline`)

```ts
// bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts
// (06b ADDS HealOptions / HealReceipt + the healGraph method.)

/** Scoped graph-heal options. Maps 1:1 to zk's GraphHealthOptions
 *  (retrieve.ts). The convergence-folder scope keeps heal from touching
 *  human-authored cards outside it. */
export interface HealOptions {
  /** Absolute vault path (the convergence sink). */
  vaultPath: string;
  /** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
  folder?: string;
  /** MOC note path, vault-relative (default: Tags/Knowledge Graph.md). */
  mocPath?: string;
}

/** Receipt for a scoped graph-heal. Maps 1:1 to zk's HealResult (retrieve.ts);
 *  renamed HealReceipt here as the canonical seam contract. zk's richer type
 *  assigns structurally at the publishSeam call site (the contract is a SUBSET
 *  promise, per the core-interface pattern). */
export interface HealReceipt {
  /** true iff the MOC was regenerated from on-disk cards. */
  mocRegenerated: boolean;
  /** # of dead canonical `[[…]]` link lines pruned in-card. */
  deadLinksPruned: number;
  /** # of duplicate canonical link lines deduped within `## 連結`. */
  linksDeduped: number;
  /** Vault-relative paths of cards the heal mutated. */
  cardsTouched: string[];
}

// The KnowledgePipeline interface gains ONE method (06b):
export interface KnowledgePipeline {
  collectInputFiles(paths: string[], opts: { source: SourceFamily; cwd: string }): CollectInputFilesResult;
  ingestRecords(records: KnowledgeRecord[], opts: IngestOptions): Promise<IngestSummary>;
  /** Scoped graph-heal (06b). A LEAF primitive — regenerate the convergence-folder
   *  MOC from on-disk cards + prune dead canonical [[…]] links in-card. No ingest,
   *  no convergence loop, no probe. zk already implements it (retrieve.ts);
   *  hermes calls it AFTER ingest to keep the vault graph healthy. */
  healGraph(opts: HealOptions): Promise<HealReceipt>;
  runConvergenceLoop(opts: ConvergeOptions): Promise<ConvergeReceipt>;
  retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult>;
}
```

> **zk publish site (one-line change):**
> `extensions/knowledge-card.ts:654` →
> `publishKnowledgePipeline({ collectInputFiles, ingestRecords, runConvergenceLoop,
> retrieveRecords, healGraph })` (`healGraph` is already imported at line 69).
> `src/knowledge-pipeline-seam.ts`'s `publishKnowledgePipeline(impl:
> KnowledgePipeline)` then type-checks the 5-method object.
>
> **(Option B only — NOT in the 06b default path):** if the adapt gap is resolved
> via a 6th leaf, also add `ingestFiles(opts: IngestFilesOptions): Promise<IngestSummary>`
> + the `IngestFilesOptions` type here, and zk implements/publishes it. The
> default plan (Option A) does NOT add this.

## `walkAndIngest` flow (numbered)

`walkAndIngest(input: string | string[], opts?: WalkOpts): Promise<WalkAndIngestReceipt>`
— hermes-internal orchestrator (exposed to the agent via a thin `knowledge_ingest`
tool; trigger model flagged in Open questions).

1. **Resolve vault.** `vaultPath = process.env.KNOWLEDGE_VAULT_PATH ??
   process.env.OB_VAULT_PATH`; throw a clear error if unset/missing. Resolve
   `folder` (default `Zettelkasten/knowledge-graph`), `mocPath` (default
   `Tags/Knowledge Graph.md`). NO obsidian/zk import.
2. **Read the seam.** `const kp = getKnowledgePipeline();` — if `undefined`,
   return a graceful `{ ok:false, reason:"zk KnowledgePipeline seam not present"
   }` receipt (no throw; the mirror/search degrade to no-op so hermes works
   without zk installed).
3. **Policy walk (hermes owns it).** Recursively expand `input` (dir or file) →
   absolute file list, applying the ticket-06 policy: skip dirs `.git`,
   `node_modules`, `_archive`, `.planning/sdd`; skip symlinks (lstat, never
   follow); skip binaries (denylist by extension — archives, executables, media);
   images OPT-IN (default OFF — VLM cost, ticket 07); unlimited depth. Does NOT
   call `collectInputFiles`.
4. **Source-family detection (per file).** `.knowledge.jsonl` → `workflow-jsonl`;
   `.md` → `generic`; `.agents/memory`/hermes/auto-memory paths → SKIPPED (memory
   cards, out of scope). Group by family. (Option A: ingest `workflow-jsonl`;
   `generic` is detected + reported but ingest DEFERRED. Option B: ingest both
   via `ingestFiles`.)
5. **Adapt (Option A).** For the `workflow-jsonl` group, read each file + parse
   JSONL → `KnowledgeRecord[]` (hermes-side parser against the core-interface
   type; `parseErrors` recorded, never thrown). (Option B: skip — `ingestFiles`
   adapts internally.)
6. **Ingest (leaf).** `const summary = await kp.ingestRecords(records, {
   vaultPath, source:"workflow-jsonl", sourceLabel, folder, mocPath, maxLinks,
   wikiAware, linkWeighting })` → `IngestSummary`. zk writes vault-md; hermes does
   NOT drive vault-md writes. (Option B: `kp.ingestFiles({ source, files, … })`
   per family-group instead.)
7. **Heal (leaf, once).** `const heal = await kp.healGraph({ vaultPath, folder,
   mocPath })` → `HealReceipt`. hermes decides WHEN (once, after the batch).
8. **DB-mirror (single dedup site).** Read `<vaultPath>/<folder>/*.md` → for each,
   `KnowledgeSerializer.deserialize(bytes, { filePath })` → `Card` →
   `card-store.upsertCard(card)` (the 06a store; `KnowledgeDedupStrategy` =
   id-upsert → idempotent re-mirror of the whole folder). Hermes reads vault-md;
   it does NOT write it.
9. **Drift Tier-1 stub.** Capture the md-hash of each mirrored vault-md file
   (before/after); log the hash set as the Tier-1 re-index hook point. No
   re-index action (full drift = ticket 05).
10. **Receipt.** Return `WalkAndIngestReceipt { ok, vaultPath, folder, ingest:
    IngestSummary, heal: HealReceipt, mirrored: number, driftStub: { filesHashed,
    changedSinceLastMirror? }, skipped: { dirs, binaries, symlinks, deferredFamily
    }, seamPresent: boolean }`.

## `knowledge_search` tool contract

Mirrors `registerMemoryTool` (`src/tools/memory-tool.ts`).

```ts
registerKnowledgeSearchTool(pi: ExtensionAPI, vaultResolver: () => string): ToolDefinition
```
- **name:** `knowledge_search`; **label:** `Knowledge search`; **gating:**
  `{ core: true }`.
- **parameters (typebox):**
  - `query: string` — natural-language query (tokenized into tags for the lexical
    path; passed as `queryText` for the semantic path).
  - `tags?: string[]` — optional explicit tag filter (overrides query tokenization
    when present).
  - `topK?: number` — default 10.
  - `semantic?: boolean` — default false (needs the embed index = ticket 04;
    passed through to `retrieveRecords`).
  - `excludeIds?: string[]` — record ids to exclude.
- **execute:** resolve `vaultPath`/`folder`; `const kp = getKnowledgePipeline();`
  — if `undefined`, return a graceful "zk not present" text + details (no throw).
  Else `kp.retrieveRecords({ vaultPath, folder, tags: tags ?? tokenize(query),
  queryText: query, topK, semantic, bodyMatch:true, slugDom:true, excludeIds })`
  → `RetrieveResult`. Format `cards` (grouped by `type`, highest-shared first)
  + `digest` into a human-readable `text`; attach `RetrieveResult` as structured
  `details`. Mirror `formatMemoryResultLine` for the one-line summary shape.
- **Does NOT read the DB mirror** in 06b (retrieve goes through zk's vault-md
  graph). Flagged for later (Open questions).

## Scope

**IN (06b):**
- `walkAndIngest` — policy walk + source-family detection + adapt (workflow-jsonl,
  Option A) + `ingestRecords` + `healGraph` (after ingest) + DB-mirror via
  `card-store` (single dedup site) + Tier-1 drift hook stub.
- The `healGraph` seam addition — core-interface contract (`HealOptions`/
  `HealReceipt` + method) + zk publish (one-line) + hermes defensive read.
- The `knowledge_search` tool — `retrieveRecords` via the seam, formatted for the
  agent; graceful "zk not present".
- Vault-path plumbing — `KNOWLEDGE_VAULT_PATH`/`OB_VAULT_PATH` env resolver, no
  obsidian import.
- A thin `knowledge_ingest` tool wrapping `walkAndIngest` (agent on-demand trigger
  + acceptance-testable). Trigger model flagged.

**OUT (separate tickets):**
- **04** — embed index (`Card.embed` typed but unpopulated; `semantic:true`
  retrieve passes through with no index).
- **05** — full DB↔md drift (Tier-1/2/3 + merge-plan conflict surfacing); 06b
  stubs only the Tier-1 hook point.
- **03** — two-layer graph indexing into SurrealDB (`Card.graph` held on the
  object, not indexed to `RELATE` edges).
- **13** — memory-card migration into the unified store (migrate at graduation).
- **07** — image-card ingest (images OPT-IN, default OFF).
- **08/09** — `.planning` self-ingest / planning-card model.
- **Option B** — the `ingestFiles` 6th seam leaf + generic-md ingest (flagged
  alternative to Option A).

## Acceptance (06b)
1. **walkAndIngest end-to-end:** point `walkAndIngest` at a fixture dir with a
   `.knowledge.jsonl` (2–3 records) + junk to skip (a `.git/` dir, a symlink, a
   binary, an image). Assert: vault-md cards are written under
   `<vaultPath>/<folder>/` (zk `ingestRecords`); `healGraph` returns a non-empty
   `HealReceipt` (MOC regenerated); the DB mirror holds the cards
   (`card-store.getCardsByKind("knowledge")` matches the vault-md ids); junk is
   in `skipped`; memory-cards (`.agents/memory`) are untouched.
2. **Mirror idempotency:** re-running `walkAndIngest` on the same input produces
   no duplicate DB rows (`KnowledgeDedupStrategy` id-upsert); vault-md is
   byte-stable (zk's idempotent ingest).
3. **knowledge_search end-to-end:** after ingest, `knowledge_search({ query })`
   surfaces the ingested card(s) via `retrieveRecords`; returns a graceful
   "zk not present" result when the seam is undefined.
4. **Seam addition:** `healGraph` is on the `KnowledgePipeline` interface; zk
   publishes it (5-method object type-checks at `publishSeam`); hermes reads it
   defensively; the `bun-apps/tests/seam-contract.test.ts` guard stays green
   (no new `__pi*` key — same `__piKnowledgePipeline`, one more method).
5. **Vault-path plumbing:** `walkAndIngest`/`knowledge_search` resolve vaultPath
   from `KNOWLEDGE_VAULT_PATH` then `OB_VAULT_PATH`; throw a clear error when both
   unset; NO `obsidian`/`knowledge-card` import in the hermes resolver.
6. **Memory regression:** the FULL hermes suite stays green (memory/user/failure
   cards unchanged byte-for-byte; `walkAndIngest` never touches `.agents/memory`).
7. **zk regression:** the zk suite stays green; `retrieve.ts`/`loop.ts`/
   `ingest.ts` are UNCHANGED; the only zk edit is the one-line
   `publishKnowledgePipeline({...})` addition (healGraph).

## Out of scope (explicit — other tickets)
- 06b does NOT implement embed (04), full drift (05), graph indexing (03),
  memory-card migration (13), image ingest (07), or `.planning` self-ingest
  (08/09).
- 06b does NOT call `runConvergenceLoop` from hermes (Decision 1).
- 06b does NOT widen the seam beyond `healGraph` in the default path (Option B's
  `ingestFiles` is flagged, not shipped unless the grader chooses it).
- 06b does NOT modify zk's `retrieve.ts`/`loop.ts`/`ingest.ts`.

## Open questions for later (flag for review)
1. **Adapt-gap resolution (Option A vs B).** 06b ships Option A (workflow-jsonl
   via hermes JSONL parse; generic deferred). Is the hermes-side JSONL parse
   acceptable duplication, or should Option B (`ingestFiles` seam leaf) ship now
   for full generality? — revisitable at impl sign-off.
2. **`walkAndIngest` trigger model.** 06b exposes it via a `knowledge_ingest`
   tool (agent on-demand). Should it ALSO run on a session event (e.g.
   `session_start`/`resources_discover`)? How does it interleave with the
   ADR-0001 `session_shutdown` auto-converge (zk-owned)? — flagged; resolve at
   the trigger-wiring ticket (not 06b's default).
3. **`knowledge_search` source.** 06b routes retrieve through zk's `retrieveRecords`
   (vault-md graph). Once the DB mirror is populated, should `knowledge_search`
   prefer the SQLite `memory_fts` (faster, no vault read) and fall back to
   `retrieveRecords`? — flagged for 04 (semantic) / a retrieve-UX follow-on.
4. **Mirror scope.** 06b mirrors the WHOLE convergence folder each run (idempotent
   via id-upsert). Should it mirror only `IngestSummary.cards[].path` (touched)
   for efficiency? — defer the measurement to 06b-impl.
5. **`Card.embed`/`Card.graph`.** Still unpopulated/unindexed in 06b (04/03). The
   mirror does not need them; confirm no 06b path reads them.
6. **generic-md ingest.** Detected by the walk but deferred (Option A). Confirm
   no 06b acceptance requires it; if it does, swap to Option B.
