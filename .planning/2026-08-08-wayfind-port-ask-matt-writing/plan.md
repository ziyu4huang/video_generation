# Wayfind — port ask-matt + writing-for-agents — 2026-08-08

## Context
MAYBEs deep-dive selected 2 upstream skills to port: ask-matt (the missing router/index for the wayfind family) and writing-for-agents (writing-craft reference, orthogonal to writing-skills). Order: writing-for-agents first (resolves ask-matt's forward reference), then ask-matt.

## Tasks
- **writing-for-agents** (productivity/writing-for-agents) — SKILL.md + sibling SKILL-MECHANICS.md. Craft reference: context pointers, two-loads theory, info hierarchy, progressive disclosure, leading words, pruning. Adaptation: drop CLAUDE.md refs (keep AGENTS.md); remap skill-mechanics terms to pi's skill-loading model (pi loads SKILL.md by path; "model-reachable" ≈ present in available_skills).
- **ask-matt** (engineering/ask-matt) — SKILL.md + sibling PHASE-BOUNDARIES.md. The router/map over the wayfind skill family. Adaptation: strip CC-isms; rebuild the skill index to reflect the port's ACTUAL 16 skills; remap slash-commands to skill names; drop /setup-matt-pocock-skills precondition; for unported upstream skills, OMIT from active routing (optionally note "not ported").

## Out of scope
research / wait-what / setup-pre-commit / loop-me (SKIP); teach / triage (second batch — referenced by upstream ask-matt but not ported here).

## Verification
`( cd bun-apps/pi-agent-ext-wayfind && bun test )` + `bun run build`.
