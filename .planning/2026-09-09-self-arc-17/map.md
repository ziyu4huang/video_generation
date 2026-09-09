---
effort: 2026-09-09-self-arc-17
created: 2026-09-09
last: 2026-09-09
status: done
---

# Wayfinder map: 2026-09-09-self-arc-17 — FINISH the self-develop arc: ultracode-driven full re-run of all s2-agent-ext-*

## Destination

The self-develop arc series CLOSES with its own tool auditing its own surface:
a committed ultracode workflow (`samples/audit-ext-packages.js`, B4 shape — one
auditor agent per ext package + one synthesizer) is RUN with real zai/glm-5.3
children over all 26 `s2-agent-ext-*` packages; every red the synthesizer
reports is deterministically re-verified by the executor; real small reds are
fixed in-arc with gates green; everything else is recorded as improvement-room
tickets; the devops chain completes (redeploy + qualify sweep iff src changed).
The closing docs PR writes the series retrospective (arcs 3–17), reconciles
shipped-but-active map statuses, and lands a successor next-goal marking the
self-develop arc COMPLETE — "finish" = the charter (CC-parity subagent/ultracode
surface + a verified, self-sustaining self-develop loop) is delivered, NOT
"nothing left"; remaining material becomes named successors and the queue moves
to maintenance mode.

## Context

Measured 2026-09-09 (this session, this machine) unless cited otherwise:

- **Directive** (user, verbatim intent): "Full re-run all s2-agent-ext-* and
  finding issues and improvement room, use ultracode
  (s2-agent-ext-ultracode) to finish entire self-develop arc." Task label said
  `self-arc-16` — that number is CLAIMED (see D1).
- **Package inventory**: `ls bun-apps/ | grep s2-agent-ext-` → exactly 26:
  archify, btw, compact, devops, file2md, flux2, hermes-memory, hyperframes,
  knowledge-card, krea2, ltx, movie-director, obsidian, power-tool,
  prompt-history, research-tool, subagent, superpowers, sv-analyzer, task,
  tool-gate, ultracode, wayfind, web-access, webui, zai-mcp. Excluded per the
  directive's literal scope (not `ext-*`): `s2-agent`, `s2-agent-core-interface`,
  `s2-agent-core-runtime` — noted, not audited.
- **The audit shape already exists and is unit-gated**:
  `bun-apps/s2-agent-ext-ultracode/samples/cc-parity/review-per-file.js` (B4)
  = `parallel()` reviewer per input → ONE synthesizer consuming every finding
  ("no finding left behind" is the parity receipt); gated by
  `tests/cc-parity-workflows.test.ts` with a fake runner recording prompts.
- **The driver exists**: `samples/run.ts` (library-level `runWorkflow()`, no
  TUI/CLI) — `bun bun-apps/s2-agent-ext-ultracode/samples/run.ts <script.js>
  [args-json]`; model rides `PI_MODEL` env; deterministic script in, JSON out
  (exit 0/non-zero). Arc-16 measured: `ZAI_API_KEY` must be sourced from
  `~/.zshrc` — NOT inherited by tool shells.
