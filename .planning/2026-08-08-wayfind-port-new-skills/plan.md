# Wayfind — port 5 new upstream skills — 2026-08-08

> **Status:** done — merged via PR #1138 (skills `prototype`, `resolving-merge-conflicts`, `to-questionnaire`, `wizard`, `handoff` shipped to origin/main).

## Context
Triage of Matt Pocock's upstream skills (/Users/huangziyu/proj/pi-ext-matt-skills) found 5 clean, harness-agnostic, zero-overlap skills absent from the pi-native wayfind port. This effort ports them with light pi-adaptation.

## Tasks
- **prototype** — throwaway code answering a design question (upstream: engineering/prototype)
- **resolving-merge-conflicts** — 5-step git conflict resolution (engineering/resolving-merge-conflicts)
- **to-questionnaire** — decision → async questionnaire markdown (productivity/to-questionnaire)
- **wizard** — generate an interactive bash wizard for human-only steps (engineering/wizard)
- **handoff** — compact conversation → handoff doc for the next agent (productivity/handoff)

## Port discipline
Adopt upstream intent; strip Claude-Code-isms (the `Skill` tool, `TodoWrite`, CC `Task` subagent semantics, CC-only fs conventions); remap file outputs to pi conventions (`.planning/<effort>/`); match existing ported skills' front-matter + structure (templates: to-tickets, domain-modeling); register per the extension's skill-loading convention.

## Out of scope
wayfinder (port already has a pi-native one); teach + triage (second batch); the 6 MAYBEs and 10 SKIPs from the triage.

## Verification
`( cd bun-apps/pi-agent-ext-wayfind && bun test )` + `bun run build` (tsc).
