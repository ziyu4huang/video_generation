---
name: extension-naming
description: Use when naming a tool, extension, package, or skill in any s2-agent-ext-* package — or renaming one (rename checklist + append-only rename history; renames are behavior changes requiring the PR #1738 legacy-name pattern). Single source of truth for naming style per surface (kebab-case skills, snake_case verb_object tools, <tool>_help companions).
---

# Extension / Tool / Skill Naming — Convention + Name History

Single source of truth for naming style across every `s2-agent-ext-*` package,
plus the rename history downstream consumers (wayfinder transcript matching,
tool-gate keyword families, docs, CLAUDE.md, CI baselines) must track.

**How to inspect the live extension surface** (the "way to inspect extensions"):

1. `inspect_extensions` tool — registered by `s2-agent-ext-power-tool`
   (`bun-apps/s2-agent-ext-power-tool/src/tools/inspect-extensions.ts`); in a
   live session this enumerates registered extensions + their tools/skills.
2. Registration sources:
   - dynamic → `bun-apps/s2-agent/src/run-dir/manifest.json` (`extensions[]`)
   - static → `bun-apps/s2-agent/src/static-extensions.ts` (generated from the
     manifest's `staticExtensions[]` — manifest is the only edit point)
3. Gating-net enumeration (test support): `bun-apps/s2-agent-ext-tool-gate/
   extensions/migrated-extensions.ts` (`MIGRATED_EXTENSIONS`).

## Canonical convention (per surface)

| Surface | Style | Example | Status |
|---|---|---|---|
| Extension (package + registration) | `kebab-case` | `s2-agent-ext-research_tool` | ✅ consistent (all 23 pkgs) |
| Skill (dir + `SKILL.md` name) | `kebab-case` | `devops-workflow` | ✅ consistent |
| CLI subcommand | `kebab-case` | `collect-videos` | ✅ consistent |
| Agent tool | `snake_case`, `verb_object` (optionally `ns_verb`) | `sync_default_branch`, `obsidian_read` | ⚠️ see outliers |
| Help companion tool | `<tool>_help` | `workflow_help` | ✅ consistent |
| zai-mcp dynamic tools | **external** (from each MCP server's `listTools()`) | `webReader` | ℹ️ not ours to rename |

Tool-name outliers still on the wire (bare nouns / non-verb forms, all
pre-convention): `memory`, `browser`, `webui`, `file2md`, `flux2`,
`krea2`, `ltx`, `movie`, `obsidian`, `zk` namespace tools. Renaming any of
these is a **behavior change** — it requires the PR #1738 pattern (legacy name
kept where transcript matching reads it + caller sweep) and a new row in the
history table below. Do not rename casually.

## Current tool inventory (2026-08-20)

| Package | Tools |
|---|---|
| devops | `deploy_pi_agent_sh`, `verify_pi_agent_deploy`, `show_pr_status`, `merge_pr_after_local_ci`, `sweep_merged_branches`, `sync_default_branch`, `prepare_feature_branch`, `verify_merge_landed`, `check_main_health`, `run_local_ci`, `run_devops_retrospect` |
| obsidian | `obsidian` (fat tool), `obsidian_help`, `obsidian_list/read/create/append/append_section/search/search_help/semantic_search/move/rename/query/update_frontmatter/delete/invalidate/open/distill/garden/status` |
| knowledge-card | `zk_card`, `zk_ask`, `zk_ingest`, `knowledge_query` (internal ns `zk`: retrieve/ingest/health/heal) |
| hermes-memory | `memory`, `search_memory`, `skill_manage`, `skill_manage_help`, `knowledge_search`, `knowledge_ingest` |
| task | `ask_user_question`, `goal_complete` |
| workflow | `run_workflow`, `workflow_help`, `workflow_control`, `wf_web_search`, `wf_web_fetch` (child-session-only tools — never registered on the parent session) |
| subagent | `spawn_subagent`, `list_subagents`, `list_subagent_runs` (ungated by design), `task_create/get/list/update` (core-gated — the ONE task family since cc-parity t02; `todo` retired) |
| web-access | `web_search`, `fetch_content`, `get_search_content` |
| webui | `webui_present`, `webui_report` |
| power-tool | `inspect_extensions`, `inspect_tui`, `inspect_agent`, `inspect_hooks`, `browser`, `webui` |
| wayfind | `wayfind_effort` |
| file2md | `file2md`, `vision_ask` |
| research-tool | `collect_videos`, `organize_vault_notes`, `import_memory_to_vault`, `arxiv_search`, `arxiv_paper`, `arxiv_fetch2md` |
| flux2 / krea2 / ltx / movie-director | `<ns>`, `<ns>_help` (`flux2`, `krea2`, `ltx`, `movie`) |
| zai-mcp | dynamic per MCP server (e.g. `web_search_prime`, `webReader`) |

## Rename history (append-only — every rename MUST add a row)

| Date | PR | Old → New | Notes |
|---|---|---|---|
| 2026-08-20 | (this branch) | `search` → `search_memory` | hermes-memory; core-gated (no keyword gate); transcript detectors updated |
| 2026-08-20 | (this branch) | `subagent` → `spawn_subagent` | subagent pkg; workflow-family gate (`gating:{gate:"workflow"}`) unchanged; hermes message-parts + /subagents viewer accept BOTH names for historical transcripts |
| 2026-08-20 | (this branch) | `subagents` → `list_subagents` | subagent pkg; workflow-family gate |
| 2026-08-20 | (this branch) | `subagent_runs` → `list_subagent_runs` | subagent pkg; ungated-by-design — tool-gate `ungatedByDesign` + typo guard updated |
| 2026-08-20 | (this branch) | `workflow` → `run_workflow` | workflow pkg; canonical workflow-family gate id (GATES[].names[0]) is now `run_workflow` — qa probes + `__GATE_PROBES__` keyed to it; GATE_DEFS family id stays `workflow` |
| 2026-08-20 | (this branch) | `web_search` → `wf_web_search` | workflow pkg CHILD-SESSION tool (never parent-registered); collided with web-access's parent `web_search` — workflow children compose `[...baseTools, ...extensionTools]` and AgentSession's name-keyed Map let the LAST entry win, silently shadowing this one. `wf_` namespace kills the collision; web-access keeps the bare name |
| 2026-08-20 | (this branch) | `web_fetch` → `wf_web_fetch` | renamed alongside `wf_web_search` for symmetry (no collision — web-access's fetchers are `fetch_content`/`get_search_content`) |
| 2026-08-20 | #1738 | `pi_deploy` → `deploy_pi_agent_sh` | legacy kept as gate keyword |
| 2026-08-20 | #1738 | `pi_verify` → `verify_pi_agent_deploy` | legacy kept as gate keyword |
| 2026-08-20 | #1738 | `pr_status` → `show_pr_status` | legacy kept as gate keyword |
| 2026-08-20 | #1738 | `await_pr_merge` → `merge_pr_after_local_ci` | legacy kept as gate keyword; CLI `merge-pr-after-ci-cli`, bin `devops-merge-pr-after-ci` |
| 2026-08-20 | #1738 | `sweep_branches` → `sweep_merged_branches` | legacy kept as gate keyword; bin `devops-sweep-merged-branches` |
| 2026-08-20 | #1738 | `sync_repo` → `sync_default_branch` | legacy kept as gate keyword; CLI `sync-default-branch-cli`, bin `devops-sync-default-branch` |
| 2026-08-20 | #1738 | `prepare_branch` → `prepare_feature_branch` | legacy kept as gate keyword; CLI `prepare-feature-branch-cli`, bin `devops-prepare-feature-branch` |
| 2026-08-20 | #1738 | `verify_merge` → `verify_merge_landed` | legacy kept as gate keyword |
| 2026-08-20 | #1738 | `main_health` → `check_main_health` | legacy kept as gate keyword |
| 2026-08-20 | #1738 | `local_ci` → `run_local_ci` | legacy kept as gate keyword |
| 2026-08-20 | #1738 | `devops_retrospect` → `run_devops_retrospect` | legacy kept as gate keyword |
| 2026-08-22 | (this branch) | pkg `s2-agent-ext-workflow` → `s2-agent-ext-ultracode` (entry file `extensions/workflow.ts` → `extensions/ultracode.ts`) | PACKAGE rename — aligns with Claude Code's "ultracode" arming keyword. Tool names (`run_workflow` etc.), registry label `name: workflow`, `/workflows*` commands, and gate family id `workflow` unchanged (Claude Code's tool is also named Workflow). `ultracode` added as a second default keyword trigger (`DEFAULT_KEYWORD_TRIGGER_WORDS`) |
| 2026-08-29 | (docs migration) | `docs/agents/*.md` → `s2-agent-ext-devops/skills/<name>/SKILL.md` | DOC migration (not a tool rename): the six agent-facing operational docs became skills (`domain-docs`, `extension-naming`, `issue-tracker`, `learnings`, `session-closeout-sop`, `shared-state-index`); all in-repo references swept in the same PR |

### Rename checklist (from the #1738 experience)

1. Rename tool def + every in-repo caller (grep old name; includes root
   `CLAUDE.md`, SKILL.md bodies, `scripts/gh-workflow.sh`, CI docs,
   `schema-cost-baseline.json`).
2. Keep the legacy name as the gate family's FIRST keyword (wayfinder keeps
   matching historical transcripts that reference old names).
3. Rename CLI file + bin; **hand-align `bun-apps/bun.lock`** — bun 1.3.14 does
   not refresh the workspace bin section on rename.
4. Append a row to the history table above.