- **Arc numbering state** (measured from `.planning/` this session): max
  claimed = 16 — `2026-09-09-self-arc-16` (verify arc: wayfind + superpowers)
  status `done`, merged #2226, s2-agent 0.10.3+g8921d19. Arc-16's map records
  the loop lesson: "round numbers are claimed at MERGE time… expect renumbering
  at rebase" (14→16 twice in one day). The current queue head
  (`output/next-goal-20260909-190000.md`, post-#2232) still says "next =
  planner picks arc-16" — STALE, 16 is consumed; t04's successor must correct it.
- **Series state** (titles from the maps, this session): arcs 3–10 (2026-09-06)
  done — deploy self-heal/live-reload; viewer abort-flow; swarm; F-ui-2 +
  missing-invalidate; **F-invalidate fix** (arc 7); agentType **catalog** (8);
  **planner-led shape** (9); **unified agents surface** (10). Open/active:
  arc 11 (**pause levers / keep-paused / honest gates**), arc 13-2026-09-06
  (base-tech benchmark, `planning` — effectively superseded by the DONE
  `2026-09-08-self-arc-13` research-tool arc), arc 14-2026-09-06
  (**qualify.ts** sweep), arc 15-2026-09-06 (**complex benchmark / role-split**,
  shipped #2232 per next-goal but map still `active`), arc 15-2026-09-09
  (merge-chain UX: MC-7 + MC-4 shipped, MC-1/2/3/5/6 open). Arcs done: 12
  (**CC-parity samples**), 13-0908 (planner-led research-tool reliability),
  14-0908 (B3 descoped-CC pattern at workflow layer), 16-0909 (verify arc).
- **Recently moved main** (per directive brief; not re-verified this session):
  archify #2220/#2221, file2md #2220 — a full re-run may surface REAL reds
  there; those are the arc's primary fix targets.
- **Dormant carried items** (re-surface guaranteed — the audit runs `check` on
  every package): esc-settle-detector biome warning;
  `.distill-state.json.tmp` gitignore one-liner; #2179 receipt (bigger — stays
  successor material, not this arc).
- **Gates vary per package**: `bun run check` (biome in most; = tsc in
  hermes-memory), `bun run typecheck` or `bun x tsc --noEmit`, `bun test`.
  The audit script must derive its command list from each package.json's
  `scripts`, not assume a fixed triple (wayfind gates = check+typecheck+test;
  devops canonical = check && typecheck && test).

## Tickets

Phase 1 — build the auditor:
- [x] `tickets/01-audit-workflow-committed.md` — committed
      `samples/audit-ext-packages.js` (26 auditors via bounded `parallel()` +
      1 synthesizer with schema'd verdicts) + light fake-runner unit test +
      deterministic driver recipe; scripts-dir-contract + schema-cost +0
      verified.

Phase 2 — run + verify:
- [x] `tickets/02-run-and-verify.md` — real zai/glm-5.3 run over all 26;
      executor re-runs EVERY reported red deterministically; classification
      table (real-red / flake / pre-existing-warning / improvement-room);
      receipts under `output/self-arc17-audit-<ts>/` (scratch, never committed).

Phase 3 — fix + ship:
- [x] `tickets/03-fix-reds-record-room.md` — fix real small reds (incl. the two
      dormant one-liners the audit WILL surface) with gates green; record
      improvement-room as tickets; ONE implementation PR through the devops
      chain; redeploy + qualify sweep iff src/ changed.

Phase 4 — close the series:
- [x] `tickets/04-series-closeout.md` — docs close-out PR: series retrospective
      (arcs 3–17), map-status reconciliation (shipped-but-active), successor
      next-goal marking the self-develop arc COMPLETE + queue → maintenance
      mode + fixing the stale "arc-16" line, memory update.

## Decisions

- **D1 (2026-09-09)**: This effort is **self-arc-17**, not the task label's
  "self-arc-16" — that number is claimed and done (`2026-09-09-self-arc-16`,
  #2226). Reason: the recorded loop lesson (numbers claimed at merge; renumber
  at rebase) + two same-day collisions already happened at 14 and 15; claiming
  a consumed number would corrupt the series ledger. Expect renumbering to 18+
  if a parallel session merges an arc-17 first.
- **D2 (2026-09-09)**: Audit children are **READ-ONLY-OR-GATES** — stated in
  every child prompt. They may run only the package's own gate commands
  (biome/tsc/bun test write cache/scratch only) and must not modify source;
  all fixes are implemented by the executor. Reason: children with a model in
  the loop must not mutate the tree their receipts describe (arc-13 D3/D4
  discipline).
- **D3 (2026-09-09)**: Receipt standard: children transcripts are evidence;
  **the executor's own deterministic re-run of every synthesizer-reported red
  is the receipt**. No red is acted on, and none is dismissed, on a child's
  word alone. Reason: the hard-problem method (read the actual artifact) and
  arc-16's PRE-fix receipt discipline.
- **D4 (2026-09-09)**: Every `agent()` return the script consumes carries a
  schema; the synthesizer's prompt completeness is the parity receipt (B4:
  no finding left behind). Reason: workflow-script guidance (no
  process/Date/import; helpers inlined; paths ride args).
- **D5 (2026-09-09)**: One implementation PR + docs close-out PR; schema-cost
  +0 (no tool-description changes); `samples/` additions are NOT top-level
  scripts — verify scripts-dir-contract stays green rather than assume.
  Redeploy + qualify sweep ONLY iff any src/ file changed.
- **D6 (2026-09-09)**: "Finish" is charter-delivered, not work-exhausted: the
  close-out states what the series achieved AND names remaining successors.
  Reason: the directive says "finish entire self-develop arc" — faking
  exhaustion would violate the honesty fixes the series itself shipped (arc 11).
- **D7 (2026-09-09)**: Bounded fan-out: chunk the 26 auditors (~6–8 concurrent
  `parallel()` batches) with per-gate `timeoutMs` (check 120s / typecheck 240s
  / test 600s defaults, tuned after the first run). A timeout is recorded as
  `timeout` — a distinct verdict, never conflated with red. Reason: heavy
  suites (movie-director, webui) must not wedge the whole run.
- **D8 (2026-09-09)**: Pre-flight before any red is believed: `node_modules`
  `@repo/*` symlink health check (dangling symlinks survive `bun install` and
  produce fake reds — operating learning #2, repaired with
  `ln -s ../../<pkg>`). Runs once before t02 and again inside t03 before any
  fix is attempted.

## Frontier

`t01` — the committed audit workflow. Nothing upstream of it; every other
ticket consumes its artifact (t02 runs it, t03 fixes what it finds, t04 retires
what it proves). It is also the arc's dogfood hinge: the tool under audit
becomes the auditor.

## Fog of war

- **Real reds unknown until t02**: recently-merged archify/file2md may be clean
  or red; the directive expects reds there but the audit decides, not the bias.
- **Gate-command variance**: exact per-package scripts triple is derived at t01
  time from package.json files (not enumerated here — runtime data).
- **Runtime + cost**: 27 children (26 auditors + 1 synthesizer) on real
  glm-5.3; expect 15–30 min wall-clock, token spend unknown — record actuals
  in the receipt.
- **Heavy/slow suites** may need per-package timeoutMs tuning after run 1;
  `timeout` verdicts may convert to reds in a second bounded run.
- **Improvement-room volume**: the synthesizer's notes may exceed what fits in
  tickets — triage rule (t03): real defect → fix in-arc if small; everything
  else → recorded successor material, nothing silently dropped.
- **Whether redeploy is needed at all** — depends entirely on whether t03
  touches src/ (samples/tests/docs-only would skip it per D5).

## Cross-effort links

- Builds-on: `2026-09-09-self-arc-16` (verify arc — receipt discipline:
  source-leg evidence + executor-verified reds; D3 below mirrors its PRE/POST
  receipt pattern), `2026-09-08-self-arc-14` (B3: workflow-layer patterns for
  fan-out), `2026-09-06-self-arc-12` (CC-parity samples — B4 is this arc's
  template), `2026-09-06-self-arc-9` (planner-led arc shape + read budget).
- Shares-decision-with: `2026-09-08-self-arc-13` D3/D4 + `2026-09-09-self-arc-16`
  D3 (gaps recorded honestly; no LLM-authored passes; children never mutate).
- Absorbs (at t03, if surfaced): the dormant esc-settle-detector biome warning
  + `.distill-state.json.tmp` gitignore one-liner carried since
  `output/next-goal-20260909-190000.md` — NOT #2179 (stays successor material).
- Collision-note: task label claimed "self-arc-16"; `2026-09-09-self-arc-16`
  (verify arc, #2226) owns that number — see D1. Same shape as the 14/15
  collisions recorded on both arc-15 maps.
- Absorbed-by: `2026-09-09-self-arc-18` (the hermes-memory slice of the
  test-hygiene successor — its lying `check`=tsc gate, silent SurrealDB
  skips, and missing coverage signal — pulled forward by user directive;
  the REMAINING test-hygiene scope stays successor material).

## Shipped-as (2026-09-09) — the arc audits itself; the series closes

**t01+t02** — `s2-agent-ext-ultracode/samples/audit-ext-packages.js` (B4-shape:
bounded parallel batches 7-wide, 26 schema'd read-only auditors → 1 synthesizer;
static-contract unit test `tests/audit-ext-packages.test.ts` 4/4) RUN FOR REAL via
`samples/run.ts` with `PI_MODEL=zai/glm-5.3`: 26/26 packages audited by the arc's
own runtime and children (workflow journal `~/.pi/workflows/.../run-mtt8lpiv.log`;
result `output/self-arc17-audit-result.json`, scratch).

**Findings — every red deterministically re-verified by the executor (D3):**
- `s2-agent-ext-file2md` test gate RED: exit 1, 250 pass / 30 fail / 3 errors
  (deterministic mock.module() cross-file leakage — resolveVisionLLM cluster;
  per-file runs pass). From #2220's recent lanes.
- `s2-agent-ext-hyperframes` test gate RED: exit 1, 34 fail / 325 pass
  (HOME-sandbox leakage reading the real home, @hyperframes/* version-pin
  resolution, transient-init retry clusters).
- SYSTEMIC: 19/26 ext packages define no `check` script — local_ci resolves
  gates by script NAME, so lint is silently skipped for them.
- Improvement room (synthesizer-ranked, recorded): file2md mock.module isolation;
  hyperframes real HOME sandboxing (lazy homedir per call); env-gated highest-risk
  suites (PI_AGENT_E2E, deploy e2e, ML lanes) as a documented periodic lane;
  sv-analyzer wasm-dependent tests skip silently with exit 0.

**Dispositions:** the two red packages + check-script standardization are a
NAMED SUCCESSOR (test-hygiene arc — 64 failing tests across two packages is its
own arc, not a rider on the closer); sv-analyzer skip-loudness rides it. The
dormant `.distill-state.json.tmp` gitignore one-liner is ABSORBED here. Map
statuses reconciled (self-arc-15 → done citing #2232; self-arc-11 → done citing
#2204/#2205). No src/ changed in ext packages → no redeploy; launcher
byte-unchanged (0.10.3 lineage).

## Series retrospective — the self-develop arc (arcs 3–17)

The charter: evolve s2-agent-sh's subagent/ultracode surface to Claude-Code
parity, verified by a self-sustaining develop→deploy→drive→find→develop loop.
Delivered, cited per map: F-invalidate fix (arc-7, registry onChange) · agentType
catalog + CC Task-description routing (arc-8) · planner-led arc shape (arc-9) ·
unified agents surface, wf rows/badges/abort (arc-10) · keep-paused lifecycle +
builtin pack + e2e retry-on-137 (arc-11) · CC-parity samples suites A+B +
cc-parity live scenario (arc-12, #2206–#2210) · base-tech benchmark with the
pre-registered role-split verdict (arc-13) · qualify.ts sweep gate + rpc-pair +
pause-abort honesty (arc-14, #2223) · complex variants 8/8 — role-split
complex-case-proven, three screen-lane harness defects fixed, rpc zero
(arc-15, #2232) · verify-arc receipts (arc-16, #2226) · and here (arc-17): the
loop's own runtime audits its own 26 packages and the findings route back into
the queue — **the dogfood closes on itself**.

**Verdict: series COMPLETE → maintenance mode.** The loop is self-sustaining:
planner opener, gates, devops chain, qualify sweep, receipts — every stage is
committed tooling another session can run. Remaining successors are honest
work, not charter gaps: the test-hygiene arc (file2md/hyperframes/check-script),
open merge-chain MC tickets, #2179, tui-drive screenText-freeze audit,
rpc-pair widening, true turn-time instrumentation.
