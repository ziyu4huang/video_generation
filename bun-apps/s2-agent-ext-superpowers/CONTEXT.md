# s2-agent-ext-superpowers

The ubiquitous language of s2-agent-ext-superpowers — a Pi-native port of the Superpowers (Primer Radiant) software-development methodology: 15 skills — 14 ported from upstream (byte-pinned, with sanctioned local divergences) and 1 repo-owned, wrapped in this package's own Pi extension (CSO skill discovery + `using-superpowers` bootstrap). This context records the port's own vocabulary — the pin/bootstrap model, pipeline stages, and artifact-home rules — not the upstream skill bodies (those are pinned, see ADR-superpowers-0004).

## Language

### Package purpose

**Superpowers port**:
This package's product — the 14 upstream skills (brainstorming, writing-plans, executing-plans, subagent-driven-development, test-driven-development, systematic-debugging, requesting/receiving-code-review, verification-before-completion, finishing-a-development-branch, using-git-worktrees, dispatching-parallel-agents, writing-skills, using-superpowers), the 1 repo-owned one promoted from `.planning/knowledge` (dispatch-recovery, which absorbed dispatch-budget-rebalance's Calibration section in #1699), plus the Pi extension wrapper that discovers and injects them.
_Avoid_: our methodology (the ported bodies are upstream-derived, not repo-authored — but they are NOT bare-verbatim any more: see the LOCAL-DIVERGENCES record in UPSTREAM.ref)

**Positive content pin** (ADR-superpowers-0004):
The fidelity guard — `tests/skills-fidelity.test.ts` asserts every ported `SKILL.md` is byte-identical to its baseline fixture under `tests/__fixtures__/upstream-skills/`. Re-sync only via the explicit `scripts/rebaseline-upstream-skills.ts --note "<why>"`, which rewrites `UPSTREAM.ref`'s `fixtures-digest:` and logs the note; the test asserts that digest still matches the fixtures, so the record cannot describe a state that no longer exists. Which skills are pinned is declared once in `scripts/skill-provenance.ts` (`upstream` vs `repo-owned`), not restated per consumer. Consequence: repo conventions never land in a skill body — not even a "small path fix".
_Avoid_: denylist, lint rule (it is a full-content equality pin, not a pattern guard)

**Bootstrap injection** (`src/superpowers.ts`):
The extension's own code that injects the `using-superpowers` bootstrap into context on session_start/session_compact until the first agent_end — carrying the `piToolMapping()` and `piBoundaryOverrides()` sections. This is the sanctioned layer where repo divergence (tool mapping, pipeline routing, artifact paths) is expressed, instead of patching skill bodies.
_Avoid_: patch, fork (it is additive context injection, not skill edits)

### Pipeline stages

**DECIDE → SYNTHESIZE → DESIGN → PLAN → EXECUTE**:
The five-stage routing table from `piBoundaryOverrides()`. DECIDE (no spec, foggy) and SYNTHESIZE (grill settled, spec needed) belong to Wayfind; DESIGN (brainstorming), PLAN (writing-plans), EXECUTE (executing-plans / subagent-driven-development) belong to Superpowers. Four of five stages are a disk check; only DECIDE-vs-DESIGN needs judgment.
_Avoid_: waterfall phases (they are routing triggers on what's already on disk, not sequential build stages)

### Artifact home

**Canonical home rule** (ADR-superpowers-0007, amended by ADR-superpowers-0009):
Every artifact lives under `.planning/<effort>/`: specs → `spec.md`, plans → `plan.md`, brainstorm mockups → `brainstorm/`, the SDD workspace → `.planning/<effort>/sdd/<plan-basename>/` (briefs, reports, reviews, recovery ledger at `progress.md`). Upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are never written.
_Avoid_: docs/superpowers, .superpowers (retired upstream locations — the docs/superpowers namespace is deleted per ADR-superpowers-0009; never recreate)

**No-effort fallback**:
When no effort is active: specs/plans land in `.planning/specs/` / `.planning/plans/` directly (the former `docs/superpowers/{specs,plans}` alias symlinks are retired, ADR-superpowers-0009 — `.planning` is the sole artifact home), and SDD workspaces go to the flat, gitignored `.planning/sdd/` — local-only, never committed.
_Avoid_: default effort (it is the no-effort branch, keyed on `PI_PLANNING_EFFORT` being unset)

**SDD workspace path — upstream text vs actual behavior**:
`subagent-driven-development/SKILL.md:124,:132` verbatim say the workspace is `<repo-root>/.superpowers/sdd/<plan-basename>/`. That text is pinned (ADR-superpowers-0004) and intentionally NOT patched. The actual path is corrected by two sanctioned layers: (1) the skill's own `scripts/sdd-workspace PLAN_FILE` resolves to `$root/.planning/$effort/sdd/$slug` when `PI_PLANNING_EFFORT` is set, flat `$root/.planning/sdd/$slug` when unset (golden-tested in `tests/sdd-workspace.test.ts`); (2) the `piBoundaryOverrides()` bootstrap injection states the canonical-home rule directly. Agents should trust `sdd-workspace` output, not the SKILL.md path literal.
_Avoid_: fixing the skill (the correction lives in glue + injection, per the pin)

### Boundaries

**Parallel coexistence** (ADR-superpowers-0005):
Superpowers and Wayfind are two parallel, non-connecting pipelines sharing the `.planning/<effort>/` layout but not a flow. Divergence (path convergence, trigger routing) is expressed at the injection layer, never by patching upstream-verbatim skill bodies.
_Avoid_: handoff chain (they are two entry paths, not stages of one flow)

**Subagent cooperation** (ADR-superpowers-0006):
How this package cooperates with the standalone `s2-agent-ext-subagent` after its extraction — dispatch conventions (self-contained `task`, `tier` over raw model ids) carried via `references/pi-tools.md`, not by importing the package.

**Default skill-exclusion** (ADR-superpowers-0008):
Which ported skills are excluded from default discovery and why — unregister, never edit (per the pin).

## ADR index

- ADR-superpowers-0004 — skill fidelity guarded by a positive content pin
- ADR-superpowers-0005 — parallel coexistence boundary with Wayfind
- ADR-superpowers-0006 — subagent cooperation contract
- ADR-superpowers-0007 — unconditional artifact home (`.planning/<effort>/`)
- ADR-superpowers-0008 — default skill-exclusion policy
