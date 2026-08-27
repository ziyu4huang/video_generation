# OpenViking upstream delta audit #2 — 65 commits (2026-08-22 → 2026-08-27)

Date: 2026-08-27 · Scope: the four knowledge-family extensions
(`s2-agent-ext-knowledge-card`, `s2-agent-ext-hermes-memory`,
`s2-agent-ext-obsidian`, `s2-agent-ext-file2md`) against the upstream
OpenViking delta `6e944cc3..9952ce1e` (65 commits, local clone
`~/proj/OpenViking`, fast-forwarded 2026-08-27). Successor to
`2026-08-25-openviking-naming-alignment-audit.md` (PR #2049) — that audit
fixed vocabulary; this one reads the FUNCTIONAL delta that landed after it.

Verdict up front: **one actionable PORT (the L1 overview `[N]`-index →
Markdown-link scheme, filed as an issue), four ALREADY-HAVE confirmations,
and fourteen NO-PORT/N-A rows — every one either covered by our
architecture, excluded by standing posture decisions (no-cloud, D19, D1),
or upstream-infra with no analog here.** The obsidian package is untouched
by the delta, as the naming audit predicted (§D: no upstream analog).

Standing constraints inherited from prior decisions (do not re-litigate):

- **No cloud GAI** (user hard rule): anything routing to cloud
  rerank/intent/VLM/sparse-embedder endpoints is NO-PORT by posture.
- **D19 deterministic retrieval**: no reranker stage, no intent analyzer —
  the caller passes filters (parity ticket 07).
- **D1 out-of-scope list**: multi-tenancy, VikingBot, Web Studio,
  encryption, ovpack, watch management stay out.
- **AGPL stance**: port algorithms/prompt shapes only, never copy code
  (resource-tier effort).
- **F2 KEEP-UNPORTED ×3** (multidir re-judge, 2026-08-26):
  `DIRECTORY_DOMINANCE_RATIO` / `GLOBAL_SEARCH_TOPK` / RetrieverMode stay
  out unless a redesign hypothesis appears.

## Method

`git log 6e944cc3..9952ce1e` triaged by topic; the commits whose area
intersects the four extensions were read as diffs (`git show`) and compared
against our implementation file-by-file, with the REAL vault sidecars under
`~/proj/study-news/.../vlm-out/**` used as live evidence where symptoms
were claimed. **Process note:** four parallel read-only audit subagents
were dispatched first and all four went silent for ~19 minutes (stopped);
the diff reads were then done inline in-session — the same subagent-comms
failure mode the cc-parity t02 session recorded (4th occurrence, now
affecting read-only dispatches too, not just reviewers).

## A. Verdict table

| upstream commit | area | extension(s) | verdict | detail |
|---|---|---|---|---|
| 8ab07b1e fix(semantic): Markdown links instead of [N] indices in L1 overview | L1 prompt shape | kcard | **PORT** | §B1 — the one actionable row |
| cf553ff7 fix(memory): index generated directory overviews | tier indexing | kcard | ALREADY-HAVE | §B2 |
| 42c0ee13 fix(semantic): reuse overview summary cache | tier refresh cost | kcard | N-A | §B3 |
| 234a2d9f feat(fs): create default L0 on mkdir | tier coverage | kcard | N-A | §B4 |
| acfb3965 fix(semantic): stop parent refresh at namespace roots | tier refresh walk | kcard | N-A | §B5 |
| 69dd1d65 fix(pi-extension): key recall ledger by stable entry ids | recall injection | hermes/kcard | N-A | §B6 |
| 167951ea fix(pi-extension): persist recall injections for prompt caching | recall injection | hermes/kcard | N-A | §B6 |
| 5a154317 feat(retrieval): inline matched content on demand | retrieval surface | kcard | ALREADY-HAVE | §B7 |
| 687167f1 fix(rerank): send top_n | rerank | kcard | NO-PORT | our "rerank" is the local α-blend (retrieve.ts:642); no rerank endpoint exists, cloud rerank excluded by D19 + no-cloud |
| 05365182 fix(retrieve): accept array intent planner responses | intent | kcard | NO-PORT | no intent-analyzer stage (D19) |
| 3964d868 fix(memory): preserve extracted replace fields | merge ops | kcard | ALREADY-HAVE | §B8 |
| dbdb00bb fix(memory): repair multi-block patch regression | merge ops | kcard | N-A | §B9 |
| 4ede9c49 fix(memory): preserve all patch blocks when creating a new memory | merge ops | kcard | N-A | §B9 |
| b1780a4d feat(metrics): track memory extraction operation outcomes | extraction observability | kcard | N-A | §B10 |
| a61c57bf fix(codex): preserve transcript cursors across commit and compaction | extraction cursor | kcard extract | N-A | §B11 |
| fd35c06f fix(parser): reject empty Understanding files | parser validation | file2md | N-A | cloud "Understanding" upload API — no-cloud posture; our journal-driven extract never sees empty files |
| 7ee75611 refactor(parser): unify Office parsing with AnyDoc | Office parsing | file2md | NO-PORT (watch) | §B12 |
| 41044af7 fix(embedder): sparse embedding text-only input | embedding | kcard | NO-PORT | Volcengine cloud sparse embedder internals — no cloud embedders; sparse vectors already rejected (naming audit §C) |
| 0e77cd4e feat(mcp): return media as native content blocks | tool surface | file2md | N-A | our extensions are s2-agent extension tools returning text digests, not an MCP server surfacing media |
| 4369e28d fix(memory): expose reasons for skipped empty-URI operations | observability | hermes | ALREADY-HAVE | extract receipts already carry per-decision `reason` + per-write `outcome` (extract.ts:623, decisions[].reason) |
| a83b8171 feat(uri)!: viking://~ replaces uid-less shorthand | multi-tenant URI | — | NO-PORT | no protocol layer; tree-relative URIs kept (naming audit §B) |
| 2cc7ec47 refactor(agent-plugins): split optional MCP tools into skill dir | plugin infra | — | NO-PORT | upstream plugin infra, not our extension model |

## B. Per-commit findings

### B1. 8ab07b1e — L1 `[N]` indices → Markdown links (PORT)

Upstream found that feeding the model bare `[N]` file indices and
post-processing them away produces duplicated headings
(`### filename filename`) because the model copies the filename next to the
index. Their fix: feed each entry a collision-free link placeholder
(`(link: viking://input_sample_fN)`), instruct the model to emit standard
Markdown links `[display title](placeholder)`, and resolve placeholders to
real URIs in post-processing.

**We have the unfixed half of this**: our L1 prompt
(`resource-tiers.ts:174` "Files are numbered as [1], [2], [3] etc." and
`:188` "see [2]") uses the index-reference scheme AND we have no
`_replace_index_references`-style post-processing at all — the `[N]`
references survive verbatim into the written sidecar. Measured on the real
vault (`~/proj/study-news/.../vlm-out/usb4-specification-2.0-november-2025-clean/`):

- `pages/.overview.md` carries `see [1]` … `see [13]` — dangling indices a
  reader can only resolve by re-counting the generation-time source list,
  which is not in the file.
- The duplicated-heading symptom has not been observed in our sidecars
  (bonsai-27b did not copy filenames next to indices here), but the
  dangling-index symptom is strictly worse than upstream's: our references
  resolve to NOTHING.

**Port shape (algorithm level, no code copy)**: feed each sampled entry a
compact placeholder and ask for Markdown links `[title](placeholder)`;
resolve placeholders to tree-relative targets (we have no URI layer —
relative paths like `pages/generic-page-013.md` are the natural target, and
they are clickable in Obsidian); keep the collision-free-placeholder
discipline (bare `[N]` collides with model-emitted bracketed numbers).
Rollout note: changing the prompt changes L1 output → children fingerprint
of the PARENT does not change (prompt is not in the fp), so existing
sidecars stay stale until a forced refresh — the fix should salt the tier
fingerprint (INDEX_SCHEMA_VERSION precedent from ticket 09's
`SLUG_BETA`-style bumps) or require `--force` for regeneration, and the
usb4 tree re-ingest is the acceptance receipt.

Filed as: GitHub issue #2090.

### B2. cf553ff7 — index generated directory overviews (ALREADY-HAVE)

Upstream's MEMORY updater wrote directory overview files but never
vectorized them — the row was invisible to retrieval. Our tier pass inserts
level-0/1 rows into the `resource` table as part of the same ingest
(resource-tier t02 receipt: 844 rows = 840 L2 + 2 L0 + 2 L1). The bug class
(write-without-index) cannot occur — sidecar write and row insert are the
same code path.

### B3. 42c0ee13 — reuse overview summary cache (N-A)

Upstream re-parses a directory's EXISTING generated overview to recover
per-file summaries on refresh; linked H3 headings made the parser miss, so
summaries were recomputed (wasted LLM calls). Our refresh derives file
abstracts deterministically — `firstSentenceSummary(readFileSync(f.abs))`
(resource-tiers.ts:523-528) and child L0s from the `l0ByDir` sidecar map —
no LLM in the summary-source path, no overview re-parse, no cache to miss.
The entire cost class is absent by architecture.

### B4. 234a2d9f — default L0 on mkdir (N-A)

Upstream's fs-service creates a default L0 abstract when a directory is
born, so tier coverage is complete from creation. We have no fs-service
hook layer; tiers generate at `resource-ingest` time and a new dir flips
its parent's children fingerprint, refreshing on the next ingest. D9's
CLI-only posture makes a live fs hook out of scope.

### B5. acfb3965 — stop parent refresh at namespace roots (N-A)

Their parent-bubbling walk needed a guard against refreshing above
`viking://user` / `viking://agent` namespace roots. Our tier walk is
single-tree by construction (per-tree fingerprint, tree root is the
ceiling); there is no layer above the root to guard.

### B6. 69dd1d65 + 167951ea — recall-injection ledger (N-A, design note)

The interesting pair for us, because it lives in upstream's
`examples/pi-coding-agent-extension/` — the same pi extension API our
extensions run on. Mechanism: pi's `context` hook hands extensions a deep
copy of session messages; per-turn injected `<openviking-context>` blocks
never persist, so provider strict-prefix prompt caches (DeepSeek-style) miss
from the first injected message onward. Their fix: a per-session,
atomically-persisted ledger records which block went into which user
message (keyed by stable entry ids so compaction/branching cannot misalign)
and re-applies them every request.

**Why N-A**: hermes injects at the SYSTEM-prompt level, assembled once at
`session_start` (`buildPromptContext`, prompt-context.ts:27-45) —
byte-stable for the session's life, so the prefix-cache-miss class cannot
occur; default `memoryMode: "policy-only"` injects constant policy text at
all. kcard recall is MODEL-PULLED (zk tools the model calls), which is even
cache-friendlier. **Design note for the future**: if a CC-style per-turn
recall-injection ever lands in this repo, upstream's ledger + stable-entry-id
keying is the reference pattern — cite this row.

### B7. 5a154317 — inline matched content on demand (ALREADY-HAVE)

Upstream added a `read_content` request flag so search results inline the
matched content, saving a second read round-trip. Our `resource-query`
already does this: `--tier 2 --root <path>` lazily loads and attaches L2
bodies to hits (`tier2Body`, `s2-agent/src/cli/commands/resource-query.ts`
hit-mapping block). The card lane returns digests by design (tier ladder)
with `zk_fs` read as the deliberate second step.

### B8. 3964d868 — preserve extracted replace fields (ALREADY-HAVE)

Upstream's extract loop froze every non-PATCH field on update (dropping
extracted REPLACE/SUM values); the fix narrows the frozen set to IMMUTABLE.
Our `mergeField` (card-format.ts:216-244) applies each op by name —
replace/sum/union/immutable each honored individually — the buggy binary
never existed here.

