---
effort: 2026-09-10-spwf-ab-closing
created: 2026-09-10
last: 2026-09-10
status: active
---

# Wayfinder map: 2026-09-10-spwf-ab-closing — settle the A/B residuals with evidence, not narrative

## Destination

Planner-led successor (GLM-5.3, receipt output/spwf-next-plan/plan.md) to
the A/B arc. End state = the C2-glm verdict is SETTLED under a
same-turn-batch-aware detector (built + validated against preserved bytes,
promoted to a committed home with a regression test); C1 salience has a
5-sample YES-rate with pre-committed branch actions executed exactly; the
gemma column gets one honest precondition-gated quiet-window attempt (or a
dated defer); the F3 repo-gate question gets an evidence-based
intended-vs-defect ruling that re-sets the C5 expectation. No
detector-artifact PARTIALs survive; every flipped verdict cites evidence
committed under this effort's evidence/ dir (D7). Loop ritual closes:
reviewer GLM-5.3, status flip in the landing PR, validated successor.

## §0 The headline the planner found first

The A/B arc's C2 "PARTIAL (batched same-turn)" was a DOUBLE detector
artifact. Decoding the preserved postfix session: line 5 = read(brainstorm)
+ bash recon (`ls|cat`, READ-ONLY); line 8 = write(hello.ts). The read turn
strictly preceded the write turn — the model was compliant. Two bugs: (a)
line-based idx collapsed toolCalls sharing an assistant message; (b) the
mutation regex counted ANY bash touching spwf-ab as mutating. The model was
blamed for what the ruler mis-measured. t02 fixes the ruler; t03 re-measures.

## Context (planner-verified + executor re-verified 2026-09-10)

- Dist pin: 0.10.3+gc172fd3 is the ONLY version dir grepping the F2 line in
  ext/superpowers/ext.cjs (=1); current → same dir; main tip 61688652 =
  this arc's parent merge. Zero open PRs at open.
- F2 source: superpowers/src/superpowers.ts:283 region
  (getBootstrapContent).
