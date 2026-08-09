---
id: "02"
title: Port research from mattpocock/skills
status: closed
type: port
resolved: 2026-08-09
---

# 02 — Port research

## Port

Source: `/Users/huangziyu/proj/pi-ext-matt-skills/skills/engineering/research/SKILL.md` at upstream commit `84fdeff` (no companion beyond an `agents/openai.yaml`, which is not pi-relevant).

Port into `bun-apps/pi-agent-ext-wayfind/skills/research/` with the pi-port treatment:

- **Frontmatter**: rewrite `description` as a pi "Use when…" trigger.
- **Surface adaptation**: "background agent" → pi **subagent** dispatch (`subagents`/`subagent`), pointing at the `subagent-dispatch-discipline` skill for scoping; output path → `.planning/<effort>/` convention ("save where the repo already keeps such notes; if none, `.planning/<effort>/` and say where").
- **Collision check**: no collision — `pi-agent-ext-research-tool` is a video/arXiv *tools* extension (different purpose); `research-pi-packages` is a narrow pi-packages skill; superpowers has no primary-source-research skill. Genuine gap.
- **Routing**: the "if the question is a decision" line routes into `grill-me-with-docs` (wayfind), keeping the decide/execute boundary clean.

## Resolution (2026-08-09)

Ported from mattpocock/skills @ `84fdeff` → `skills/research/SKILL.md`. pi-adaptations: "Use when" trigger frontmatter; "background agent" → pi **subagent** dispatch pointing at `subagent-dispatch-discipline`; output path → `.planning/<effort>/` convention; decision-vs-fact routing into `grill-me-with-docs`. No collision (`pi-agent-ext-research-tool` is a tools extension; `research-pi-packages` is narrow; superpowers has no primary-source-research skill). Wired into `ask-matt` (Standalone). `bunx tsc --noEmit` exit 0; `bun test` green.
