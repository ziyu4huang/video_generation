# Merge grill-memory + distill into knowledge-card / hermes-memory

**Date:** 2026-07-18
**Status:** Approved (design)
**Scope:** Repo consolidation — remove two thin `pi-agent-ext-*` packages by merging their behavior into existing packages.

## Goal

Eliminate two standalone extension packages by folding their behavior into the
packages that already own the surrounding runtime:

1. `pi-agent-ext-grill-memory` → `pi-agent-ext-hermes-memory` (the grill
   runtime — `grill_decision` tool + detector guard — already lives there;
   only the `grill-memory` skill + an empty extension entry are homeless).
2. `pi-agent-ext-distill` → `pi-agent-ext-knowledge-card` (distill's
   `converge` already consumes knowledge-card's `ingestRecords` +
   `markSuperseded`; distill is a thin pipeline layer over knowledge-card's
   deterministic write surface).

After the merge, both source packages are deleted and all cross-package
references (manifest, CI, workspace deps, docs) are updated.

## Non-goals

- No behavior change to the grill pipeline or the distill Gate→Enrich→Converge
  pipeline. Tool *locations* and *names* change; semantics are preserved.
- No redesign of `zk_ingest`'s existing deterministic-ingest path (back-compat).
- No change to the enrich-in-agent design (enrichment stays in the driving
  agent's LLM context, between `gate` and `converge`).

## Current state (verified)

### grill-memory (极薄, no runtime)
- `skills/grill-memory/SKILL.md` — the only real content (trigger-on-description Pi skill).
- `extensions/index.ts` — empty entry, registers nothing.
- `tests/skill.test.ts` — asserts SKILL.md frontmatter + protocols.
- Runtime (`grill_decision` tool, `grill-seam.ts`, detector guard) already in
  `pi-agent-ext-hermes-memory/src/`.
- Sole external ref: `pi-agent/run-dir/manifest.json:95` (`pi-agent-ext-grill-memory/skills`).

### distill (v0.0.0, "NOT runtime-wired")
- `extensions/pi-distill.ts` — registers one `distill` tool, actions
  `status` / `gate` / `converge`.
- `src/{gate,state,threshold,converge,types}.ts` — Gate→Enrich→Converge pipeline.
  - `converge.ts` imports `ingestRecords` + `markSuperseded` from
    `../../pi-agent-ext-knowledge-card/src/{ingest,supersede}.ts` (cross-package).
- 7 test files in `__tests__/`.
- Refs: `.github/workflows/ci.yml` matrix, `.github/CI.md`,
  `bun-apps/KNOWLEDGE-LAYER.md`, `pi-agent/run-dir/manifest.json:6`,
  `pi-agent-cli/PRD.md`, `pi-agent-cli/package.json` workspace dep (cli does
  NOT actually import distill in src/extensions — dep is unused).
- `pi-agent-cli/src` + `extensions` have **zero** imports from distill.

### knowledge-card (mature host)
- Zettelkasten: `zk_extract` / `zk_ingest` / `zk_card` / `zk_ask` /
  `knowledge_query` / `graph_health`.
- `zk_ingest` already supports `source: "hermes"` (§-separated memory .md) and
  documents "hermes + auto-memory later" — distill is the planned higher layer.
- One extension file `extensions/knowledge-card.ts` registers all tools.

### hermes-memory (grill runtime host)
- Owns `grill-decision-tool.ts`, `grill-seam.ts`, `tests/grill-*.test.ts`.
- Has NO static `skills/` dir (its "procedural skills" are runtime SQLite via
  `skillStore`, a different mechanism). The static `grill-memory` SKILL.md
  needs a new `pi.skills` manifest entry to ship.

## Design

### Part 1 — grill-memory → hermes-memory

**Move:**
- `pi-agent-ext-grill-memory/skills/grill-memory/SKILL.md`
  → `pi-agent-ext-hermes-memory/skills/grill-memory/SKILL.md` (verbatim).
- `pi-agent-ext-grill-memory/tests/skill.test.ts`
  → `pi-agent-ext-hermes-memory/tests/grill-memory-skill.test.ts` (adjust the
  `SKILL_PATH` relative join to the new location; assertions unchanged).

**Manifest:** add to `pi-agent-ext-hermes-memory/package.json`:
- `pi.skills`: `["./skills"]`
- `files`: append `"skills"`

**Delete:** the entire `pi-agent-ext-grill-memory/` package.

Rationale: the grill runtime is already in hermes-memory; only the static
skill was split out. Re-uniting them removes a package whose extension entry
is empty.

### Part 2 — distill → knowledge-card (fold into `zk_ingest`)

**Constraint:** distill's defining design is that enrichment happens in the
driving agent's reasoning turn BETWEEN `gate` and `converge`. Therefore
`gate` and `converge` must remain **two separate tool calls**. They cannot be
collapsed into a single ingest (that would skip enrichment and discard the
pipeline's reason for existing).

**Move src** into a dedicated subdirectory (keeps the pipeline cohesive and
signals "this is the distill pipeline, owned by knowledge-card"):
- `pi-agent-ext-distill/src/{gate,state,threshold,converge,types}.ts`
  → `pi-agent-ext-knowledge-card/src/distill/{gate,state,threshold,converge,types}.ts`

**Rewrite cross-package imports as local** (inside `src/distill/converge.ts`):
- `../../pi-agent-ext-knowledge-card/src/ingest.ts` → `../ingest.ts`
- `../../pi-agent-ext-knowledge-card/src/supersede.ts` → `../supersede.ts`
- type imports (`KnowledgeRecord`, `IngestSummary`) same path change.

**Fold the `distill` tool into `zk_ingest`** — `extensions/knowledge-card.ts`:
- Add an `action` parameter to the `zk_ingest` tool schema:
  `Type.Optional(Type.Union(Type.Literal("gate"), Type.Literal("converge"), Type.Literal("status")))`.
- When `action` is **absent** → current deterministic-ingest behavior
  (full back-compat; no existing caller breaks).
- `action: "gate"` → run `runGate(entries, vaultPath)`; return
  `{candidates, killed, survivors, killReasons}` (read-only).
- `action: "converge"` → run `runConverge(notes, vaultPath, metrics)`; return
  the converge result (writes via `ingestRecords` + `markSuperseded` +
  threshold adjust + state persist).
- `action: "status"` → run `readState(vaultPath)`; return
  `{threshold, lastRun, historyEntries, recentRuns}`.
- Update the `zk_ingest` `description` to document the three distill actions
  and the Gate→Enrich-in-agent→Converge workflow.

The `distill` tool name is retired; one tool (`zk_ingest`) carries both the
deterministic ingest and the distill pipeline surface.

**State ownership:** distill's `DistillState` (adaptive threshold + run
history) moves with the code into `src/distill/state.ts` +
`src/distill/threshold.ts`. It is no longer a separate package's concern; it
is surfaced solely through `zk_ingest`'s `status` action and updated by
`converge`. No separate "distill state" concept remains in the package layer.

**Move tests:** the 7 distill test files
(`pipeline / gate / threshold / state / converge / e2e-supersede / distill`)
→ `pi-agent-ext-knowledge-card/__tests__/distill/`. Adjust import paths from
`../../src/...` (distill layout) to the new `../../src/distill/...` locations.
The `distill.test.ts` that exercised the `distill` tool registration is
rewritten to assert `zk_ingest` honors the `action` param instead.

**Delete:** the entire `pi-agent-ext-distill/` package.

### Part 3 — mechanical fallout

- `pi-agent/run-dir/manifest.json`:
  - remove `"pi-agent-ext-distill/extensions/pi-distill.ts"`.
  - replace `"pi-agent-ext-grill-memory/skills"` with
    `"pi-agent-ext-hermes-memory/skills"`.
- `.github/workflows/ci.yml`: remove the `pi-agent-ext-distill` matrix entry.
- `.github/CI.md`: remove `pi-agent-ext-distill` from the package list (×2).
- `pi-agent-cli/package.json`: remove `"@repo/pi-agent-ext-distill": "workspace:*"`.
- `pi-infra-self-improve` workflow (`.claude/workflows/pi-infra-self-improve.*`):
  if its scope list names `pi-agent-ext-distill`, remove it (knowledge-card
  remains in scope and now covers the distill tests).

### Part 4 — docs

- `bun-apps/KNOWLEDGE-LAYER.md`: rewrite the distill row — distill is no longer
  a separate "(New, unwired)" package; it is `zk_ingest` actions
  `gate`/`converge`/`status` inside knowledge-card. Remove the standalone
  package reference at line 105.
- `pi-agent-cli/PRD.md`: update the `pi-agent-ext-distill` bullet to point at
  knowledge-card's `zk_ingest` distill actions.
- `pi-agent-ext-knowledge-card/src/supersede.ts` comment (line 4): update the
  "Used by pi-agent-ext-distill" comment to "Used by zk_ingest converge action".
- `pi-agent-ext-knowledge-card/CONTEXT.md`: add a Distill section with the
  ubiquitous language (Gate / Survivor / Killed / EnrichedNote / Converge /
  Supersede / DistillState / threshold adjustment), noting it is now surfaced
  via `zk_ingest` actions, not a separate tool.
- `pi-agent-ext-hermes-memory/CONTEXT.md`: add a grill-memory skill entry
  noting the `grill-memory` SKILL.md ships from this package's `skills/` dir
  and co-fires with the grilling skill.

## Verification

- `( cd bun-apps/pi-agent-ext-knowledge-card && bun test )` — green (incl.
  relocated distill tests under `__tests__/distill/`).
- `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )` — green (incl.
  relocated `grill-memory-skill.test.ts`).
- `bun run --cwd bun-apps/pi-agent build:all` succeeds + `getAllTools()`
  probe shows: `distill` tool gone, `zk_ingest` present, `grill_decision`
  still registered (hermes-memory).
- Manifest load smoke: `zk_ingest` honors `action: "gate"|"converge"|"status"`
  and default (no action) ingest; `grill-memory` skill still triggerable by
  description from the hermes-memory skills path.
- `grep -rn "pi-agent-ext-grill-memory\|pi-agent-ext-distill"` over the repo
  returns only historical references (CHANGELOG / git log), no live wiring.

## Risks

- **zk_ingest schema growth**: adding `action` + the gate/converge-specific
  params widens the tool's parameter schema. Mitigation: all new params are
  `Optional`; the default path is unchanged. The existing
  `schema-cost.regression.test.ts` is the guard.
- **Manifest skills path**: hermes-memory has never shipped a static skill via
  `pi.skills`. If the Pi loader does not honor a newly-added `skills` field on
  an extension that also registers runtime tools, the skill will not load.
  Mitigation: verify via the manifest smoke test in Verification; this is the
  same `pi.skills` mechanism grill-memory used, just on a different host.
- **Broken relative imports** during the src move. Mitigation: `tsc --noEmit`
  in knowledge-card + the relocated test suite.
