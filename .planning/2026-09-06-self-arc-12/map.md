---
effort: 2026-09-06-self-arc-12
created: 2026-09-07
last: 2026-09-07
status: planned
---

# Wayfinder map: 2026-09-06-self-arc-12 — CC-parity test samples: subagent + ultracode common use cases

## Destination

One merged PR that adds a committed, EXECUTABLE CC-parity samples suite: unit-level
samples for Claude Code's documented subagent common patterns (context isolation,
parallel research, chaining, code-reviewer) in ext-subagent, real WorkflowManager
samples for the documented workflow use cases (audit-many-files, bounded verify/fix
loop, review-per-file + synthesizer, research fan-out) in ext-ultracode, one catalog
doc mapping every sample to the exact CC doc section it mirrors, and 1–2 live
deployed receipts (chain + code-reviewer via real zai/glm-5.3 children) — proving
s2-agent parity per pattern, not in prose but in green named assertions.

## Context

Measured 2026-09-07 on this machine, read in-tree by the planner:

- **CC docs catalog** (official docs, fetched for this arc's task prompt): sub-agents
  doc lists 3 common patterns — isolate high-volume ops, parallel research, chain
  subagents — plus the canonical `code-reviewer` (read-only, tools exclude
  Edit/Write); workflows doc lists 6 example prompts — audit-many-files,
  keep-fixing-until-check-passes, migrate-in-parallel, review-every-changed-file,
  research-across-sources, find-issues-until-convergence — with script primitives
  `agent()`, `pipeline()`, `parallel()`, `phase()`, `log()`, `args`, `meta`,
  null-for-stopped filtering.
- **Harness inventory** (grep, not assertion): `fakeSpawn(impl)` injection seam at
  `bun-apps/s2-agent-ext-subagent/tests/subagent-tool.test.ts:49` with
  `_spawn-result.ts` result builders (`ok`/`failed`/`timedout`/`budgetAbort`/`turnsAbort`);
  real `WorkflowManager` runs with injected `fakeAgent(usage, result)` at
  `bun-apps/s2-agent-ext-ultracode/tests/workflow-manager.test.ts:13,88`;
  committed real-workflow-script precedent in `bun-apps/s2-agent-ext-ultracode/samples/`
  (`kcard-converge-loop.js` — a loopUntilDry convergence loop — plus the
  `samples/run.ts` headless runner).
- **tui-drive.ts** (`bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts:59`) has
  9 scenarios: dispatch, parallel, viewer, agents, reload, swarm, catalog,
  workflow, wf-pause. NONE covers chaining (result of spawn #1 embedded in spawn
  #2's task) or the code-reviewer pattern (read-only reviewer + file unchanged).
  The harness already encodes the pty learnings: TERM=xterm-256color, DA responder,
  64-byte chunked feed, paced keypresses, settle-on-live-markers-only.
- **Receipts pattern** (self-arc-9): dual receipts source-tree + deployed-tree under
  `output/<arc>-{flow}-{src,deployed}-<date>/` with per-scenario required checks in
  `receipt.json`; `.planning/2026-09-06-self-arc-9/map.md` is the specimen.
- **Batch read-only constraint**: `subagents` batch fan-out children are ALWAYS
  read-only (edit/write/bash excluded; recon notice asserted at
  subagent-tool.test.ts:113) — any sample tasking a batch child to write cannot pass.

## Tickets

**Phase 1 — sample suites (the PR's core; both land in the implementation PR)**

- [ ] `tickets/01-suite-a-subagent-samples.md` — Suite A: A1 context-isolation,
      A2 parallel-research batch fan-out, A3 chaining, A4 code-reviewer (read-only,
      byte-unchanged) — `cc-parity-*.test.ts` in ext-subagent via `fakeSpawn` +
      seeded `tests/fixtures/cc-parity/`
- [ ] `tickets/02-suite-b-ultracode-samples.md` — Suite B: B1 audit-many-files,
      B2 bounded verify/fix loop, B4 review-per-file + synthesizer, B5 research
      fan-out w/ null-for-stopped — real scripts in `samples/cc-parity/` executed
      by real WorkflowManager with `fakeAgent`

**Phase 2 — catalog + live receipts (same implementation PR)**

- [ ] `tickets/03-samples-catalog-doc.md` — one catalog md mapping every sample →
      CC doc section/URL, run command, and the receipt that proves parity
- [ ] `tickets/04-live-receipts-cc-parity-scenario.md` — ONE new tui-drive
      scenario `cc-parity` (chain + code-reviewer, real glm-5.3 children), source
      + deployed receipts

**Phase 3 — close-out (separate docs PR)**

- [ ] `tickets/05-map-closeout.md` — map done + Shipped-as, reciprocal
      cross-effort links, successor next-goal

## Decisions

- D1 (2026-09-07): samples are committed EXECUTABLE tests, not prose — parity is
  proven by green assertions named after the CC pattern (e.g. a test named for
  "isolate high-volume operations"), and the catalog doc maps sample ↔ doc section.
  Rationale: the user directive says "test sample"; a green test is the only form
  that keeps proving parity after refactors.
- D2 (2026-09-07): Suite B samples are REAL workflow scripts committed under
  `bun-apps/s2-agent-ext-ultracode/samples/cc-parity/`, executed at test time by
  the real WorkflowManager with the injected `fakeAgent` runner (mirrors
  workflow-manager.test.ts + kcard precedent). No LLM in unit gates — LLM-proof
  lives only in t04's live receipts.
- D3 (2026-09-07): the batch read-only constraint shapes task design, not the
  harness: A2/A4 and B-sample `agent()` steps are read-only tasks. This is also why
  B3 (migrate-many-files, isolated WRITABLE copies) is descoped — it requires
  write-capable fan-out children, which s2-agent's batch tool deliberately forbids;
  forcing it would test a deviation, not parity.
- D4 (2026-09-07): the catalog doc lives at `bun-apps/s2-agent/docs/cc-parity-samples.md`
  (umbrella package users launch; its docs/ exists) with one-line cross-links from
  both ext READMEs. One doc, not two — the deliverable is a single map of parity.
- D5 (2026-09-07): live receipts = ONE new tui-drive.ts scenario `cc-parity`
  (chain + code-reviewer in one drive), not a new runnable script — tui-drive.ts is
  already allowlisted, so no scripts-dir-contract delta. Children = zai/glm-5.3,
  NEVER flash — this arc's model policy overrides cc-parity-2 D2's flash floor; a
  `childrenNotFlash` receipt check enforces it.
- D6 (2026-09-07): Suite B scope = B1, B2, B4, B5. B3 descoped (D3); B6
  (find-issues-until-convergence) descoped as NEW work because convergence looping
  is already receipted by `samples/kcard-converge-loop.js` — the catalog maps B6 to
  that existing sample instead of duplicating it.
- D7 (2026-09-07): no production-code change is planned (tests, sample scripts,
  docs, one scenario in an existing dev script). Therefore schema-cost delta is +0
  BY CONSTRUCTION; the Bundle Reality Check in t04 is a guard that activates only
  if a src/ change sneaks into the PR (then grep the deployed bundle for the new
  symbol before trusting deployed receipts — learning #1).

## Frontier

`tickets/01-suite-a-subagent-samples.md` first: pure test additions on an existing
harness (`fakeSpawn` + `_spawn-result.ts` builders), zero production code, fastest
path to green — and its fixtures (planted-bug file, research corpus) are reused by
t04's live scenario, so later tickets build on it. t02 follows the same shape
against WorkflowManager.

## Fog of war

- Whether a shipped `code-reviewer`-equivalent read-only agentType already exists
  in the live catalog (self-arc-8's `catalog` scenario proves routing works but did
  not enumerate the shipped list) — t04 seeds its own read-only definition either
  way (cc-parity-2 seeds probe definitions the same way, tui-drive.ts:104).
- The exact seam WorkflowManager exposes for running a script FILE from a test
  (`samples/run.ts` does it headlessly; t02 verifies whether tests load by path or
  read+eval, and pins whichever the runtime actually supports).
- Whether the live chain receipt can latch the second child's TASK LINE from the
  screen (the call line renders the task prefix) or must fall back to the settled
  result row containing the propagated marker — t04 latches whichever appears,
  gated on CHILD evidence (self-arc-9 finding: gate on child, not parent spinner).

## Cross-effort links

Builds-on: `2026-09-06-self-arc-8` (catalog scenario — CC-parity agentType routing
precedent), `2026-09-06-self-arc-9` (planner-led arc shape + dual source/deployed
receipts discipline + child-evidence gating), `2026-09-06-self-arc-10` /
`2026-09-06-self-arc-11` (workflow + wf-pause scenarios — the ultracode side of the
same tui-drive harness this arc extends), `2026-09-06-subagent-tui-cc-parity-2`
(the harness itself: D1 pty learnings, D2 model wiring, settle/live-marker rules).
Shares-decision-with: `2026-09-06-subagent-tui-cc-parity-2` D2 (model policy) —
D5 here narrows it to glm-5.3-only for this arc's children.
Reciprocal back-links are added to those maps at close-out (ticket 05).
