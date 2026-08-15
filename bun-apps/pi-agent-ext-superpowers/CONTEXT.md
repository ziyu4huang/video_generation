# pi-agent-ext-superpowers

The ubiquitous language of pi-agent-ext-superpowers — a Pi-native port of the Superpowers (Primer Radiant) software-development methodology: 14 composable skills ported verbatim from upstream, wrapped in this package's own Pi extension (CSO skill discovery + `using-superpowers` bootstrap). This context records the port's own vocabulary — the pin/bootstrap model, pipeline stages, and artifact-home rules — not the upstream skill bodies (those are pinned, see ADR-superpowers-0004).

## Language

### Package purpose

**Superpowers port**:
This package's product — the 14 upstream skills (brainstorming, writing-plans, executing-plans, subagent-driven-development, test-driven-development, systematic-debugging, requesting/receiving-code-review, verification-before-completion, finishing-a-development-branch, using-git-worktrees, dispatching-parallel-agents, writing-skills, using-superpowers) plus the Pi extension wrapper that discovers and injects them.
_Avoid_: our methodology, homegrown skills (the skill bodies are upstream-verbatim; only the wrapper is ours)

**Positive content pin** (ADR-superpowers-0004):
The fidelity guard — `tests/skills-fidelity.test.ts` asserts every ported `SKILL.md` is byte-identical to its baseline fixture under `tests/__fixtures__/upstream-skills/`. Re-sync only via the explicit `scripts/rebaseline-upstream-skills.ts` (writes a `UPSTREAM.ref` provenance record). Consequence: repo conventions never land in a skill body — not even a "small path fix".
_Avoid_: denylist, lint rule (it is a full-content equality pin, not a pattern guard)

**Bootstrap injection** (`src/superpowers.ts`):
The extension's own code that injects the `using-superpowers` bootstrap into context on session_start/session_compact until the first agent_end — carrying the `piToolMapping()` and `piBoundaryOverrides()` sections. This is the sanctioned layer where repo divergence (tool mapping, pipeline routing, artifact paths) is expressed, instead of patching skill bodies.
_Avoid_: patch, fork (it is additive context injection, not skill edits)

### Pipeline stages

**DECIDE → SYNTHESIZE → DESIGN → PLAN → EXECUTE**:
The five-stage routing table from `piBoundaryOverrides()`. DECIDE (no spec, foggy) and SYNTHESIZE (grill settled, spec needed) belong to Wayfind; DESIGN (brainstorming), PLAN (writing-plans), EXECUTE (executing-plans / subagent-driven-development) belong to Superpowers. Four of five stages are a disk check; only DECIDE-vs-DESIGN needs judgment.
_Avoid_: waterfall phases (they are routing triggers on what's already on disk, not sequential build stages)

### Artifact home

**Canonical home rule** (ADR-superpowers-0007):
Every artifact lives under `.planning/<effort>/`: specs → `spec.md`, plans → `plan.md`, brainstorm mockups → `brainstorm/`, the SDD workspace → `.planning/<effort>/sdd/<plan-basename>/` (briefs, reports, reviews, recovery ledger at `progress.md`). Upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are never written.
_Avoid_: docs/superpowers, .superpowers (upstream locations exist only as entry symlinks or never)

**No-effort fallback**:
When no effort is active: specs/plans land in `.planning/specs/` / `.planning/plans/` (surfaced via the `docs/superpowers/{specs,plans}` symlinks), and SDD workspaces go to the flat, gitignored `.planning/sdd/` — local-only, never committed.
_Avoid_: default effort (it is the no-effort branch, keyed on `PI_PLANNING_EFFORT` being unset)

**SDD workspace path — upstream text vs actual behavior**:
`subagent-driven-development/SKILL.md:124,:132` verbatim say the workspace is `<repo-root>/.superpowers/sdd/<plan-basename>/`. That text is pinned (ADR-superpowers-0004) and intentionally NOT patched. The actual path is corrected by two sanctioned layers: (1) the skill's own `scripts/sdd-workspace PLAN_FILE` resolves to `$root/.planning/$effort/sdd/$slug` when `PI_PLANNING_EFFORT` is set, flat `$root/.planning/sdd/$slug` when unset (golden-tested in `tests/sdd-workspace.test.ts`); (2) the `piBoundaryOverrides()` bootstrap injection states the canonical-home rule directly. Agents should trust `sdd-workspace` output, not the SKILL.md path literal.
_Avoid_: fixing the skill (the correction lives in glue + injection, per the pin)

### Boundaries

**Parallel coexistence** (ADR-superpowers-0005):
Superpowers and Wayfind are two parallel, non-connecting pipelines sharing the `.planning/<effort>/` layout but not a flow. Divergence (path convergence, trigger routing) is expressed at the injection layer, never by patching upstream-verbatim skill bodies.
_Avoid_: handoff chain (they are two entry paths, not stages of one flow)

**Subagent cooperation** (ADR-superpowers-0006):
How this package cooperates with the standalone `pi-agent-ext-subagent` after its extraction — dispatch conventions (self-contained `task`, `tier` over raw model ids) carried via `references/pi-tools.md`, not by importing the package.

**Default skill-exclusion** (ADR-superpowers-0008):
Which ported skills are excluded from default discovery and why — unregister, never edit (per the pin).

## ADR index

- ADR-superpowers-0004 — skill fidelity guarded by a positive content pin
- ADR-superpowers-0005 — parallel coexistence boundary with Wayfind
- ADR-superpowers-0006 — subagent cooperation contract
- ADR-superpowers-0007 — unconditional artifact home (`.planning/<effort>/`)
- ADR-superpowers-0008 — default skill-exclusion policy
