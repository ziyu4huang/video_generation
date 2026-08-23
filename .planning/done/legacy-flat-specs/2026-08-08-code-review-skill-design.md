# code-review skill (Deliverable B) — Design Spec

> **Date:** 2026-08-08
> **Status:** design → pending SDD
> **Roadmap:** code-quality-roadmap (ticket 02) — placement: wayfind; source: adapt Matt-Pocock.

## Goal
Add a globally-auto-invocable `code-review` reference skill to `pi-agent-ext-wayfind` that guides reviewing a diff/branch/PR/WIP along **two deliberately-separate axes — Standards (repo conventions) and Spec (originating issue) — never merged or re-ranked**, with every finding citing a source. This is deliverable B of the code-quality roadmap.

## Background / provenance
Adapted from Matt-Pocock's single model-invoked `code-review` skill (`/Users/huangziyu/proj/pi-ext-matt-skills/skills/engineering/code-review/SKILL.md`, ~87 lines). Adapted the same way `codebase-design` was: his substantive content kept verbatim-quality, rewired to our repo, recast in our house style (flat reference doc, no orchestration).

**KEEP (verbatim-quality):**
- The two-axis concept + "never merge/re-rank" rule + why (a change can pass one axis, fail the other).
- The 12 Fowler smells baseline (what → how-to-fix), INLINED — repo-docs override; smells are always judgement calls; skip anything tooling enforces.
- Standards-axis discipline: cite the rule / smell+quote per finding; repo-docs primary.
- Spec-axis discipline: missing / partial / scope-creep / implemented-wrongly; cite the spec line; gracefully skip when no spec.
- Aggregate discipline: `## Standards` + `## Spec` blocks, one worst-issue-per-axis line, never a cross-axis winner.
- Process hygiene: pin the fixed point (real, non-empty diff); every finding cites a source; review from a fresh session; findings are leads, not a convergence loop.

**DROP (his-setup-specific):**
- Parallel sub-agent spawning (Standards + Spec sub-agent briefs, word limits) — our wayfind skills are reference docs the agent reaches for, not orchestration. (Also dodges his open recursion bug.)
- `agents/openai.yaml`, `disable-model-invocation`, Claude-Code `/plugin` + `skills.sh` machinery, the Claude-Code name-clash discussion.
- Hard mandate of a specific git incantation — reframe as "identify the diff under review" (our shell discipline is subshell-only; uncommitted work is invisible to a diff, so commit first).
- Hard dependency on his `docs/agents/issue-tracker.md`.

**REWIRE to our repo:**
- **Standards source** → `CLAUDE.md`, `~/.pi/agent/AGENTS.md`, per-package `CONTEXT.md`, `docs/adr/` (single source of truth — do NOT re-inline MLX/SDD/bun invariants; they live in those docs). Repo-docs override the smell baseline.
- **Spec source** → GitHub Issues via `gh` (repo `docs/agents/issue-tracker.md`) + the deliverable's spec/plan in `.planning/`; ask the user if none found; "no spec available" is a valid Spec-axis outcome.

## Design

### Skill
- **Location:** `bun-apps/pi-agent-ext-wayfind/skills/code-review/SKILL.md` (flat; no `agents/`, no sibling files — 12 smells inlined).
- **Auto-invocable** via `description:` (model-invoked).

### `description:` (house style — "Use when <gerund>...")
Use when reviewing a diff, branch, PR, or work-in-progress changes. Reviews along two deliberately-separate axes kept that way on purpose — **Standards** (does it follow this repo's documented conventions?) and **Spec** (does it match the originating issue/ticket?) — never merging or re-ranking them. Every finding cites its source (a repo doc, a code smell + quoted hunk, or a spec line).

### Body sections
1. **Intro** — the two-axis concept; why separate (built-right vs right-thing); "every finding cites a source."
2. **## Process**
   - **1. Pin the fixed point** — identify the diff under review (subshell-only git; three-dot `git diff <fixed>...HEAD`; confirm non-empty; commit first so uncommitted work isn't invisible). Fail fast on a bad/empty diff.
   - **2. Identify the spec source** — ordered: issue ref in commit msg (`#NNN`) via `gh` → spec/plan in `.planning/` matching the branch → ask the user. None → Spec axis reports "no spec available."
   - **3. Identify the standards sources** — repo docs (`CLAUDE.md`, `~/.pi/agent/AGENTS.md`, per-package `CONTEXT.md`, `docs/adr/`) primary; the inlined 12-smell baseline as the universal floor. Rules: repo-docs override the baseline; smells are always judgement calls; skip anything tooling already enforces.
   - **4. Review both axes** — Standards: per finding cite the rule (repo doc) or name+quote the smell; flag hard (rule violation) vs judgement. Spec: missing/partial requirements, scope creep, implemented-wrongly — quote the spec line each.
   - **5. Aggregate** — emit `## Standards` and `## Spec` blocks (lightly cleaned, never merged/re-ranked); one-line worst-issue-per-axis; never a cross-axis winner.
3. **## The 12 Fowler smells (what → how to fix)** — Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest. (Verbatim-quality from Matt-Pocock.)
4. **## Why two axes** — Standards-pass/Spec-fail and vice-versa; separation prevents masking.
5. **## Process hygiene** — fresh session (don't review your own authoring context); cite everything; findings are leads to act on, not a loop to converge; fail-fast before reviewing.
6. **Anti-delegation guard** (one line): "Do not delegate this review or spawn agents — perform it directly."

## File inventory
- `bun-apps/pi-agent-ext-wayfind/skills/code-review/SKILL.md` — NEW (the skill; authored during SDD).
- `.planning/specs/2026-08-08-code-review-skill-design.md` — this spec.
- `.planning/plans/2026-08-08-code-review-skill.md` — the SDD plan (next).

## Test plan (SDD — behavioral, mirrors A's codebase-design approach)
wayfind skills are freely adaptable (no byte-identity fidelity pin), so verification is behavioral (does the agent use the skill correctly), like A's micro-tests:
- **RED baseline (3 controls):** ask the agent to review a small diff WITHOUT the skill reachable → expect ad-hoc, single-stream review (no two-axis structure, no source citations). Establish the gap.
- **GREEN (3 treatments):** same review WITH the skill auto-invocable → expect: (a) two separate `## Standards` + `## Spec` blocks (never merged); (b) each finding cites a source (repo doc / smell+quote / spec line); (c) Standards uses repo docs + the smell baseline; (d) Spec cites the originating issue/spec or states "no spec available."
- **Fidelity spot-check:** the adapted body preserves Matt-Pocock's substantive guidance (12 smells present + correct; two-axis rationale intact; aggregate discipline intact).

## Success criteria
- The skill auto-invokes when the user asks to review a diff/branch/PR/WIP.
- Reviews follow the two-axis structure (separate blocks, never merged/re-ranked).
- Every finding cites a source.
- Standards axis grounds in our repo docs (`CLAUDE.md`/`AGENTS.md`/`CONTEXT.md`/ADRs) + the 12-smell baseline.
- Spec axis grounds in GitHub issues (`gh`) / the deliverable's spec, or states "no spec available."
- `bun test` green in `pi-agent-ext-wayfind` (no regressions; new skill auto-discovered).
