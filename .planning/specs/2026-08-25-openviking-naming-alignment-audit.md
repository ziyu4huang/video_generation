# OpenViking naming/feature alignment audit — kcard + obsidian

Date: 2026-08-25 · Scope: cross-package alignment of
`s2-agent-ext-knowledge-card` (kcard) and `s2-agent-ext-obsidian` against the
upstream OpenViking vocabulary/surface (local clone `~/proj/OpenViking`,
inventoried 2026-08-25 evening). Carried user directive from the
kcard-resource-tier effort (ranked #1 at its terminal wait-state).

Verdict up front: **naming alignment is already strong where it matters
(algorithm + sidecar + trajectory vocabulary kept by name); the real risks
are three same-name-different-concept traps and one internal kcard polysemy.
No renames are recommended — all findings are DOCUMENT-class, with two small
optional follow-ups. The obsidian package needs NO alignment at all.**

## Method

Two name inventories, then a three-way comparison:

- **kcard surface**: 5 extension tools (`zk_card`, `zk_ask`, `zk_ingest`,
  `knowledge_query`, `zk_fs`; extensions/knowledge-card.ts:356-1181 + RPC
  `zk.retrieve/ingest/health/heal`), 8 CLI subcommands (`zk-card`, `zk-ask`,
  `zk-ingest`, `zk-extract`, `zk-query`, `resource-ingest`, `resource-query`,
  `knowledge-pipeline`), 1 skill (`using-knowledge-cards`), CONTEXT.md
  glossary (zettel + hierarchy + the new resource-tier section, 7 terms),
  env keys (`PI_KG_LLM`, `PI_KG_LLM_MODEL`, `PI_HIERARCHY_DISABLED`,
  `SEMANTIC_EMBED_MODEL`).
- **obsidian surface**: 18 tools (`obsidian`, `_read`, `_create`, `_append`,
  `_append_section`, `_update_frontmatter`, `_list`, `_open`, `_query`,
  `_search` + `_search_help`, `_rename`, `_move`, `_delete`, `_invalidate`,
  `_status`, `_garden`, `_distill`, `_help`), 1 skill
  (`using-obsidian-vault`).
- **upstream surface** (`~/proj/OpenViking`): `ov` CLI (clap enum
  `crates/ov_cli/src/main.rs:305` — AddResource/Ls/Tree/Stat/Read/Abstract/
  Overview/Write/Find/Search/Grep/Session/AddMemory/Reindex/…), python
  package `openviking/` (retrieve/, storage/, resource/, ingest/, parse/,
  session/, …), `openviking_cli/` (doctor, setup_wizard), config vocabulary
  (`retrieval_config.py`), prompt ids (`semantic.overview_generation`, …),
  README/docs concepts (context database, `viking://`, L0/L1/L2,
  tiered loading, directory recursive retrieval, observable retrieval
  trajectory, VikingBot, Studio, context compilation).

## A. Same-name-different-concept traps (the findings that matter)

1. **`HierarchicalRetriever` (upstream) ≠ `hierarchicalRetrieve` (kcard).**
   Upstream's `openviking/retrieve/hierarchical_retriever.py:HierarchicalRetriever`
   is the RESOURCE-tier recursive lane (`_recursive_search`, heap descent).
   kcard's `src/hierarchical-retrieval.ts:hierarchicalRetrieve` is the ZETTEL
   CARD lane (KNN+FTS seeds, γ-propagation BFS — parity ticket 07), and
   kcard's resource recursive lane is `src/resource-recursive.ts`
   (`resourceRecursiveQuery`). A reader mapping upstream names onto kcard
   code lands on the wrong module. → DOCUMENT: recommend the
   cross-reference note in CONTEXT.md's resource-tier section (follow-up F1).
2. **upstream `openviking/resource/` ≠ kcard "resource tier".** Upstream's
   `resource/` package is watch/source management (watch_manager,
   staged_source, git/feishu auth); the tier layer upstream lives in
   `storage/queuefs/` + `retrieve/`. kcard's resource tier is
   `src/resource-index.ts` + `resource-tiers.ts` + `resource-recursive.ts`.
   Reading upstream `resource/` to understand kcard resource rows misleads.
   → DOCUMENT (this audit is the record; cited from the map's fog if needed).
3. **kcard-internal polysemy: "tier".** The card lane's tier-LADDER
   (`src/tier-ladder.ts`, per-card demote-not-truncate, effort
   2026-08-2x-tier-ladder) predates the resource tier's L0/L1/L2 "levels";
   `--tier` on `resource-query` and `tier` on `RetrieveOptions` are
   different concepts sharing one word. → DOCUMENT (CONTEXT.md already
   separates them by section; glossary cross-note is follow-up F1).
4. **Level-2 name: upstream `DETAIL` vs kcard `FILE`.** Upstream
   `ContextLevel.DETAIL=2`; kcard `RESOURCE_LEVEL_FILE=2` (resource-index.ts:59)
   and the CLI help says "L2 = file rows". Same number, different word —
   minor, but it is the one tier-word that did not carry over. → KEEP (kcard's
   word is more accurate for markdown trees; note in CONTEXT.md exists).

## B. Same-concept-different-name pairs (documented, no rename warranted)

| concept | upstream | kcard | disposition |
|---|---|---|---|
| level filter flag | `--level` (Search/Read) | `--tier 0\|1\|2` (resource-query) | KEEP — CLI-only surface, stable per D9; the help text already names upstream's `level` param |
| recursive score mix | `score_propagation_alpha` (default 1.0) | `--alpha` / `RECURSIVE_DEFAULT_ALPHA=0.5` | KEEP — default divergence already adjudicated (t03 N1: 0.5 is THIS lane's measured default; upstream's is 1.0) |
| hotness blend | `hotness_alpha` (default 0.0) | `hotnessAlpha` (bounded [0, 0.1], D39) | KEEP — name aligned; bound is kcard's measured guard |
| convergence constants | `MAX_CONVERGENCE_ROUNDS=3`, `MAX_PARALLEL_CHILD_SEARCHES=4` | same names, same values (resource-recursive.ts:41-42) | ALIGNED (kept by name, t03) |
| sidecar files | `.abstract.md` / `.overview.md` (`LEVEL_URI_SUFFIX`) | same filenames | ALIGNED |
| sidecar metadata | `_METADATA_ORDER=(directory, source, generated_by, freshness)`; `generated_by={component, trigger}`; `freshness={sampled, unsampled, total}` | `generated_by={component, model, trigger}`; `freshness={total_entries, sampled_entries, unsampled_entries, pending_child_changes}` | KEEP — kcard adds `model` + the pending-changes counter (t02 lesson 3); renaming keys would invalidate existing sidecars on the USB4 tree for zero functional gain |
| L0 extraction | `_extract_abstract_from_overview` | first-paragraph extraction from L1 (between H1 and first `##`, clamp 256) | ALIGNED (mechanism ported, t02) |
| per-hit provenance | "observable retrieval trajectory" (README) | `RecursiveHit.trajectory` | ALIGNED (name kept) |
| URI scheme | `viking://resources/…` | tree-relative `uri` + tree slug | KEEP — kcard has no protocol layer (single-user local, parity D1 posture) |
| CLI verb style | FS-verb style (`ov add-resource`, `read`, `find`) | noun-verb style (`resource-ingest`, `resource-query`) | KEEP — surface is CLI-only (D9); zk_* names are kcard-original anyway |
| reindex modes | `ov reindex` (vectors_only / semantic_and_vectors / prune_orphans) | fingerprint-gated full shadow rebuild + swap | KEEP — kcard's rebuild is always-safe (shadow+swap); modes exist because upstream rebuilds in place |

## C. Upstream concepts with NO kcard/obsidian analog — deliberately rejected (do not re-litigate)

- **VikingBot, Web Studio, encryption, privacy configs, multi-tenancy,
  ovpack, watch management, cloud rerank/intent/VLM** — parity **D1**
  (out-of-scope list; also honors the no-cloud rule).
- **Intent analyzer** (`enable_intent`, `recall_intent_timeout_s`,
  `recall_rewrite_timeout_s`) — parity **D19** deterministic posture: no
  reranker, no intent analyzer; the caller passes filters, not a model stage.
- **Reranker, sparse vectors, QueueFS, path locks, cuVS** — parity D1 +
  resource-tier map Context skip list (upstream minimal-subset judgment,
  measured 2026-08-25).
- **RetrieverMode THINKING/QUICK, `DIRECTORY_DOMINANCE_RATIO=1.2`,
  `GLOBAL_SEARCH_TOPK=10`** — un-ported knobs of `_recursive_search`; kcard
  kept only the two constants it measures (rounds + parallelism). Not a
  rejection with a D-number — un-ported-for-MVP; re-open with the
  multi-directory corpus re-judgment (resource-tier D9 trigger), where
  directory-dominance shaping could actually matter.
- **Session-commit→memory extraction** — parity ticket 06 SHIPPED (kcard
  HAS this; aligned).
- **`--context type` (memory|resource|skill)** — kcard splits by table +
  package instead (hermes `memories`, kcard `card`/`resource`); no "skill"
  context type. Keep — the split is the architecture (D2 resource-tier).

## D. kcard/obsidian inventions with NO upstream analog (expected divergences — document, never rename)

- The **zettel lane** entire: `zk_card`/`zk_ingest`/`zk_extract`/`zk_ask`,
  MOC, convergence sink, distill actions, 4-layer duplicate check,
  tier-ladder. kcard-original (the parity effort's starting point).
- **The obsidian package**: upstream has NO Obsidian integration or vault
  concept whatsoever (verified: only an "Obsidian-style" D3 graph-view
  style reference and a `.obsidian/` hidden-dir test fixture). The 18
  `obsidian_*` tool names derive from the Obsidian app domain, not
  OpenViking — **there is nothing to align**; any future "alignment" pass
  over obsidian would be inventing a correspondence that does not exist.

## E. Recommended follow-ups (optional, small)

- **F1 (doc-only)**: one cross-reference note in kcard CONTEXT.md — under
  Retrieval, state that `hierarchicalRetrieve` is the CARD lane and the
  upstream `HierarchicalRetriever` corresponds to `resourceRecursiveQuery`;
  and under Resource tier, that "tier" here means L0/L1/L2 levels, not the
  card lane's tier-ladder. Closes traps A1 + A3 for future readers.
- **F2 (deferred)**: fold `DIRECTORY_DOMINANCE_RATIO` /
  `GLOBAL_SEARCH_TOPK` / RetrieverMode into the resource-tier D9 re-judgment
  ticket whenever the multi-directory corpus lands — they only become
  meaningful there.

No renames, no code changes, no new efforts required by this audit.
