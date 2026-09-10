---
effort: 2026-09-10-self-arc-21-receipt-validator
created: 2026-09-10
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-10-self-arc-21-receipt-validator — INDEPENDENT RECEIPT VALIDATOR: stop trusting the harness's own grades

## Destination

qualify.ts's sweep verdicts are re-derivable from primary evidence: a devops-package
validator re-grades every scenario receipt by reading the RAW evidence (step-helper
entries, model lines, settle markers, receipt counts) without consulting the
harness's own pass/fail fields, and proves its teeth on a self-graded-pass-but-
actually-red fixture. The qualify-trust gap the deep exploration ranked #4 closes;
sweep summaries become claims the tooling can audit, not grades to take on faith.

## Context (measured at claim time, 2026-09-10)

- Charter queue head: `output/next-goal-20260910-065209.md` (Immediate steps 1–4,
  done-when boxes) — written and repointed via self-arc-19's own repoint tooling.
- The trust gap, precisely: `bun-apps/s2-agent-ext-subagent/scripts/qualify.ts`
  aggregates `summary.ts` from per-scenario receipts whose `pass` field is graded
  by the harness's own predicates (tui-drive + bench lineage); nothing re-reads
  primary evidence. The arc-17 fake-red incident (stale install + vendored-test
  sweep, proven by #2237's executor re-runs) is the same class one level up:
  grades without independent re-derivation.
- Receipt shapes to re-derive from: per-scenario receipt JSONs under
  `output/qualify<N>-full/<scenario>/` (step helper entries, model lines —
  glm-5.3-not-flash asserts, settle markers, timingsMs) and `summary.json` /
  `summary.md` counts. A specimen sweep with 10/10 green receipts is committed at
  `.planning/2026-09-10-self-arc-19/evidence/t06-sweep-summary.json` (summary
  only; full raw receipts stay scratch per convention — the validator runs on
  fresh sweeps or copied scratch dirs at test time).
- Planner/reviewer = zai/glm-5.3 double-pinned (arc-plan.ts / arc-review.ts).
  Review dispatch is UNHARVESTABLE (receipted absent — core spawnSubagent has no
  name field, no pi-runs record): the arc-review receipt IS the harvest.

## Tickets

### Phase Build

- **t01 — Freeze the evidence schema + pure validator core** (status: open — FRONTIER)
  `bun-apps/s2-agent-ext-devops/src/validate-qualify-receipts.ts`, PURE: sweep dir in → re-graded
  verdicts out, zero spawns/LLM. Schema frozen from the 2026-09-10 planner reads of
  `output/qualify19-full/` (NOT memory) plus `tui-drive.ts`'s snap emission points:
  - receipt.json fields (measured, dispatch + cc-parity specimens): `scenario`, `cwd`
    (temp dir — VANISHED by validation time, never graded), `startedAt`/`finishedAt`,
    `bytesSeen` (269503 / 485733), `snaps` (26 / 33 — equals on-disk snap count),
    `modelLine` (string, `… (zai) glm-5.3 • medium`), `checks` (per-scenario key set,
    SELF-GRADE), `pass` (SELF-GRADE), `launcher{deployedVersion,gitSha,tree}`.
  - Derivation rules (primary evidence only): (a) modelLine matches `/glm-5\.3/` AND
    NOT `/flash/i`; (b) snap files exist, count == receipt `snaps`, and every
    REQUIRED snap label per scenario is present (labels measured so far:
    dispatch → `-settled`, `-viewer`; cc-parity → `-chain-done`, `-finding`; t01
    enumerates all 10 from tui-drive.ts emission calls); (c) settle corroboration
    per operating learning #5 — a `-settled` snap's CONTENT must carry no live
    markers (spinner frames, `Working…`, `esc to interrupt`); filename alone is a
    label, not evidence; (d) structural: receipt parses, `bytesSeen > 0`, timestamps
    ordered; (e) summary.json rows count == scenario-dir count.
  - Independence rule (D4): `pass`/`receiptPass`/`checks` are read ONLY to emit
    `agree` flags in the report — never to derive a verdict. No import of
    summary.ts; scenario set comes from the directory listing + a committed
    required-evidence table.
  - Green-control unit test builds a synthetic clean sweep in `mkdtempSync` roots
    (repoint-next-goal.test.ts idiom, lines 20–31).
- **t02 — Permanent wrong-self-grade canary (THE red bar)** (status: open)
  Committed fixture dir `bun-apps/s2-agent-ext-devops/tests/fixtures/qualify-wrong-self-grade/`
  (arc-ledger-duplicate precedent, arc-ledger.test.ts lines 22–28): receipts whose
  SELF-grade says green while primary evidence says red — variants: modelLine shows
  `flash` with `pass:true`; required `-settled` snap absent; snap-count mismatch;
  summary.json rows ≠ scenario dirs. The validator must REJECT each. Two-commit
  red-bar ritual (self-arc-19 t01): run the canary assertion RED against the
  toothless state first, receipt that run into `evidence/`, then land the fix that
  turns it green. An independent grader never seen disagreeing with a wrong
  self-grade has never been seen working.
- **t03 — Runnable entry + allowlist + first REAL input** (status: open)
  `bun-apps/s2-agent-ext-devops/scripts/validate-qualify-receipts.ts` — thin shim over
  the t01 core, validate-next-goal.ts precedent (JSON stdout, diagnostics stderr,
  exit 0 green-and-agreeing / 1 derived-red-or-disagreement / 2 usage). Add the ONE
  allowlist line to `tests/scripts-dir-contract.test.ts`
  `ALLOWED_RUNNABLE_ENTRIES` (sorted: right after `validate-next-goal.ts`). Then run
  it on the REAL scratch sweep `output/qualify19-full/` → expect 10/10 re-derived
  green agreeing with self-grades; if scratch has vanished, fall back to a
  full synthetic 10-scenario green sweep in temp (idempotent either way).
  rpcCrossCheck string rule per D5. Receipt of the real-input run + a trimmed
  one-scenario specimen (receipt.json + decisive snaps) → `evidence/` (text-only,
  ≤256KB/file, t04 convention).

### Phase Close

- **t04 — Merge + close-out through the devops chain** (status: open)
  ONE implementation PR on `self-arc-21-receipt-validator`; devops gates locally
  (`bun run check && bun run typecheck && bun test`). Review VIA arc-review.ts on
  glm-5.3 (dispatch unharvestable — receipted seam; review.md + review-receipt.json
  ARE the verdict artifacts). Assert via the deploy receipt that no ext shim bytes
  drifted (test/validator-only arc — none expected); if they did, run the FULL
  qualify sweep per the iff-src-changed rule and re-run the validator on that fresh
  sweep's receipts as its real input. Finalize `evidence/` (incl. the planner
  dispatch receipt), write the successor next-goal + repoint VIA
  repoint-next-goal.ts, flip map ticket statuses + Frontier.