- C5-glm session: single skill read = .agents/skills/using-s2-agent-skills/
  SKILL.md (the repo gate); the gate's own text declares itself the trigger
  layer ("On ANY of these situations, READ + follow the named ext SKILL.md
  first"; Tickets gate routes "via ask-matt when unsure; to-spec then
  to-tickets"). F3 leaning: intended. t06 rules on evidence.
- Promotion surface: wayfind/scripts/ exists (effort-audit.ts,
  probe-ext.ts, sweep-zero-citation.ts); allowlist contract =
  devops/tests/scripts-dir-contract.test.ts (precedent :36, test :120).
- Evidence caps: receipt 4KB + session 30KB fit CONVENTIONS' 256KB/1MB
  evidence tier — the prior arc was output/-only; this arc commits the
  load-bearing bytes (D7).
- Collision: sibling audit-gate-fidelity (t02/t03 pending) touches devops
  local_ci + ext package.json — this arc touches neither (promotion = new
  wayfind files + ONE devops TEST-file allowlist line).
- Naming: content slug (self-arc-21 claimed by sibling #2257).

## Tickets

- [x] t01 open effort + pin re-verify + smoke (this commit + smoke receipt)
- [x] t02 same-turn-batch-aware detector (scratch) + 4 zero-token validations
- [x] t03 C2 settle: leg-2 bytes re-adjudicated + fresh leg 3 (D3 rule)
- [x] t04 C1 salience 5-probe (D4 pre-committed branches)
- [x] t05 gemma quiet-window column (D5 precondition-gated, defer fallback)
- [x] t06 F3 repo-gate ruling + C5 expectation re-set (D8, read-only)
- [x] t07 harness promotion → wayfind/scripts/ + allowlist line + regression test
- [ ] t08 close-out: matrix deltas, Completed-by link on the A/B map,
      reviewer GLM-5.3, PR chain, status flip in landing PR, successor

## Decisions so far

- D1 scope: items 1,3,2,5+7(merged),6 in; session_compact DEFERRED with
  reason (long-session cost, no verdict depends on it) — successor list.
- D2 detector semantics FROZEN: every toolCall gets (msgLine, callOrdinal);
  C2 COMPLIANT ⟺ skill-read exists ∧ (no mutation ∨ firstRead.msgLine <
  firstMutate.msgLine); same-message = NON-COMPLIANT; bash mutating ONLY on
  an explicit write-operator list (>, >>, tee, sed -i, rm, mv, cp, mkdir,
  touch, patch, ln -s, heredoc-to-file, git commit/checkout/switch/rebase/
  merge/stash/restore, bun add/remove/install, npm i/install/remove,
  chmod/chown, dd, pip install); recon (ls/cat/rg/head/stat/test/echo sans
  redirect) non-mutating; unknown → non-mutating but recorded in
  detected.bashCalls[] for human audit. C3 compares (msgLine, callOrdinal)
  lexicographically.
- D3 settled C2 rule: leg-2 bytes re-adjudicated AND fresh leg 3 both
  COMPLIANT → CLOSED-PASS; leg 3 true same-turn batch → NON-COMPLIANT
  finding; no prompt re-rolls.
- D4 C1 branches pre-committed: ≥4/5 YES → noise, no fix; 3/5 → marginal,
  note instrument resolution; ≤2/5 → behavioral-evidence branch (t03 landed
  first): behavioral firing → retire self-report as a salience detector
  (map decision); behavioral miss too → ONE strengthening line
  (getBootstrapContent, F2 precedent) + paired receipt. Never more than one.
- D5 gemma precondition: 3 consecutive /v1/models polls ≥60s apart with
  gemma resident AND ≤1 large chat model total; then C2/C3/C5/C8 (+C4
  stretch), ≤2 legs/cell; max 2 windows; else dated defer (blocker is
  sibling-owned).
- D6 promotion in, package.json out: drive-case.ts + battery →
  wayfind/scripts/, ONE allowlist line in the devops tests file; no
  package.json edits anywhere.
- D7 verdict flips cite .planning/2026-09-10-spwf-ab-closing/evidence/
  (receipts + load-bearing session JSONLs), never output/ alone.
- D8 F3 ruling evidence-bound: intended → C5 expectation becomes read-any
  {using-s2-agent-skills, to-spec, to-tickets, ask-matt} and the existing
  C5-glm receipt is re-adjudicated (no new leg); defect → issue filed, fix
  deferred to successor.

## Frontier

- t02 is the frontier: every verdict flip and the promotion hang off the
  detector; pure byte work, zero tokens, goes first.

## Fog of war

- zai stall recurrence (→ SKIP, preserved); LM Studio churn windows (t05
  gated); `current` moving (pinned dirs immune); sibling devops/package.json
  churn (rebase only); C1 ≤2/5 branch depends on t03 — run t03 first.

## Cross-effort links

- Builds-on: 2026-09-10-spwf-drive-ab — closes its PARTIAL verdict and its
  detector limitation; will carry `Completed-by:` this effort.
- Shares-decision-with: 2026-09-09-superpowers-wayfind-drive — detector
  lineage (F0a/F0b → batch-aware indexing).

## Verdict deltas + findings (2026-09-10, evidence under evidence/)

- **C2-glm: CLOSED-PASS (D3)**. Leg-2 bytes re-adjudicated under the fixed
  detector: COMPLIANT (read msg5:0, write msg8 — read-only bash recon is not
  a mutation). Fresh leg 3 (evidence/c2-leg3-*): read ✓ order ✓ pin ✓. The
  F2 bootstrap directive works AND the model complies; the A/B map's PARTIAL
  was the detector, not the model.
- **C5: re-verdicted PASS (D8, F3 ruling INTENDED)** — the repo gate's own
  text declares it the trigger layer and routes "via ask-matt when unsure;
  to-spec then to-tickets" — exactly what the C5-glm session did. Expectation
  re-set to read-any {using-s2-agent-skills,to-spec,to-tickets,ask-matt};
  existing receipt re-adjudicated PASS; one clarifying line added to the
  gate doc.
- **C1: 5/5 YES** (D4 ≥4/5 branch) — bootstrap salience is sufficient; F1's
  earlier NO was self-report noise. No fix. Self-report remains a weak
  instrument; the matrix keeps behavioral detectors primary.
- **gemma: DEFERRED with dated reason (D5)** — precondition failed 3/3 polls
  (22:06–22:08: gemma resident but 4 large models total vs ≤1 required;
  sibling-owned LM Studio churn). Window 2 not attempted after t07; the
  cells stay UNTESTED-infrastructure in the A/B matrix.
- Harness PROMOTED (D6): wayfind/scripts/drive-case.ts (exports
  detectFromLines; import.meta.main-guarded) + spwf-battery.sh + one
  allowlist line; tests/drive-case-detector.test.ts locks the four
  semantics. Wayfind gates 536/0; devops contract test green; zero
  package.json edits.

## Shipped-as (2026-09-10)

- PR <impl>: the closing deliverables above.
- This PR flips the map done per CONVENTIONS.
