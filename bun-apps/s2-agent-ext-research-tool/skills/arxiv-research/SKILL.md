---
name: arxiv-research
description: arXiv paper research chain — arxiv_search to find papers, arxiv_paper for exact metadata, arxiv_fetch2md to save a paper's full body as Markdown into <vault>/papers/. No API key. Use for finding papers, related work surveys, category browsing, or fetching a paper to read/cite.
---

# arXiv Research

## When to Use
Paper work: find papers on a topic (`arxiv_search`), resolve a specific ID/URL
to metadata + abstract (`arxiv_paper`), or pull a paper's full body as
Markdown for reading/citing (`arxiv_fetch2md` → `<vault>/papers/`). Keyless —
no credentials, no proxy.

## Prerequisites
- None. arXiv's API and the arxiv2md.org pipeline are keyless. Calls
  self-throttle to one request per 3s (polite-use; already built in — never
  parallelize around it).

## Procedure
1. **Search** — `arxiv_search { query, category?, max_results?, sort_by? }`.
   - `category` filters to an arXiv category (cs.LG, cs.CV, cs.RO, stat.ML…);
   - `sort_by: "submittedDate"` for "recent papers on X";
   - skim the returned id/title/authors/abstract rows before fetching anything.
2. **Pin the paper** — `arxiv_paper { id }` for the canonical metadata of the
   ONE paper that matters (accepts `1706.03762`, a versioned id, or an abs URL).
3. **Fetch the body** — `arxiv_fetch2md { id | url }` → Markdown (sections +
   math preserved) saved to `<vault>/papers/<slug>.md`.
   - `save: false` returns the Markdown WITHOUT writing (preview / quote into
     an answer);
   - `output_path` overrides the destination.
4. **Chain etiquette** — a survey is search (broad) → paper (narrow) → fetch
   (only what the user will actually read). Fetching every search hit wastes
   the 3s/request budget; `max_results: 3–5` first, widen only if nothing fits.

## Pitfalls
- **Version drift**: prefer the bare id (`2401.12345`) over a pinned version
  (`v2`) unless the user cited the version — lookup resolves latest.
- **Category ≠ query**: `category: cs.LG` with an empty-ish query browses;
  a precise query with no category finds across categories. Don't stack both
  narrow filters first try.
- **arxiv2md is a third-party pipeline** — on rare outage `arxiv_fetch2md`
  fails loudly; retry once, then fall back to quoting the abstract from
  `arxiv_paper` and link the abs page.
- Papers land in the ACTIVE vault's `papers/` — set `OB_VAULT_PATH` or pass
  `output_path` when the session cwd is not the vault project.

## Verification
- `arxiv_search` returns papers with id + title + authors for the query;
- fetched file exists under `<vault>/papers/` with real section headings
  (not just the abstract) — spot-check the math in one section.
