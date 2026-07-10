# Findings — PRD distillation research

## CRITICAL DISCOVERY: Distill workflow is broken

### Issue Summary
The `zk_extract` / `obsidian_distill` workflow times out reliably because:
1. Default model `zai/glm-5.2` is too slow for the multi-turn subagent loop
2. The `model` parameter override DOES NOT propagate to the subagent reliably
3. Warning: "⚠ no subagent model configured (set OB_SUBAGENT_MODEL for a stable TC-aware floor)" appears even when `model` is passed
4. No persistent configuration path exists for subagent model (only env var `OB_SUBAGENT_MODEL`)

### Test Results

| Attempt | Files | Model | Result | Time | Notes |
|---------|-------|-------|--------|------|-------|
| flux2 | 1 | default (zai) | Timed out | >120s | ⚠ no subagent model configured |
| flux2 | 1 | `lm-studio/google/gemma-4-26b-a4b-qat` | ✅ 1 card | 255.8s | Slow but completed |
| krea2+ltx+movie+vlm | 4 | `lm-studio/google/gemma-4-26b-a4b-qat` | Timed out | >120s | Partial notes created before abort |
| krea2 | 1 | `lm-studio/google/gemma-4-26b-a4b-qat` | Timed out | >120s | ⚠ warning persists |

**Key observation**: Even when `model` is passed, the subagent shows the "no subagent model configured" warning, indicating the model override is NOT being applied.

### Existing distill cards (flux2 PRD)
Before abandoning, 5 high-quality cards were created from flux2:
- Agent-facing CLI 應以結構化分派器取代原始 argv.md
- 單一分派器工具暴露多子命令而非每子命令一工具.md
- 多種子場景管線以VLM挑選最佳結果.md
- 擴充經run-dir manifest自動載入而非僅靠顯式-e.md
- 自動建構路徑守護與abort構成agent CLI護欄.md

Quality verified: proper frontmatter (id/created/tags/sources), 核心想法 + 證據/脈絡 + 連結 sections, and wiki-links to existing notes.

## Configuration Investigation

### Current env vars
- `OB_SUBAGENT_MODEL` — exists but not set; referenced in `bun-apps/pi-agent/docs/pi-cross-machine-setup.md`
- No `settings.json` field for subagent model

### settings.json structure
```json
{
  "defaultProvider": "zai",
  "defaultModel": "glm-4.7",
  "subagents": {
    "agentOverrides": {
      "scout": { "model": "openai-codex/gpt-5.3-codex-spark" }
    },
    "watchdog": {
      "main": { "enabled": true },
      "enabled": true
    }
  }
}
```

**Missing**: `subagents.defaultModel` field for persistent subagent configuration.

## Recommended Fix

See full implementation plan in `./output/next-goal-20260710-211013.md`:

1. Add `subagents.defaultModel` to `~/.pi/agent/settings.json`
2. Set it to `deepseek/deepseek-v4-flash` (fast for distill)
3. Fix model propagation in `runSubagentWithRetry` from pi-obsidian
4. Add tool-specific default models in `zk_*` tools
5. Update documentation in `pi-cross-machine-setup.md`

## Vault & tooling facts (unchanged)
- Active vault resolved via **app registration**: `/Users/huangziyu/proj/pi-agent-vault` (645 notes)
- Two distill surfaces exist: `zk_extract` ≡ `obsidian_distill` (same subagent, zh_TW output)
- `zk_ingest` is the WRONG tool here (deterministic, takes structured .knowledge.jsonl)
- Knowledge architecture: working memory → durable vault (convergence sink) → recall
- Distill output lives in `Zettelkasten/distill/` (LLM-decomposed), separate from `knowledge-graph/` (499 deterministic cards)

## PRD content shape (unchanged)
- Each PRD: `## Problem` → `## Solution` → `## Tools` table → `## Commands`/`## Key Dependencies` → `## Use`
- Short (26–53 lines). Total 564 lines across 16 files.
- Natural domain groupings for future batch processing.

## Conclusion
PRD distillation is BLOCKED until distill workflow is improved with fast model configuration. Pivot to implementing the fix per `./output/next-goal-20260710-211013.md`.