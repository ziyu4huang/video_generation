---
effort: 2026-09-10-self-arc-22-review-harvest
created: 2026-09-10
last: 2026-09-10
status: active
---

# Wayfinder map: 2026-09-10-self-arc-22-review-harvest — make the GLM-5.3 review gate's verdict HARVESTABLE by name

## Destination

An arc-review.ts dispatch's verdict round-trips through the standing harvest
SOP: `reviewer-harvest --name <name>` finds the review, extracts the verdict,
and writes its idempotent receipt — for BOTH dispatch paths (claude-glm named
reviewers AND core-spawnSubagent children). Today the s2-agent path is a
hand-run artifact: the review.md + receipt exist but the harvester returns
absent (receipted twice: self-arc-19 t03 and self-arc-21 t03). The loop's
quality gate closes its last hand-run link.

## Context (measured at claim time, 2026-09-10)

- Charter queue head: `output/next-goal-20260910-202309.md` (Immediate steps
  1–4, done-when boxes).
- The miss receipts:
  `.planning/2026-09-10-self-arc-21-receipt-validator/evidence/t03-harvest-check.txt`
  and `.planning/2026-09-10-self-arc-19/evidence/t03-harvest-check.txt` —
  `reviewer-harvest --name arc-reviewer --timeout 0` → `status: "absent"`,
  exit 1. PRIMARY path searches `~/.claude-glm` transcripts (claude-CLI
  named agents); FALLBACK searches `~/.pi/subagents/runs/<runId>.json`
  (pi-harness live agents, PR #2170). Core `spawnSubagent`
  (`s2-agent-core-runtime/src/spawn-subagent.ts`) has NO `name` field in
  SpawnSubagentOptions and persists NOTHING to either location — arc-plan.ts /
  arc-review.ts write their OWN receipts instead.
- The harvester's contract: `--name <n>` → newest matching transcript/run →
  last `end_turn` assistant text as verdict; exit 0 completed / 1
  still-running·absent·errored / 2 usage; idempotent receipt under
  `output/reviewer-harvest/`.
- Design space (successor file): ① `name` passthrough on core spawnSubagent
  that lands in a record the harvester reads; ② reviewer-harvest support for
  a well-known receipt artifact kind (arc-review.ts already writes
  review-receipt.json — teach the harvester to read receipt-shaped artifacts);
  ③ arc-review.ts ALSO writing a marker file the harvest SOP accepts.
  Prefer whichever keeps D4-style independence and serves BOTH paths.
- Effort work proceeds in a DEDICATED WORKTREE
  (`/Users/huangziyu/proj/video_generation__selfarc22`): the memory worktree
  holds a parallel session's staged archify work. Pass `--repo-root`/`--cwd`
  to every CLI.

## Tickets

### Phase A — implement (script-side only; no core-src, no harvester edits)

- **t01 — `arc-run-record` helper + contract test** (`s2-agent-ext-subagent`):
  new `src/arc-run-record.ts`, NOT exported via `src/index.ts` (scripts
  import it relatively — the `builtin-pack.js` pattern — so the
  barrel-surface test stays untouched): `arcRunStatusFor(result)` →
  `SubagentRunStatus` (`failure?.kind ?? "done"`, plus the empty-output
  guard: success with blank output → `"failed"` + error `"empty reviewer
  output"` — a degenerate dispatch must harvest as errored, never spin
  still-running) and `saveArcReviewRunRecord({ home?, name, task, cwd,
  model, startedAt, elapsedMs, result })` wrapping core's EXPORTED
  `createSubagentRunPersistence({ home })` + `generateSubagentRunId()`,
  modeled on the subprocess call site (spawn-subagent-subprocess.ts:387):
  `{ id, toolCallId: id, agentName: name, agent: "arc-review", task,
  model, cwd, status, error: failure?.message, startedAt, elapsedMs,
  output: result.output, usage, turns }`. Best-effort semantics (never
  throws — mirror `save()`). Tests `tests/arc-run-record.test.ts`
  (tmp-`home` idiom): the status mapping incl. the guard; CONTRACT test —
  save via the helper into a tmp home, then run devops'
  `findPiRuns({ piRunsRoot: subagentRunsDir(tmp), name })` + `parsePiRun`
  (relative import `../../s2-agent-ext-devops/src/reviewer-harvest.ts`)
  → `completed`, verdict === output; a failure-kind record → `errored`.
  If a package gate rejects the cross-package relative import, relocate
  the contract test to devops `tests/reviewer-harvest.test.ts` with a
  fixture-builder — the CONTRACT, not the test's home, is what must hold.
  Status: open.
- **t02 — wire arc-review.ts** (`s2-agent-ext-subagent/scripts/arc-review.ts`):
  add `--name <n>` (default `arc-reviewer`); capture the resolved model
  via spawnSubagent's `onModelResolved` (fallback: requestedModel); after
  the run — success AND failure, before any `process.exit` — call
  `saveArcReviewRunRecord` (persistence hiccup → stderr log, dispatch
  still succeeds). Receipt gains `name` and flips `nameSupported: true`;
  rewrite the header "Known seam" comment → closed by self-arc-22 (the
  record lands in the standard pi-runs archive; the harvester FALLBACK
  finds it unchanged). Status: open.
- **t03 — SOP clarifying line** (`s2-agent-ext-devops/skills/devops-workflow/SKILL.md`,
  where reviewer-harvest is described): receipt-kind dispatches
  (arc-review.ts) persist a standard run record at completion, so
  `reviewer-harvest --name arc-reviewer` needs no dispatch-path changes;
  TaskStop does not apply (no live agent to kill); `--timeout` polling
  sees absent→completed at record landing. ~2 lines, rides the PR.
  Status: open.

### Phase B — prove & ship

- **t04 — round-trip proof on a REAL dispatch**: dispatch arc-review.ts
  with a small real prompt (review THIS arc's own map.md), then from the
  worktree root `bun bun-apps/s2-agent-ext-devops/scripts/reviewer-harvest.ts
  --name arc-reviewer --timeout 0` → EXIT 0, `source: "pi-runs"`, verdict
  extracted, receipt under `output/reviewer-harvest/`; re-run → receipt
  `unchanged: true`. Evidence into `evidence/` (text-only, ≤256KB/file):
  dispatch stdout, both harvest JSONs + exit codes, harvest receipt copy.
  Status: open.
- **t05 — ONE implementation PR via the devops chain**: scoped local CI
  for `s2-agent-ext-subagent` + `s2-agent-ext-devops` (canonical
  per-package gates); review gate VIA arc-review.ts on the diff, then
  harvest THIS arc's own verdict by name (the dogfood) and cite it in the
  PR body; squash-merge (never `--auto`); verify-merge full-scope.
  Map + tickets + evidence ride the PR. Deployed bundles: NO core-src
  changes ⇒ deployed core hash unmoved (iff-src-changed ⇒ no redeploy, no
  qualify sweep) — state this in the PR body. Status: open.
- **t06 — close-out**: successor `output/next-goal-<ts>.md` written +
  repointed VIA repoint-next-goal.ts; map `status`/`last` flipped; ledger
  untouched (22 stays claimed at 4c191667). Status: open.

## Execution order

t01 → t02 → t03 (rides t02's commit) → t04 → t05 → t06. No step may
reorder: the contract test (t01) defines the record the script (t02)
writes, the SOP line (t03) documents what t04 proves, and t05's
review-by-name dogfood is only possible after t02+t04.

## Decisions

- D1 (2026-09-10): arc number 22 claimed VIA `.planning/arc-ledger.json` at
  branch time (commit 4c191667); 22 verified free (max live 21).
- D2 (2026-09-10): design ③, realized as a CONSUMER of core's existing
  exported persistence — arc-review.ts persists a standard
  `SubagentRunRecord` (`agentName: "arc-reviewer"`) via
  `createSubagentRunPersistence` (exported at
  s2-agent-core-runtime/src/index.ts:255–269; shape measured in
  subagent-run-persistence.ts — `agentName?`, `SubagentRunStatus`
  vocabulary ≡ `SubagentFailure.kind`, `output` = final text) into
  `~/.pi/subagents/runs/<id>.json` — the exact root the harvester's
  FALLBACK scans; `findPiRuns`/`parsePiRun` need zero changes. Why not ①:
  edits core src ⇒ the deployed core hash moves (iff-src-changed ⇒
  redeploy + full qualify sweep) and adds a persistence subsystem to a
  path that deliberately has none — out of proportion for the round-trip.
  Why not ②: a third artifact-kind branch in the harvester serves one
  caller — more surface, same outcome; review-receipt.json stays the
  human-readable artifact. ③ touches one script + one helper module + one
  SOP line.
- D3 (2026-09-10): verdict-extraction rule — the verdict is the child's
  FULL final output (`review.md` is `result.output` verbatim, no wrapper;
  no last-block parsing). Empty-output success writes `status: "failed"` /
  error `"empty reviewer output"` (harvest totality: a degenerate dispatch
  must never present as still-running).
- D4 (2026-09-10): write-once at completion (the persistence layer's own
  invariant), NOT a running→terminal record pair — `--timeout` polling
  sees absent→completed at record landing, identical to every other
  archive record. `--name` defaults to `arc-reviewer` (the SOP's canonical
  name); provenance rides the standard `agent: "arc-review"` role-label
  field — no invented fields.

## Frontier

t01 — the helper + contract test define the record contract every later
step consumes; it is pure addition (new module + new test), touches
neither core src nor the harvester, and unblocks t02/t04 in one sitting.

## Fog of war

- RESOLVED (planner, 2026-09-10): a persistence point DOES exist —
  `subagent-run-persistence.ts` (opt-in `persistence:` on the SUBPROCESS
  twin only, save call at spawn-subagent-subprocess.ts:387) writing
  `~/.pi/subagents/runs/<id>.json`; the IN-PROCESS spawnSubagent that
  arc-review uses has none — D2 consumes the exported API instead of
  adding one.
- RESOLVED (planner, 2026-09-10): the claude-glm PRIMARY keys on the
  transcript FILENAME — `agent-a<name>-<hash>.jsonl`, exact name equality
  (reviewer-harvest.ts `TRANSCRIPT_NAME_RE` / `findTranscripts`) under
  `~/.claude-glm/projects/*/*/subagents/`. `arc-reviewer` cannot collide
  unless a claude-glm agent is literally named that — and PRIMARY winning
  that race is by design.
- RESOLVED (planner, 2026-09-10): TaskStop does not apply to a
  receipt-kind artifact (no live agent to kill); the clarifying SOP line
  is t03, in scope as docs riding the PR.
- Open (small): whether the ext-subagent package gate tolerates the
  contract test's cross-package relative import
  (`../../s2-agent-ext-devops/src/reviewer-harvest.ts`) — fallback
  recorded in t01. Live-archive sanity confirmed: `~/.pi/subagents/runs/`
  holds real records (e.g. mt56ra89-qf376z.json, `status: "done"`,
  `output` = verdict); records WITHOUT `agentName` are skipped by
  findPiRuns by design, so the `arc-reviewer` name cannot be stolen.

## Cross-effort links

- Builds-on: `2026-09-10-self-arc-19` (arc-review.ts, reviewer-harvest
  fallback) and `2026-09-10-self-arc-21` (the second miss receipt + the
  ledger/repoint procedures this arc consumes).
- Absorbed-by: none.