### B9. dbdb00bb + 4ede9c49 — multi-block patch preservation (N-A)

Both fix `PatchOp` silently dropping all but one search/replace block when
creating a memory with no original. Our merge table
(`MERGE_OPS`, card-format.ts:198) has no patch op at all — card updates are
whole-body LLM refinements plus per-field merges. The failure class has no
host here.

### B10. b1780a4d — extraction outcome metrics (N-A)

Prometheus-style counters (created/merged/deleted/skipped/failed) through
their telemetry bridge. We have no metrics registry by posture
(single-user local CLI); the same information is derivable from the per-run
extract receipts (`output/kcard-extract/run-<ts>.json`: `writes[].outcome`,
`decisions[].reason`, `llmFailed`, `candidates`). Not worth inventing a
telemetry layer for.

### B11. a61c57bf — transcript cursors across commit/compaction (N-A)

Their codex transcript compaction reorders/drops entries, breaking an
id-cursor. Our extract cursor (`.extract-state.json` id-cursor, extract.ts)
reads the hermes §-markdown journal, which is append-only per session —
nothing rewrites history under the cursor. (Agent-transcript compaction
elsewhere in the repo does not touch the journal files.)

### B12. 7ee75611 — AnyDoc unified Office parsing (NO-PORT, watch item)

Upstream replaced its bespoke docx/xlsx/pptx parsers (−2509 lines) with the
`firecrawl-anydoc` pip dependency, serializing to GFM with embedded-image
preservation. We ALREADY cover docx/xlsx/pptx/ipynb via vendored
`dsh-cowork-core` bounded windows (file2md pipeline.ts:11,593-600).
Swapping to a Python pip dependency would break file2md's Bun-native +
offline posture. **Watch**: if anydoc gains fidelity our parsers lack
(e.g. embedded-image extraction fidelity), re-evaluate — and check its
license first (AGPL contamination rules apply to code, not algorithms).

## C. Actionable PORT rows

Exactly one:

1. **L1 overview Markdown links** (§B1) — filed as GitHub issue #2090. First step: swap the
   `resource-tiers.ts` prompt lines 174/188 to placeholder + Markdown-link
   instructions, add placeholder→relative-path resolution post-processing,
   salt the tier fingerprint so existing sidecars refresh, re-ingest the
   usb4 tree as the acceptance receipt.

Everything else is covered, excluded by standing decisions, or
architecture-inapplicable. No new efforts, no re-opens of F2.
