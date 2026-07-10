# Task Plan — Distill pi-agent PRDs into Zettelkasten notes

## Status: **UNBLOCKED** — distill floor configured

The distill fast-model floor is implemented (settings.json `obsidian.subagentModel`
= `deepseek/deepseek-v4-flash`, injected via the `subagent-model-floor` patch +
pi-agent-cli `applyObsidianSubagentFloor`). See `.planning/distill-fast-model/`.
Deploy the patch to `__pi` to activate the no-`--model` floor at runtime; until
then pass `--model deepseek/deepseek-v4-flash` per call. Power-tool PRD distilled
this session (5 cards) as the validation run.

## Goal
Distill all `bun-apps/<app>/pi-agent-*/PRD.md` files into atomic Zettelkasten
knowledge cards in the active vault (`vaults_root/pi-agent-vault/`), so each
package's purpose, tools, architecture, and dependencies become graph-linked,
queryable notes that `zk_ask` / `knowledge_query` can recall.

## Context (verified)
- **16 PRD files** found under `bun-apps/` (26–53 lines each; 564 lines total).
- **Active vault:** `pi-agent-vault` → `/Users/huangziyu/proj/pi-agent-vault` (645 notes).
- **Vault layout:** `Zettelkasten/distill/` (10 LLM-distilled notes), `Zettelkasten/knowledge-graph/` (499 deterministic cards), `Tags/Index.md` + `Tags/Knowledge Graph.md` MOCs.
- **No prior PRD distillation exists** (dedup check clean).
- **Correct tool:** `zk_extract` (= `obsidian_distill` via subagent) — PRDs are free-form prose, so the *LLM decomposition* path applies (NOT `zk_ingest`, which is for structured `.knowledge.jsonl` records).
- **Output language:** Traditional Chinese (zh_TW), per distill subagent contract.
- **User choice:** Grouped by domain (3 batches) → folder `Zettelkasten/distill/prd-architecture/`

## Source files (16)
```
bun-apps/pi-agent-cli/PRD.md
bun-apps/pi-agent-ext-flux2/PRD.md  ✅ DISTILLED (5 cards)
bun-apps/pi-agent-ext-hermes-memory/PRD.md
bun-apps/pi-agent-ext-knowledge-card/PRD.md
bun-apps/pi-agent-ext-krea2/PRD.md
bun-apps/pi-agent-ext-ltx/PRD.md
bun-apps/pi-agent-ext-movie-director/PRD.md
bun-apps/pi-agent-ext-obsidian/PRD.md
bun-apps/pi-agent-ext-planning-with-files/PRD.md
bun-apps/pi-agent-ext-power-tool/PRD.md
bun-apps/pi-agent-ext-research-tool/PRD.md
bun-apps/pi-agent-ext-subagents/PRD.md
bun-apps/pi-agent-ext-vlm/PRD.md
bun-apps/pi-agent-ext-web-access/PRD.md
bun-apps/pi-agent-ext-workflow/PRD.md
bun-apps/pi-agent-ext-zai-mcp/PRD.md
```

## Phases

### Phase 1 — Inventory & setup  ✅ complete
- [x] Enumerate PRD files (16).
- [x] Confirm active vault + existing distill/knowledge-graph layout.
- [x] Confirm no prior PRD distillation (no dupes).
- [x] Decide folder + granularity (domain-grouped, prd-architecture folder).

### Phase 2 — Distill PRDs → atomic Zettelkasten notes  ⏸ BLOCKED
- [ ] **Flux2**: ✅ DONE (5 cards, high quality, verified). Do NOT re-run.
- [ ] Media gen (krea2, ltx, movie-director, vlm): BLOCKED — distill timeout issue.
- [ ] Agent core/infra (cli, workflow, subagents, power-tool, planning-with-files, hermes-memory): BLOCKED.
- [ ] Knowledge/access/research (knowledge-card, obsidian, research-tool, web-access, zai-mcp): BLOCKED.

**Blocker**: Distill subagent is too slow with default model and the `model` override doesn't propagate correctly. Next goal: Configure persistent subagent model with fast model (deepseek-v4-flash). See `./output/next-goal-20260710-211013.md`.

### Phase 3 — Verify output  ⏸ blocked by Phase 2
- [ ] List created notes; confirm count + frontmatter (tags/aliases/created).
- [ ] Spot-check wiki-links resolve (no dead links) + cross-links to existing knowledge-graph cards.
- [ ] Confirm MOC (`Tags/Index.md`) updated.

### Phase 4 — Graph health audit  ⏸ blocked by Phase 2
- [ ] Run `obsidian_garden` audit (mode=audit) on the new folder; report orphans/dead links/MOC drift.
- [ ] (optional) `fix` mode if drift found.

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Distill timed out (default model zai/glm-5.2) | flux2 (1 file) | Local gemma model completed (255.8s), but too slow for batching |
| Distill timed out (local gemma, 4 files) | krea2+ltx+movie+vlm | Reduce batch size to 1 file; still timeouts |
| Distill timed out (local gemma, 1 file) | krea2 | **UNRESOLVED** — subagent model override not propagating |

**Root cause**: Missing `OB_SUBAGENT_MODEL` configuration path; `model` param in `zk_extract` doesn't reliably set subagent model. Warning: "⚠ no subagent model configured (set OB_SUBAGENT_MODEL for a stable TC-aware floor)".

## Decisions

- **Tool:** `zk_extract` (LLM distill path). PRDs = free-form prose.
- **Folder:** `Zettelkasten/distill/prd-architecture/` — grouped, queryable.
- **Granularity:** 1 PRD per call with `deepseek-v4-flash` (once configured).
- **Model:** Must use fast model (`deepseek-v4-flash`) — default `zai/glm-5.2` is too slow.
- **Configuration:** Need persistent `subagents.defaultModel` in `~/.pi/agent/settings.json` (current gap).

## Next Goal

Implement distill workflow improvement: **Configure persistent subagent model in settings.json**

See full plan in `./output/next-goal-20260710-211013.md`.