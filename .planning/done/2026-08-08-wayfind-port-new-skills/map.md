---
effort: 2026-08-08-wayfind-port-new-skills
created: 2026-08-08
last: 2026-08-09
status: Done (Batch 1 #1138, Batch 2 #1176)
---

# Wayfinder map: 2026-08-08-wayfind-port-new-skills

## Destination

Port Matt Pocock's upstream harness-agnostic skills (from `/Users/huangziyu/proj/pi-ext-matt-skills`) into pi-native wayfind with light pi-adaptation. Skills are ported in batches; the effort remains active for future batches.

## Notes

**Batch 1 complete — merged via PR #1138.**
Ported: `prototype`, `resolving-merge-conflicts`, `to-questionnaire`, `wizard`, `handoff`.

**Batch 2 complete (2026-08-09) — 3 skills ported.**
Ported from mattpocock/skills @ `84fdeff` (tickets 01–03, all closed):
- **diagnosing-bugs** (engineering) — 6-phase discipline for building a tight, red-capable reproduction loop for hard/flaky bugs.
- **research** (engineering) — investigate a question against primary sources, capture findings as Markdown, delegate reading to a background subagent.
- **wait-what** (productivity) — re-pitch a message that didn't land, using Simplified Technical English with ubiquitous language.

**Port discipline:** Adopt upstream intent; strip Claude-Code-isms (the `Skill` tool, `TodoWrite`, CC `Task` subagent semantics, CC-only fs conventions); remap file outputs to pi conventions (`.planning/<effort>/`); match existing ported skills' front-matter ("Use when…" trigger phrasing, required by skills.test.ts) + structure; route to superpowers skills where Matt's overlap (his `/implement`,`/tdd` → superpowers `executing-plans`,`test-driven-development`; `diagnosing-bugs` disambiguated against superpowers `systematic-debugging`); skills auto-discover from the extension's `skills/` dir (registered via `pi-agent/run-dir/manifest.json`).

**Out of scope (carried forward):** wayfinder (port already has a pi-native one); the MAYBEs and SKIPs from the triage.

**Verification:** `( cd bun-apps/pi-agent-ext-wayfind && bunx tsc --noEmit && bun test )` — typecheck + the skills suite (frontmatter / "Use when" / H1 guards) must stay green.

**Provenance:** Batch 1: PR #1138. Batch 2: mattpocock/skills @ `84fdeff` (2026-08-09). See `bun-apps/pi-agent-ext-wayfind/README.md` → Source & license.

## Scope (3 tickets)

- [01 — Port diagnosing-bugs](tickets/01-port-diagnosing-bugs.md)
- [02 — Port research](tickets/02-port-research.md)
- [03 — Port wait-what](tickets/03-port-wait-what.md)

## Decisions so far

<!-- the index — one line per closed ticket: gist + link -->

- [01 — diagnosing-bugs ported](tickets/01-port-diagnosing-bugs.md) — 6-phase debugging discipline, disambiguated from superpowers `systematic-debugging`; frontmatter "Use when..." + structure match ported skills pattern.
- [02 — research ported](tickets/02-port-research.md) — primary-source investigation with background subagent delegation; outputs to `.planning/<effort>/` per pi conventions.
- [03 — wait-what ported](tickets/03-port-wait-what.md) — message re-pitching in Simplified Technical English; stripped CC-isms, matched pi-native skill frontmatter.

## Out of scope

wayfinder (pi-native port already exists); the MAYBEs and SKIPs from the original triage.

## Fog

<!-- none -->

