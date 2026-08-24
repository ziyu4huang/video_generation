---
type: task
blocking: 03
status: open
---

# 02 — Directory L1 overview + L0 abstract generation (bottom-up, sampled)

## Question
Does one LLM call per directory (inputs = child abstracts + child-dir L0s, bottom-up, deterministically sampled above a bound) produce L1 overviews whose extracted L0 abstracts make directory-level relevance judgments work?

## What to build
`resource-ingest` gains the semantic tier pass: after L2 rows land, directories are processed leaves→root; each gets an L1 `.overview.md` sidecar (one `chatJson` call, `overview_generation` prompt shape, JSON fast path) and an L0 `.abstract.md` extracted from L1's leading paragraph (clamp enforced, never a second call). Sidecars carry OKF-style frontmatter (`generated_by`, `freshness` counters) and are visible in Obsidian; sidecar bodies become level-0/1 `resource` rows with their own embeddings. Directories above the measured sampling bound get a deterministic sample of children in the prompt (bound + token budget measured and recorded here). Re-ingest refreshes a directory only when its `pending_child_changes` counter crosses the threshold (upstream freshness policy shape).

## What to measure in this ticket (Fog-of-war items)
- Sampling bound + prompt token budget on the flat 839-child USB4 pages/ dir; decide single-sampled-L1 vs TOC-derived chapter segmentation, record the decision + numbers in the Resolution
- file2md resumability unaffected by sidecars (manifest is page-scoped) — verify by re-running file2md smart over the sidecar'd tree

## Acceptance
- [ ] A 3-level fixture tree (mocked LLM) produces correct bottom-up order, sidecars with valid frontmatter, level 0/1 rows, and incremented freshness counters on child edit
- [ ] USB4 tree: every directory has L0+L1 rows; the root abstract is a faithful ≤2-sentence description (recorded sample in receipt); LLM call count = directory count (not file count)
- [ ] Child-edit → only the ancestor chain refreshes (fingerprint + counter evidence)
- [ ] Hermetic unit tests for L0-extraction clamp, sampling determinism, sidecar frontmatter; one live-LLM smoke on a small real dir (on-demand)
- [ ] Canonical `bun run test` green; reviewer pass (or disclosed inline fallback)
