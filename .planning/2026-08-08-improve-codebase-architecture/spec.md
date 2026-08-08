# improve-codebase-architecture (deliverable C) — Spec

## Problem Statement

This repo is a polyglot monorepo (TypeScript `pi-agent-ext-*` skill/extension packages, Python `mlx-movie-director` MLX pipeline, Bun/React `gui-movie-director`) that has grown organically; architectural friction accumulates — shallow modules, pure functions extracted for testability without locality, seams that leak, interfaces as wide as their implementations. There is no shared, on-demand way to surface these "deepening opportunities" against a common design vocabulary, present them durably, and work one through to a decision. Deliverable A (`codebase-design`) shipped the shared vocabulary (deep modules; module/interface/seam/adapter/depth/leverage/locality); deliverable B (`code-review`) shipped two-axis diff review. C closes the triangle: an active skill that *finds* where the architecture shallows out and *grills* the deepening.

## Solution

A command-style skill `improve-codebase-architecture` in `pi-agent-ext-wayfind`, adapted from Matt-Pocock's source skill, that runs a three-step flow:

1. **Explore** — scope before scanning (YAGNI): take a user-named direction or weight recent `git log` hot spots, with optional package-targeting for this repo's distinct clusters. Read the relevant per-package `CONTEXT.md` + `docs/adr/`. Spawn a subagent to walk the codebase for friction **raw**; the skill synthesizes deepening candidates using the `codebase-design` vocabulary and the deletion test.
2. **Present** — write a Markdown report to `.planning/<effort>/architecture-review-<date>.md` (committed, per the repo's planning-artifacts standing rule): one card per candidate (Files / Problem / Solution / Wins / strength badge / before-after diagram) + a Top recommendation. Optionally render it to a self-contained **offline** HTML via a deterministic converter (vendored Tailwind + Mermaid, no CDN). Do not propose interfaces yet; ask which candidate to explore.
3. **Grill** — on the user's pick, run `grilling` (with `domain-modeling` maintaining `CONTEXT.md`/ADRs inline); use `codebase-design`'s design-it-twice pattern for alternative interfaces.

The skill is invoked explicitly (`/skill:improve-codebase-architecture`), never auto-fires (`disable-model-invocation: true`), and consumes A's vocabulary verbatim while following B's adapted-process hygiene (fixed scan base, cited findings, fail-fast, separate presentation).

## User Stories

1. As a maintainer, I want to run one command and get a shortlist of where this codebase's architecture shallows out, so I can decide what to deepen.
2. As a maintainer, I want the shortlist scoped to where work actually happens (recent hot spots, or a package I name), so I don't waste effort on cold code (YAGNI).
3. As a maintainer, I want each candidate expressed in the shared codebase-design vocabulary (module/seam/depth/...), so findings are comparable and precise.
4. As a maintainer, I want the report committed under `.planning/`, so it survives the session, is greppable, and renders on GitHub.
5. As a maintainer, I want an offline HTML render of the report (no network, no CDN), so I can view the before/after diagrams visually without leaving my offline workflow.
6. As a maintainer, I want each candidate to carry a strength badge (Strong / Worth exploring / Speculative) and a Top recommendation, so I can pick fast.
7. As a maintainer, once I pick a candidate, I want to grill it to a decision (shape of the deepened module, what sits behind the seam, what tests survive), so the refactor is settled before I build it.
8. As a maintainer, I want new/sharpened domain terms written to `CONTEXT.md` and load-bearing rejections offered as ADRs as we grill, so the model stays current and future reviews don't re-suggest rejected ideas.
9. As a maintainer working in one package, I want to scope the scan to that package, so the candidates are relevant to where I'm working.
10. As a maintainer, I want the skill never to auto-fire, so a heavyweight scan only happens when I explicitly ask.
11. As a maintainer, I want the scan delegated to a subagent but the vocabulary synthesis + ranking done by the skill, so the gathering is cheap but the judgement is consistent.

## Implementation Decisions

- **Location & registration**: `bun-apps/pi-agent-ext-wayfind/skills/improve-codebase-architecture/SKILL.md`. Zero TS/build/manifest — pi auto-discovers `SKILL.md` under the registered skills root. Invocable as `/skill:improve-codebase-architecture`.
- **Frontmatter**: `name: improve-codebase-architecture`; `description: Use when ...` (<=1024 chars, starts "Use when"); `disable-model-invocation: true` (command-style). Must pass the CSO guard `tests/skills.test.ts`.
- **Vocabulary**: consume `codebase-design` (A) verbatim — module/interface/implementation/depth/deep/shallow/seam/adapter/leverage/locality, deletion test, internal vs external seams. Never substitute component/service/unit (module), API/signature (interface), boundary (seam).
- **Explore step**: port Matt-Pocock's YAGNI scoping — user-named direction else `git log --oneline` hot-spot weighting. Add optional package-targeting arg. Read `CONTEXT.md` + `docs/adr/` first. Subagent (pi `subagent`/`workflow`) walks raw; the skill synthesizes.
- **Present step**: Markdown report at `.planning/<effort>/architecture-review-<date>.md`, card fields per Matt-Pocock adapted to Markdown + Mermaid. Strength badges. Top recommendation. Then offer the offline HTML render.
- **Grill step**: delegate to `grilling` (+ `domain-modeling`); `codebase-design` design-it-twice for alternative interfaces.
- **Offline converter** (the novel sub-deliverable; prototyped in `brainstorm/`, commit bf122d1c): a Bun script in `pi-agent-ext-wayfind`, CLI `architecture:render <report.md> [out.html]`, emits one self-contained offline HTML. Assets: **curated static Tailwind CSS build** (only the report's classes, vendored in the package, inlined) + **inlined vendored `mermaid.min.js`** (UMD). Editorial visuals: Mermaid where graph-shaped (flowchart/sequence), ASCII `<pre>` where editorial (mass/cross-section). Deterministic; golden-HTML snapshot test; Playwright render-check that Mermaid paints. (Prototype note: the offline HTML is ~3.4 MiB, ~99% the inlined mermaid — acceptable for a one-time render.)
- **Process hygiene** (from B): pin the scan base (a commit/ref or "working tree"); every candidate cites its friction + the codebase-design principle it invokes; fail-fast on bad refs / empty scope; keep presentation separate from the grill. Scan delegated; synthesis not.
- **Shell discipline**: subshell-only git (per CLAUDE.md); the converter writes output to a chosen path (default `$TMPDIR` or alongside the report).

## Testing Decisions

- **CSO guard**: `tests/skills.test.ts` auto-discovers the new skill dir and enforces frontmatter rules — must stay green. (Its "6 expected skills" assertion uses `toContain`, so an 8th skill is safe.)
- **Converter**: golden-HTML snapshot test (deterministic input -> stable output); a Playwright/headless check that Mermaid actually paints the diagrams (the prototype could not assert this); offline-assertion test (zero non-vendored external refs in emitted HTML).
- **Skill exercise**: end-to-end on a real package during SDD (e.g. scan one `pi-agent-ext-*` package, produce a report, confirm cards + vocabulary).
- **No new schema surface**: skills aren't in the schema; `check:schema` unaffected.

## Out of Scope

- Deliverable D (resolving-merge-conflicts) and E (context-management) — separate roadmap deliverables.
- Editing superpowers skill bodies or adding non-upstream skills (ADR-0004).
- Auto-invocability (decided command-style).
- Any CDN or runtime network in the converter (decided offline-only).
- Porting Matt-Pocock's `agents/openai.yaml` (OpenAI-platform artifact; pi uses SKILL.md front-matter).

## Further Notes

- Source: Matt-Pocock `improve-codebase-architecture` at `../pi-ext-matt-skills/skills/engineering/improve-codebase-architecture/` (SKILL.md + HTML-REPORT.md + agents/openai.yaml).
- Prototype + resolved converter decisions: `.planning/2026-08-08-improve-codebase-architecture/brainstorm/` (commit bf122d1c) — see `PROTOTYPE-FINDINGS.md`.
- Wayfind map + decisions: `.planning/2026-08-08-improve-codebase-architecture/map.md` (sourcing/medium/trigger decided; ticket 04 resolved by the prototype).
- Production converter must: use a real Markdown parser (prototype is stdlib-minimal), build a real curated Tailwind stylesheet, vendor mermaid in the package, add the snapshot + Playwright tests.
