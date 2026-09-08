# Ticket 04 — arXiv skill + the family's first LIVE receipts (T4)

Status: open · after the final redeploy (deployed leg imports shipped bytes)

## Problem

Planner F5+F6: `skills/` holds 5 skills — none covers the arXiv trio
(`arxiv_search` / `arxiv_paper` / `arxiv_fetch2md`), the family's only keyless
LIVE-capable remote tools (`lib/arxiv.ts`, 3s self-throttle). The chaining
workflow (search → paper → fetch2md → `<vault>/papers/`) exists only in tool
descriptions. And no research-tool operation has ever been receipted.

## Work

1. New `skills/arxiv-research/SKILL.md`: the chain workflow, throttle etiquette,
   `save=false` preview mode; shape follows `skills/collect-news-llm/SKILL.md`.
2. Source-leg receipt driver: import `extensions/research-tool.ts`'s factory,
   execute tools directly with a stub ctx (`{ cwd }`, `OB_VAULT_PATH` → temp
   vault) — NO LLM anywhere (the CLI twin spawns agent sessions by design;
   deliberately not used).
3. Deployed-leg receipt driver: import the deployed
   `ext/ext-standalone.mjs` per the pattern at
   `bun-apps/s2-agent-ext-devops/src/deploy-e2e-recipe.ts:1737`.
4. Respect the 3s throttle between live calls.

## Done when

`output/self-arc13-arxiv-src-<date>/receipt.json` AND
`output/self-arc13-arxiv-deployed-<date>/receipt.json` PASS named checks:
- `searchReturnsPapers` — live `arxiv_search` (query "video diffusion",
  max_results 3) → ≥1 paper with id+title
- `paperLookupKnown` — live `arxiv_paper` 1706.03762 → "Attention Is All You Need"
- `fetch2mdSavesMarkdown` — live `arxiv_fetch2md` → temp-vault `papers/*.md`,
  >2KB; if arxiv2md.org is down, RECORD the failure with response evidence and
  mark the check blocked — never delete, never fake.
