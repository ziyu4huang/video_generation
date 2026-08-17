**ID:** `ADR-wayfind-0007` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0007: Solution-extension simplification — wayfind is the pure decide/wayfinder engine

Date: 2026-08-17
Status: accepted
Plan: `.planning/plans/2026-08-16-solution-extension-simplification.md`
Design: `.planning/specs/2026-08-16-solution-extension-simplification-design.md`

## Context

`pi-agent-ext-wayfind` had grown into two things at once: Matt Pocock's
decision-chain port (grilling / wayfinder / domain-modeling — the reason the
package exists) **and** a parallel methodology library (research, prototype,
subagent discipline, code review, debugging, agent-writing) that duplicated
vocabulary already owned by the sibling `pi-agent-ext-superpowers` port. Two
homes for one methodology meant: duplicated maintenance, ambiguous
skill-selection for the agent, and skill-set weight wayfind never needed.
Alongside that, `src/commands.ts` and `src/effort-tool.ts` had accreted into
fat modules, and an `architecture-render` docs-diagram CLI had landed in wayfind
only because archify did not exist yet when it was written.

The 2026-08-16 effort (`solution-extension-simplification`, Tasks 1–13)
consolidated all of this.

## Decision

### 1. Six methodology skills deleted from wayfind, merged into superpowers

One methodology home: superpowers. The six deleted wayfind skills and their
merge targets (matching the redirect table in `skills/ask-matt/SKILL.md`):

| Deleted wayfind skill | Merged into (superpowers) | What moved |
|---|---|---|
| `research` | `dispatching-parallel-agents` | background research subagent + cited findings artifact |
| `subagent-dispatch-discipline` | `dispatching-parallel-agents` | pre-dispatch guardrails |
| `diagnosing-bugs` | `systematic-debugging` | reproduction-loop engineering |
| `code-review` | `requesting-code-review` + `receiving-code-review` | Standards-vs-Spec dual axis |
| `prototype` | `brainstorming` | "When a question needs a prototype" pointer |
| `writing-for-agents` | `writing-skills` | generalized to all agent-consumed docs |

`skills/` went 22 → **16** dirs. Merged content landed as sanctioned LOCAL
extension sections layered onto the upstream superpowers skill bodies (see
"Deliberate upstream divergence" below).

### 2. wayfind = the pure decide/wayfinder engine

What remains is the decision chain and nothing else, with artifact chain
`CONTEXT.md → spec.md → tickets/ → task_plan.md → /wayfind seed → /wayfind sync`.
`to-spec` and `to-tickets` were trimmed to their artifact contracts + chain
wiring (30 and 45 lines; methodology prose replaced by one pointer to superpowers
`writing-plans` / `subagent-driven-development`), and `ask-matt` was slimmed to
wayfind-family routing (107 lines).

### 3. Source modules split to thin shells

- `src/commands.ts` → a thin dispatcher (137 lines) over per-command handler
  modules in `src/commands/` (`wayfind-handlers.ts`, `grill-handlers.ts`,
  `help.ts`, `keywords.ts`, `shared.ts`).
- `src/effort-tool.ts` → gate def + pure cwd-based ops + 5-action tool (502 →
  376 lines) with renderers extracted verbatim to `src/effort-render.ts` (111)
  and hermes staleness enrichment + guarded `webui:render` emit to
  `src/effort-enrich.ts` (56). Renderer output is byte-identical (the `stale`
  undefined/null/0/N branches survive untouched); `effort-tool.ts` re-exports
  `renderValidate`/`renderStatus`/`renderList` so importers and tests kept
  resolving.

### 4. `architecture-render` relocated to archify

The docs-diagram CLI, `architecture.css`, mermaid/tailwind vendoring, its
scripts, tests, and golden fixtures moved to `@repo/pi-agent-ext-archify`
(`lib/`, `vendored/`, `__tests__/` per its conventions). Wayfind had **zero src
importers** of `renderReport` (verified pre-move), the golden comparison passing
in archify **is** the byte-identity bar, and wayfind's `package.json` no longer
carries `architecture*` scripts, `pretest` vendoring, or the mermaid/tailwind
deps. Registration conventions were unaffected: archify's single
`extensions/archify.ts` entry (Task 12 verified).

### 5. Invariants preserved

- **globalThis seams (ADR-wayfind-0004):** no cross-package imports were
  introduced by any split or move; the status-widget decoupling stands.
- **Reverse seam (ADR-wayfind-0003):** the `__piPlanPhases` reverse seam /
  continuous chain is untouched; plan-seed contract tests stayed green
  throughout.
- **Concurrency (ADR-wayfind-0005):** last-write-wins for `.planning/<effort>/`
  unchanged.

## Deliberate upstream divergence (standing rule)

The six merged LOCAL sections in superpowers are **deliberate divergence**, not
drift to be cleaned on the next upstream re-sync:

- **Do NOT re-port the deleted skills.** They are gone from wayfind on purpose;
  a re-sync that resurrects them re-creates the two-homes problem.
- **Do NOT blow the merged sections away with a naive upstream re-port.** The
  superpowers baseline fixtures' `UPSTREAM.ref`
  (`pi-agent-ext-superpowers/tests/__fixtures__/upstream-skills/UPSTREAM.ref`)
  carries a `LOCAL-DIVERGENCES` block (2026-08-16) that re-baselined the pins to
  the MERGED bodies: a naive re-port fails `skills-fidelity.test.ts` by design.
  Re-sync procedure: rebase the LOCAL sections onto the new upstream body,
  re-baseline, and log it in `UPSTREAM.ref`.
- Artifact paths referenced by the merged skills resolve under `.planning/`,
  the sole artifact home per `ADR-superpowers-0009`.

## Consequences

- One methodology vocabulary, one owner (superpowers); wayfind's advertised
  surface shrank by 6 skill dirs (schema-cost canary re-run in Task 12).
- Muscle-memory users get a one-release grace period: the redirect table in
  `ask-matt/SKILL.md` maps deleted names to their superpowers targets. Per
  `docs/versioning.md` (OPEN-3 resolution), the table is **deleted at the
  `0.2.0` minor bump** — the first wayfind version bump after `0.1.0`.
- `ask-matt` redirects deleted-skill lookups; superpowers'
  `DEFAULT_SKILL_EXCLUDE = ["verification-before-completion",
  "using-superpowers"]` (`ADR-superpowers-0008`) needs no change from any of
  this.
- **Noted deviation — `effort-tool.ts` line count.** The plan's Task 10 gate
  estimated ≤ 260 lines post-extraction; the actual module is **376** (from
  502). The estimate assumed only the gate def + 5 actions would remain, but
  the plan itself also required keeping `createEffort`/`validateEffort`/
  `effortStatus` with their result interfaces and the parameter-schema/gate
  wiring in place — that retained core, not the extraction scope, is the gap.
  Extraction fidelity (verbatim renderer bodies, byte-identical output, all
  tests green) was the real acceptance bar and holds; the code was NOT hacked
  down to hit the estimate. Commands split landed well under its bar
  (`commands.ts` 137 ≤ 220).
- End state sanity (Task 13 verification): 16 skill dirs; `src/commands.ts`
  137 lines; `src/effort-tool.ts` 376 lines; no `src/architecture-render.ts`,
  no `vendor/`, no `architecture*` scripts in wayfind's `package.json`; greps
  for deleted skill names hit only `ask-matt`'s redirect table.
