---
id: "01"
title: Port diagnosing-bugs from mattpocock/skills
status: closed
type: port
resolved: 2026-08-09
---

# 01 — Port diagnosing-bugs

## Port

Source: `/Users/huangziyu/proj/pi-ext-matt-skills/skills/engineering/diagnosing-bugs/SKILL.md` (+ `scripts/hitl-loop.template.sh`) at upstream commit `84fdeff`.

Port into `bun-apps/pi-agent-ext-wayfind/skills/diagnosing-bugs/` with the pi-port treatment:

- **Frontmatter**: rewrite `description` as a pi "Use when…" trigger (skills.test.ts requires the "Use when" prefix), keep it model-reachable (no `disable-model-invocation`) so it auto-fires on "diagnose"/"debug".
- **Routing**: add a disambiguation note vs superpowers' `systematic-debugging` (process-discipline vs loop-engineering) — same pattern as Matt's `/implement`,`/tdd` routing to `executing-plans`,`test-driven-development`. `/improve-codebase-architecture` → the existing wayfind `improve-codebase-architecture` skill.
- **Companion**: copy `scripts/hitl-loop.template.sh` (the only non-`agents/openai.yaml` companion; the OpenAI agent yaml is not pi-relevant).
- **Collision decision**: overlaps in *domain* with superpowers `systematic-debugging` but is complementary (loop-engineering depth), not a duplicate — resolved by the routing note, not a defer.

## Resolution (2026-08-09)

Ported from mattpocock/skills @ `84fdeff` → `skills/diagnosing-bugs/SKILL.md` (+ `scripts/hitl-loop.template.sh`). pi-adaptations: "Use when" trigger frontmatter (model-reachable, no `disable-model-invocation`); disambiguation note vs superpowers `systematic-debugging` (loop-engineering depth, not a duplicate — resolved by routing, not a defer); `/improve-codebase-architecture` → wayfind `improve-codebase-architecture`; HITL template copied verbatim. Wired into `ask-matt` ("Something's broken" on-ramp). `bunx tsc --noEmit` exit 0; `bun test` green (skills suite validates frontmatter/H1/"Use when" for all 3 new skills).
