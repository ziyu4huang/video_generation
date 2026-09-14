---
effort: 2026-09-14-spwf-improve
created: 2026-09-14
last: 2026-09-14
status: done
---

# Wayfinder map: 2026-09-14-spwf-improve — NaN-mangled tool description + family residuals

## Destination

Planner-led (GLM-5.3, playbook read at open — sha eeabdfb7; receipt
output/spwf-improve-plan/plan-receipt.json). Anchor finding (verified red):
the `wayfind_effort` tool description is NaN-mangled — effort-tool.ts:228
has `+ +"Prefer action:'status'…"` after a line ending `" +`; runtime
description contains `NaNUse this…`; the #455 token-budget steering
sentence has never reached a model (byte-verified in deployed gbee16fd:
`NaN"+"Use` =1, `Prefer action` =0; PRE-fix runtime slice at
evidence/pre-fix/). End state = the fix landed with PRE/post paired
receipts + regression lock; detector residuals closed (C2 keyed to the
expected skill, bash operator gaps); session_compact live receipt; gemma
column precondition-gated fill; prior-map terminal repairs; everything
through the devops chain with a reviewer pass.

## Context (verified 2026-09-14)

- effort-tool.ts:228-229: `…type). " +\n ++"Prefer action:'status'…"` —
  runtime eval: description contains `NaNUse this for the mechanical`,
  `Prefer action:'status'` absent (evidence/pre-fix/runtime-description.txt,
  823 chars, NaN at 700). Zero coverage: effort-tool.test.ts never asserts
  description content. tsc/biome pass `+ +"str"` silently.
- Deployed: current → 0.10.3+gbee16fd; `NaN"+"Use` =1, `Prefer action` =0
  in ext/wayfind/ext.cjs (PB-09 byte-verify, evidence/pre-fix/deployed-grep.txt).
- Detector residuals (drive-case.ts, promoted): firstRead = ANY skill
  (C2 anchors wrong); BASH_WRITE_OPERATORS misses `2>`/`1>>`,
  git apply/am/clean, curl -o, perl -pi, rsync, install, truncate.
- session_compact: re-arm unit-locked (bootstrap.test.ts:105), never live;
  F0a forces a behavioral detector (tier-3).
- Battery ready: spwf-battery.sh (frozen prompts, triple pinning); gemma
  cells UNTESTED-infrastructure.
- Map-hygiene: three predecessor spwf maps still `status: done` on
  origin/main; spwf-ab-closing Shipped-as holds the literal `PR <impl>`
  (real: #2266). PB-05 repair in t08.
- Collision: the sibling's OPEN check-split PR (devops local_ci src + ext package.json)
  — this arc touches neither.

## Tickets

- [x] t01 open + PRE-fix receipts (this commit)
- [x] t02 NaN fix + regression lock + gates + deploy + pin + PB-09 grep
- [x] t03 detector: expected-skill C2 anchor + operator list + fixtures +
      rescan reproduction of the settled CLOSED-PASS
- [x] t04 session_compact live receipt (pty; ≤2 attempts else dated defer)
- [x] t05 gemma column (D5 precondition + PB-12 lms ps residency; ≤2
      windows else second dated defer)
- [x] t06 C9 paired legs: effort-planning prompt pre (old pin) / post (new
      pin); toolCall-vs-map.md-read delta = the finding
- [x] t07 conditional content edits ONLY on a fresh neutral-leg RED
- [x] t08 close-out: prior-map terminal repairs (#2266 placeholder), matrix
      delta, Completed-by links, reviewer, PR chain, successor

## Decisions so far

- D1 anchor-first: NaN fix is the verified-RED centerpiece.
- D2 fix-only-on-RED for ALL model-visible content (bootstrap, skill
  descriptions, tool schema).
- D3 PRE/post pairing mandatory for the description fix.
- D4 gemma protocol = D5 + lms ps residency.
- D5 session_compact detector is behavioral (C1-style), tier-3 labeled.
- D6 evidence home: .planning/2026-09-14-spwf-improve/evidence/.
- D7 no devops local_ci src, no ext package.json (the sibling's open check-split PR).
- D8 all legs target pinned immutable dirs.

## Frontier

- t01 PRE receipts gate the fix's evidential value; t02 gates t06's post
  leg; t03 is token-free and interleaves.

## Fog of war

- LM Studio window (defer path); pty compact-trigger reliability (defer
  path); gate firing on the C9 prompt (finding either way); the sibling's open check-split PR
  landing mid-arc (rebase only); minifier folding of the fixed description
  (verify by grep, never assume).

## Cross-effort links

- Builds-on: 2026-09-10-spwf-drive-ab + 2026-09-10-spwf-ab-closing — the
  detector + battery this arc uses; will carry Completed-by.
- Builds-on: 2026-09-11-selfimprove-playbook — playbook read at open
  (PB-01/02/05/08/09/10/11/12/14 applied in this plan).

## Results + findings (2026-09-14)

- **NaN fix landed + byte-verified**: deploy 0.10.3+g11e90db — `Prefer action` =1,
  `NaN"+"Use` =0 in ext/wayfind/ext.cjs (PRE: =0/=1 on gc172fd3; runtime slice
  evidence/pre-fix/runtime-description.txt). Regression lock:
  description-integrity test in effort-tool.test.ts. E2E: all pass,
  model-call skip (contention) — recorded.
- **C9 surprise (honest)**: BOTH pre and post legs used
  `wayfind_effort action:'status'` with ZERO whole-map reads. The NaN'd
  steering sentence had no measured behavioral effect — the per-action
  parameter descriptions (never mangled) carried the routing. The fix is
  still correct (mangled NaN text shipped to every boot was pure
  degradation) but no behavioral red → t07 content edits
  considered-rejected with receipts (evidence/c9-*.json).
- **t03 detector**: C2 anchors to the EXPECTED skill (skillReadPos);
  bash operators + fd-prefixed redirects (null-device exempt — 2>/dev/null
  recon is not a mutation) + reviewer gap classes; settled CLOSED-PASS
  verdicts reproduce under the anchored detector (both leg rescans PASS).
- **t04 session_compact: PASS** (attempt 2; attempt 1's capture window was
  too short) — /compact acknowledged, bootstrap self-report YES
  post-compaction (tier-3 behavioral, F0a-labeled). Receipt:
  evidence/compact-receipt/.
- **t05 gemma column: 2 legs/cell burned, mixed** — C4 PASS, C8 PASS
  (cross-family routing works on gemma too); C1/C2/C3 infrastructure
  ("Model unloaded." churn + canceled requests); C5 degenerated to raw
  token soup (`<|channel>call:skill_manage…`) — model-quality limitation
  recorded per PB-14/15. Escalation note: bench the gemma surface on a
  quiet box or via a resident-model pin before the next attempt.

## Shipped-as (2026-09-14)

- PR <impl>: the NaN description fix + description-integrity test; detector
  refinements (anchored C2, operator classes) + new fixtures; session_compact
  + gemma receipts; prior-map terminal repairs (#2266 placeholder + three
  status flips) + Completed-by links. Deploy 0.10.3+g11e90db (superseded by
  the sibling's newer deploys — the load-bearing bytes were grep-verified at
  deploy time per PB-09).
