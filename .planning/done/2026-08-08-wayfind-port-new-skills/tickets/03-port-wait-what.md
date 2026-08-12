---
id: "03"
title: Port wait-what from mattpocock/skills
status: closed
type: port
resolved: 2026-08-09
---

# 03 — Port wait-what

## Port

Source: `/Users/huangziyu/proj/pi-ext-matt-skills/skills/productivity/wait-what/SKILL.md` at upstream commit `84fdeff` (no companion beyond an `agents/openai.yaml`, which is not pi-relevant).

Port into `bun-apps/pi-agent-ext-wayfind/skills/wait-what/` with the pi-port treatment:

- **Frontmatter**: rewrite `description` as a pi "Use when…" trigger; keep `disable-model-invocation: true` (upstream has it — it's an explicit conversational repair, not an auto-fire).
- **Substance**: preserve the "stop, re-pitch in ASD-STE100 Simplified Technical English using ubiquitous language" core. `CONTEXT.md` ubiquitous language is already pi-native (the whole wayfind suite speaks it), so the reference stays.
- **Collision check**: none — no existing wayfind or superpowers skill is a "re-pitch / I-lost-the-thread" conversational repair.

## Resolution (2026-08-09)

Ported from mattpocock/skills @ `84fdeff` → `skills/wait-what/SKILL.md`. pi-adaptations: "Use when" trigger frontmatter; kept `disable-model-invocation: true` (explicit conversational repair, not auto-fire); preserved the ASD-STE100 Simplified Technical English + ubiquitous-language core (the `CONTEXT.md` reference is already pi-native). No collision. Wired into `ask-matt` (Standalone). `bunx tsc --noEmit` exit 0; `bun test` green.
