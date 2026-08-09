# Wayfind — port new upstream skills — 2026-08-08

> **Status:** Batch 2 complete (3 skills ported); effort remains active for future batches. Batch 1 complete — merged via PR #1138. Batch 2 complete — `diagnosing-bugs`, `research`, `wait-what` ported; tickets 01–03 closed.
> **Last:** 2026-08-09

## Context

Triage of Matt Pocock's upstream skills (/Users/huangziyu/proj/pi-ext-matt-skills) found clean, harness-agnostic skills absent from the pi-native wayfind port. This effort ports them in batches with light pi-adaptation.

## Batch 1 — shipped (PR #1138)

`prototype`, `resolving-merge-conflicts`, `to-questionnaire`, `wizard`, `handoff` shipped to origin/main.

- **prototype** — throwaway code answering a design question (upstream: engineering/prototype)
- **resolving-merge-conflicts** — 5-step git conflict resolution (engineering/resolving-merge-conflicts)
- **to-questionnaire** — decision → async questionnaire markdown (productivity/to-questionnaire)
- **wizard** — generate an interactive bash wizard for human-only steps (engineering/wizard)
- **handoff** — compact conversation → handoff doc for the next agent (productivity/handoff)

## Batch 2 — done (2026-08-09)

Ported 3 stable, genuinely-useful skills from mattpocock/skills @ `84fdeff` (tickets 01–03, all closed):

- **diagnosing-bugs** (engineering) — 6-phase discipline whose core is building a tight, red-capable reproduction loop for hard/flaky bugs. Ticket 01.
- **research** (engineering) — investigate a question against primary sources, capture findings as Markdown, delegate reading to a background subagent. Ticket 02.
- **wait-what** (productivity) — a message didn't land; stop and re-pitch it in Simplified Technical English using ubiquitous language. Ticket 03.

## Port discipline

Adopt upstream intent; strip Claude-Code-isms (the `Skill` tool, `TodoWrite`, CC `Task` subagent semantics, CC-only fs conventions); remap file outputs to pi conventions (`.planning/<effort>/`); match existing ported skills' front-matter ("Use when…" trigger phrasing, required by skills.test.ts) + structure (templates: to-tickets, domain-modeling); route to superpowers skills where Matt's overlap (his `/implement`,`/tdd` → superpowers `executing-plans`,`test-driven-development`; here `diagnosing-bugs` is disambiguated against superpowers `systematic-debugging`); skills auto-discover from the extension's `skills/` dir (registered via `pi-agent/run-dir/manifest.json` `skills[]`/`binarySkills[]` pointing at the dir — no per-skill entry).

## Out of scope (batch 1, carried forward)

wayfinder (port already has a pi-native one); the MAYBEs and SKIPs from the triage.

## Verification

`( cd bun-apps/pi-agent-ext-wayfind && bunx tsc --noEmit && bun test )` — typecheck + the skills suite (frontmatter / "Use when" / H1 guards) must stay green.

## Provenance

Batch 1: PR #1138. Batch 2: mattpocock/skills @ `84fdeff` (2026-08-09) — diagnosing-bugs, research, wait-what. See also `bun-apps/pi-agent-ext-wayfind/README.md` → Source & license.
