---
effort: 2026-08-08-improve-codebase-architecture
created: 2026-08-08
last: 2026-08-08
status: active
---

# Wayfinder map: 2026-08-08-improve-codebase-architecture

## Destination

Ship `improve-codebase-architecture` as a wayfind skill (code-quality-roadmap deliverable C): a **command-style** skill that scans this codebase for **deepening opportunities** (YAGNI hot-spot-scoped), presents them as a **Markdown+Mermaid report under `.planning/`** (with a deterministic **offline** HTML converter — vendored Tailwind+Mermaid, no CDN), and **grills** through the candidate the user picks — composing with the shipped `codebase-design` (deliverable A), `grilling`, and `domain-modeling` skills. Adapted from Matt-Pocock's source skill.

## Notes

**Domain:** `pi-agent-ext-*` skill packages. Owning package: `pi-agent-ext-wayfind` (placement settled by the roadmap — superpowers is byte-locked, ADR-0004/0005/0006).

**Source:** Matt-Pocock `improve-codebase-architecture` at `../pi-ext-matt-skills/skills/engineering/improve-codebase-architecture/` (SKILL.md + HTML-REPORT.md + agents/openai.yaml). All three sibling skills it depends on already exist in wayfind: `codebase-design` (A), `grilling`, `domain-modeling`.

**Skills every session should consult:** wayfinder, to-spec, writing-plans, executing-plans/SDD, finishing-a-development-branch; plus `codebase-design`, `grilling`, `domain-modeling` (composition targets).

**Standing preferences:** one deliverable at a time, shipped deep before moving on; TDD/SDD; artifacts English, reply zh-TW; **`.planning/` artifacts committed + pushed** (standing rule, CLAUDE.md § Planning artifacts).

**Hard constraints:** superpowers byte-locked (C lives in wayfind only); offline-first (no CDN); `.planning/` committed.

## Decisions so far

- [Placement -> wayfind](../2026-08-08-code-quality-roadmap/tickets/01-placement-home-for-code-quality-skills.md) — (roadmap) C lives in `pi-agent-ext-wayfind` alongside codebase-design; no new package.
- [Sourcing -> Matt-Pocock-adapt](tickets/01-sourcing-matt-pocock-adapt.md) — adapt `../pi-ext-matt-skills/.../improve-codebase-architecture/`; consistent with B.
- [Report medium -> Markdown+Mermaid under .planning/ + offline HTML converter](tickets/02-report-medium-markdown-plus-offline-html.md) — committed Markdown source-of-truth; deterministic offline (vendored Tailwind+Mermaid, no CDN) HTML render.
- [Trigger style -> command-style](tickets/03-trigger-style-command-only.md) — `disable-model-invocation: true`; explicit invocation only.

## Not yet specified

- **Offline converter vendoring strategy** — static pre-built Tailwind CSS vs vendored play-CDN JS; Mermaid `min.js` inline vs ESM; how the editorial visuals (mass diagram, cross-section, call-graph collapse) render from Markdown (Mermaid approximation vs ASCII). Sharpens via the [converter prototype](tickets/04-offline-converter-design.md).
- **Scan scope heuristic for THIS repo** — how the exploration sub-agent weights the `pi-agent-ext-*` packages vs `mlx-movie-director` vs `gui-movie-director`; what counts as a "module"/"seam" here. Sharpens during the first real scan (brainstorm/spec).
- **CONTEXT.md / ADR integration depth** — Matt-Pocock mutates `CONTEXT.md` + offers ADRs inline via `domain-modeling`. This repo's domain docs are per-package (`bun-apps/<pkg>/CONTEXT.md` + `docs/adr/`). Confirm the delegation boundary during spec.

## Out of scope

- Deliverables D (resolving-merge-conflicts) and E (context-management) — separate roadmap deliverables.
- Editing superpowers skill bodies or adding non-upstream skills (ADR-0004).
- Auto-invocability (decided command-style).
- CDN-based HTML delivery (decided offline-only).

## Cross-effort links

- **Shares-decision-with:** `2026-08-08-code-quality-roadmap` — C is deliverable C of that roadmap; placement + sequencing decided there, content-sourcing + medium + trigger decided here.

## Status

**DELIVERED.** Shipped via PR #1105 (squash-merge to main). All 5 plan tasks done: command-style skill + offline Markdown/HTML converter (npm-vendored mermaid, no CDN, firewall-friendly) + tests (golden snapshot / offline-assertion / gated Playwright paint-check) + guard gate green + e2e dogfood report. Roadmap deliverable C complete; next is D (resolving-merge-conflicts).