Execution order: t01 → t02 → t03 → t04 (single branch, ONE implementation PR;
t02's RED run precedes its GREEN fix per the two-commit ritual; t03's real-input
run lands after t02 green, before merge).

## Decisions

- D1 (2026-09-10): arc number 21 claimed VIA `.planning/arc-ledger.json` at
  branch time (the self-arc-19 procedure's first consumer); verified free on
  origin/main's ledger before the append.
- D2 (2026-09-10): validator lives in **devops** — `src/` pure core + `scripts/`
  runnable entry — not in s2-agent-ext-subagent beside qualify.ts. Reason: the
  auditor must not sit behind the graded package's own gates; the
  independent-grader convention (validate-next-goal / repoint-next-goal /
  arc-ledger guard) and the fixture idioms are devops natives. Tests gate under
  devops' `bun run check && bun run typecheck && bun test`.
- D3 (2026-09-10): PURE validator (sweep dir in → verdicts out). No live-agent
  re-run lane — that is a bigger arc, recorded out-of-scope. No qualify.ts
  rewrite, no new sweep lanes (charter fence).
- D4 (2026-09-10): independence mechanics — never import `summary.ts`'s
  `isRed`/`buildSummary` (that would consult the harness's own predicates);
  self-graded fields (`pass`, `receiptPass`, `checks`) feed only the report's
  `agree` flags, never the verdict; the scenario set comes from the directory
  listing + a committed required-evidence table, so devops needs no
  subagent-package import.
- D5 (2026-09-10): `rpcCrossCheck` is a DERIVED string, not raw evidence —
  qualify.ts:117–170 computes `model-ok+settled (Ns boot)` / `ask-FAIL` /
  `probe-CRASH: …` in-memory and persists only the string. The validator enforces
  the string form (anything ≠ `model-ok+settled…` ⇒ red) and records
  persisting raw rpc probe responses as out-of-scope Fog (it would touch
  qualify.ts — fenced off by D3).
- D6 (2026-09-10): the wrong-self-grade fixture is a PERMANENT committed canary
  (`tests/fixtures/qualify-wrong-self-grade/`), proven via the two-commit RED-first
  ritual — same standing as arc-19's ledger canary.

## Fog of war

- RESOLVED (2026-09-10, planner reads): receipt field shapes measured from real
  sweep `output/qualify19-full/` — `checks` key sets DIFFER per scenario (dispatch
  10 keys ≠ cc-parity 10 keys) → the validator tolerates unknown check keys
  (checks are not evidence anyway, per D4); summary.json row shape measured
  (`pass`/`receiptPass`/`exitCode`/`wallMs`/`receiptPath`/`rpcCrossCheck`, null
  for 7/10 rows).
- RESOLVED (2026-09-10): purity — pure validator, no live re-run (D3, charter
  preference confirmed viable: every derivation input is persisted in the sweep
  dir except rpc raw responses, covered by D5).
- REMAINS: the full required-snap-label table for all 10 scenarios — only 2
  specimen-read so far; t01 enumerates the rest from tui-drive.ts's snap emission
  points before freezing the table.
- REMAINS (small): summary.md count cross-check — json-rows-vs-dirs is the hard
  gate; md parsing stays a soft check or is skipped if its format proves unstable.
- NEW: scratch lifetime — `output/qualify19-full/` exists today but is gitignored
  scratch; t03's real-input step is written to fall back to a synthetic full green
  sweep if the scratch dir has been cleaned.

## Cross-effort links

- Builds-on: `2026-09-10-self-arc-19` (ledger + repoint tooling this arc uses;
  its evidence dir holds the sweep specimen; the deep-exploration report's
  fix #4 is this arc's charter).
- Absorbed-by: none.

## Shipped-as (2026-09-10, #2257)

All four tickets shipped in ONE implementation PR (#2257, squash ab102c0a,
verify-merge CLEAN; review gate ran through arc-review.ts — GLM-5.3,
VERDICT: APPROVE, zero blockers/should-fix, both nits closed in-arc:
LIVE_MARKER_RE drift-guard test + red-bar receipt header annotation).
Deviations and live finds, faithfully:

- **The grader's first REAL run produced real knowledge**
  (evidence/t03-real-input.md): the v1 settle rule (screen-global live-marker
  absence) misfired on the FIVE persistent-background scenarios — catalog,
  cc-parity, swarm, viewer, wf-pause — whose background/child rows keep
  spinning after the tested task settles. Calibrated per-scenario:
  settledLike null there (their forced route/badge labels are the settle
  evidence), strict marker-absence kept for dispatch/parallel/agents/
  reload/workflow.
- **The red-bar ritual was again the proof**: commit A's toothless verdict
  (echo) let all four wrong-self-grade canary variants through (receipted);
  commit B's one-line flip (derive from evidence) is the entire difference
  between a grader and a rubber stamp.
- Final run on the REAL 2026-09-10 sweep: 10/10 re-derived green, allAgree
  true, exit 0 (evidence/t03-real-sweep-validated.json). Suite 11/0.
- Reviewer harvest remains unharvestable (receipted absent — successor item).
- Deploy assertion: pure validator + tests only; deploy receipt check at the
  sync step (ext shim drift → iff-src-changed sweep if bytes move).
