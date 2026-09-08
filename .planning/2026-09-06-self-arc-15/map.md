---
effort: 2026-09-06-self-arc-15
created: 2026-09-09
last: 2026-09-09
status: done
# (reconciled 2026-09-09 by self-arc-17 close-out: shipped as PR #2232 — complex benchmark variants, matrix 8/8)
---

# Wayfinder map: 2026-09-06-self-arc-15 — complex benchmark variants: bun-terminal vs rpc, second generation

## Destination

One merged implementation PR extends the arc-13 base-tech benchmark with a
**complex case suite** (`--suite complex`) that stresses the dimensions the base
suite saturated — multi-turn state continuity, mid-flight abort control,
long-output fidelity (scrolled-region latching), and failure-surface honesty —
run **deployed-only** over exactly the two lanes that earned it
(**bun-terminal** 0.834 production seat; **rpc** 0.847 structured complement),
producing a committed generated `results/comparison-v2.{json,md}` (verdict
matrix + dimension table) and a pre-registered, numbers-cited map Decision
answering the user's question: **which approach is better for the self-develop
arc**. Docs close-out PR + validated successor next-goal follow. The arc-14
role-split verdict is the standing hypothesis; this arc STRESSES it, and flips
it only on quantified material evidence.

## Context (measured 2026-09-09 on this machine, read in-tree)

- **Infra is real and extension-shaped** (arc-13 D10): driver
  `bun-apps/s2-agent-ext-subagent/scripts/bench-base-tech.ts` (577 LOC; flags
  `--tech|--sh|--out|--case|--nonce|--skip|--results-dir|--all|--source-tree`
  at :57–76); libs under the contract-EXEMPT `scripts/lib/bench-base-tech/` —
  `cases.ts` (131 LOC, 6 base `CaseDef`s: id/capMs/stimulus/screenPred/rpcPred/
  metric), `types.ts` (90 LOC: `Session`, `SettleView`, `CaseReceipt`,
  `LaneUnavailableError`; `RpcCaseHelper` carries ONLY `lastAssistantText`),
  `adapters/{bun-terminal,rpc,bun-pty,tmux}.ts`, `compare.ts`, `receipt.ts`,
  `screen.ts`, plus committed `adapters/rpc-protocol.fixture.json`. Unit gates:
  `tests/bench-base-tech.test.ts` (141 LOC, 16 test mentions). No new
  scripts-dir-contract allowlist row is needed if the suite extends the
  EXISTING entry + lib subtree (verify in t01 — the contract's `ALLOWED_
  RUNNABLE_ENTRIES` snapshot lives in `s2-agent-ext-devops`).
- **Case shape is single-stimulus today**: `CaseDef.stimulus(nonce)` → one
  submit + one settle predicate. Complex cases need STEP SCRIPTS (submit /
  abort / poll sequences) — a registry extension, not a fork (arc-13 rule:
  "extend it… don't fork it").
- **Standing verdict** (arc-13 Shipped-as, deployed `0.10.0+g80419f1`,
  receipts `output/bench13-matrix-20260908/`, tables committed
  `.planning/2026-09-06-self-arc-13/results/comparison.{json,md}`):
  bun-terminal 0.834, 6/6 ✅ (production seat KEEPS); rpc 0.847 role-ruled
  structured complement, 5/6 ✅ (tui-gesture N/A by construction), true turn
  times 4.7–7.0 s, `data.model` is an OBJECT `{id:"glm-5.3"}`. Arc-14 then
  WIRED rpc as `qualify.ts --rpc-pair` (PR #2223, `0.10.2+g4190dd5`): probe
  cost cheap (1 s boot), pairing scoped to 3 async-lifecycle scenarios.
- **rpc facts, fixture-pinned** (arc-13 t03 + fixture): JSONL commands include
  prompt/steer/abort/get_state/get_entries/get_last_assistant_text/bash; turn
  completion = streamed `agent_settled`; NO workflow pause/resume, NO TUI
  surfaces; background-child notifications surface as notify-ish
  `extension_ui_request` events or via entries/last-text. Error-field shapes
  for FAILED children are NOT yet in the fixture — t01 discovery captures them.
- **Steering exists in the runtime**: `s2-agent-core-runtime/src/agent-turns.ts:92–156`
  — SDK steering queue, `steer(text)` delivered at the idle boundary. Whether
  the DEPLOYED TUI's keystroke path queues mid-turn typing is UNVERIFIED —
  cheap discovery (grep the deployed bundle for the `steer` symbol; property
  names survive minification) decides steer-midturn's fate (D5).
- **Screen-lane pins that complex cases must conform to** (arc-12/13 +
  operating learnings): settle = sentinel present AND live markers absent
  (transcript text never settles); boot gate before first send; paced verified
  submit; freshly-mounted dialogs eat the FIRST keypress; the F-invalidate
  class — rows scroll out, so long-output latching must be CUMULATIVE IN-LOOP,
  never final-frame; TERM=xterm-256color + 64-byte awaited feeds + DA
  answered/kitty silent.
- **Model discipline** (arc-12 D5 → arc-13 D5): children/planner = zai/glm-5.3,
  NEVER flash, flash excluded BY NAME; identical literal repeats make GLM-5.3
  drop sentinels on rep 3 → distinct framing per rep, per-rep evidence.
- **Deployed launcher alive**: `/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh`
  (2,925 B, current mtime 2026-09-09 05:03). Receipts must record the sh path
  + deployed version string (arc-13 D9).
- **Name collision**: `.planning/2026-09-09-self-arc-15/` is a DIFFERENT arc
  (devops merge-chain UX variant). The self-evolve loop keeps the
  `2026-09-06-self-arc-*` prefix (arc-13/14 precedent); always cite full
  folder names (arc-14 map Context records the same rule).

## Tickets

### Phase 1 — build (lands in the ONE implementation PR)

- `tickets/01-complex-registry-and-adapters.md` — step-scripted complex case
  registry (`cx-multi-turn`, `cx-swarm-abort`, `cx-long-output`,
  `cx-error-path`), adapter evidence extensions (esc-abort + cumulative
  latch on bun-terminal; entries/abort/error fixtures on rpc), `--suite
  base|complex|all` driver flag, unit gates. **status: ready**

### Phase 2 — evaluate (same implementation PR, arc-13 precedent: results committed with it)

- `tickets/02-deployed-matrix-comparison-v2.md` — complex matrix, both lanes,
  deployed-only; re-run rule for FAIL→flake separation; generated
  `results/comparison-v2.{json,md}` committed; steer-midturn capability row
  (conditional paired case per D5). **status: gated on 01**

### Phase 3 — close (separate docs PR)

- `tickets/03-verdict-closeout-docs.md` — pre-registered verdict Decision with
  numbers; Shipped-as; reciprocal links on arc-13/14 maps; successor
  next-goal written BEFORE reporting done (hands-off rule). **status: blocked on 01–02**

## Decisions

- **D1 (2026-09-09) — suite scope: 4 scored paired cases + 1 conditional.**
  Scored: `cx-multi-turn` (3 sequential prompts, turns 2–3 must recall turn 1's
  `CXK-<nonce>` code; filler turn must NOT mention it — tests persistence, not
  echo), `cx-swarm-abort` (3 long-sleep background children via spawn_subagent,
  ABORT in flight — screen: `\x1b` via writeRaw once live markers prove
  in-flight; rpc: `abort` command — then poll to all-terminal, cap 120 s
  post-abort), `cx-long-output` (exactly 20 numbered `BENCLONG-<nonce>-<i>`
  lines + `BENCLONG-END-<nonce>`; screen PASS = ≥18/20 DISTINCT lines
  cumulatively latched in-loop + END seen + no live markers; rpc PASS = full
  text line count; evidence records bytesLatched vs bytesReceived), and
  `cx-error-path` (one background child tasked to run a FAILING bash command
  via its bash tool and report only the failure; PASS = failure surface in
  lane-native evidence — screen ✗/failed row or notification; rpc
  entries/notification error field — exact task wording fixed by a t01
  calibration run). Descopes with reasons:
  - **workflow-throws error variant** — arc-14's qualify.ts already owns the
    workflow lane surface (wf-pause + pause-abort honesty); child-error covers
    the failure-honesty dimension without enrolling a second subsystem.
  - **bun-pty / tmux arms** — arbitration (N/A) and loss (0.719) already
    recorded; user directive limits the complex matrix to the two earning lanes.
  - **composite v2 score** — comparison-v2 is a verdict matrix + dimension
    table (continuity / mid-flight control / long-output fidelity / error
    visibility), not a new blend; the verdict rule is materiality-based (D6).
- **D2 (2026-09-09) — extend, never fork**: complex cases live as a NEW
  registry (`cases-complex.ts` under the exempt lib) with a step-script shape
  (`CaseStep`: submit | abort | poll, each with its own predicate + timing);
  the driver gains `--suite base|complex|all` (default `base` — existing
  callers, including qualify.ts's independence, see byte-stable behavior);
  base `CASES` untouched. `RpcCaseHelper` grows data-only fields
  (`entries` snapshot, per-step flags) — predicates stay pure over `SettleView`.
- **D3 (2026-09-09) — evidence size vs fidelity is a first-class metric**:
  every complex case receipt records per-step ms, bytesLatched (screen: bytes
  cumulatively seen at latch) and bytesReceived (rpc: lastAssistantText /
  entries length), and the comparison-v2 table publishes the ratios. This is
  the quantified core of "rendered truth vs structured complement".
- **D4 (2026-09-09) — no new allowlist row by design**: the suite reuses the
  existing `bench-base-tech.ts` runnable entry + `scripts/lib/` subtree;
  t01 re-runs `s2-agent-ext-devops` scripts-dir-contract to VERIFY (if a new
  runnable were unavoidable, its row ships in the same PR — arc-14 D7 rule).
- **D5 (2026-09-09) — steer-midturn is conditional, never verdict-bearing**:
  t01 discovery greps the DEPLOYED bundle for the `steer` symbol (learning 1:
  property names survive minification) + reads the deployed TUI keystroke
  path. If mid-turn typing is plausibly queued → OPTIONAL paired case
  (long-count task + mid-flight `STOP-<nonce>` steer; screen types it, rpc
  sends `steer`); otherwise a capability-matrix row + optional rpc-only probe
  receipt. Either way it cannot flip the verdict alone — the asymmetry is
  already priced into the standing role-split.
- **D6 (2026-09-09) — pre-registered verdict rule** (stress, not re-litigate):
  the role-split stands UNLESS ≥1 complex dimension shows one lane MATERIALLY
  failing (FAIL confirmed by the D1 re-run rule — flake ≠ signal) what the
  other passes structurally. Any numeric score comparison keeps the >10%
  margin discipline (arc-13 D7). A flip produces a successor goal (role swap
  or migration), never an in-arc rewrite.
- **D7 (2026-09-09) — discipline carries**: glm-5.3 only, flash excluded BY
  NAME; distinct framing per rep; receipts record sh path + deployed version
  string; boot gate before first send; paced verified submit; latch-in-loop
  for scrolled regions; never delete a failing receipt — it is the evidence.
- **D8 (2026-09-09) — two PRs, pre-authorized merge**: ONE implementation PR
  (t01 code + t02 generated results committed under this effort's `results/`,
  arc-13 precedent) merged via `gh ship` after local gates
  (`s2-agent-ext-subagent`: check + typecheck + test; `s2-agent-ext-devops`:
  test; schema-cost +0 by construction — scripts + planning only, no
  production schema); then the t03 docs close-out PR. No redeploy required
  (no production src change) — but every receipt records the deployed version
  it ran against; if a production change sneaks in, the arc-12 t05 rule
  (redeploy + re-run deployed legs) fires.

## Frontier

`tickets/01-complex-registry-and-adapters.md` — the step-script registry shape
is the surface t02's matrix, evidence fields, and the verdict dimensions all
mount on; it de-risks the adapters' new evidence needs (esc-abort, cumulative
latch, entries/error fixtures) with unit gates before any live run is spent.

## Fog of war

- **rpc error-field shapes** for FAILED background children — not in the
  committed fixture; t01 forces one real failure and appends the captured
  lines to `rpc-protocol.fixture.json` before any predicate trusts them.
- **Screen long-output latch ceiling** — whether ≥18/20 distinct lines are
  reachable via cumulative in-loop latching at 200×50 with spinner churn;
  if a first live run shows the tail unreachable, the honest fallback is a
  smaller line count with the SAME cumulative discipline (record the measured
  ceiling in the receipt — never relax the predicate silently).
- **Abort timing in cx-swarm-abort** — children must still be in flight when
  the abort lands (sleep-30 tasks, abort at first live-marker confirmation);
  if children routinely finish first, lengthen the sleeps — the case measures
  mid-flight control, not a race win.
- **Deployed TUI mid-turn steering** — D5's discovery decides paired case vs
  matrix row.
- **GLM-5.3 recall reliability on cx-multi-turn** — if the model drops the
  code on BOTH lanes, that is model compliance, not lane fragility (arc-13
  robustness lesson): identical stimulus per lane makes it cancel; the re-run
  rule separates model drop from lane bug.
- **cx-error-path determinism** — the failing-task wording is model-mediated;
  t01's calibration run pins the wording that reliably produces a child
  failure surface, and the receipt records WHICH surface shape appeared.

## Cross-effort links

Builds-on: `2026-09-06-self-arc-13` (the base-tech benchmark, its infra + D7
verdict discipline this arc stress-tests; "extend, don't fork" is its own
rule), `2026-09-06-self-arc-14` (qualify.ts + --rpc-pair — first wiring of the
structured-complement verdict; rpc probe economics), `2026-09-06-learnings-hardening`
(operating learnings 1/3/5 baked into the case designs: deployed-artifact
grep-first, keypress pacing, live-marker-only settle).
Shares-decision-with: `2026-09-06-self-arc-13` D7/D9 (verdict rule + receipt
discipline), `2026-09-06-self-arc-14` D5 (model honesty carries).
NOT the same arc as `.planning/2026-09-09-self-arc-15/` (devops merge-chain
variant — parallel series, same arc number; cite full folder names).
Reciprocal back-links on the arc-13/14 maps land at close-out (t03).

## Shipped-as (2026-09-09)

Complex suite merged (`--suite complex`, `scripts/lib/bench-base-tech/cases-complex.ts`
+ compare-v2 + step machine; 7 new unit gates, 813 total in-package). Deployed matrix
on 0.10.2+g4190dd5: **8/8 green** — see `results/comparison-v2.md` (committed).

| dimension | bun-terminal | rpc |
|---|---|---|
| continuity (turn-3 recall) | ✅ 6.7s | ✅ 4.5s |
| mid-flight control (abort→quiet→recover) | ✅ | ✅ · protocol-ack |
| long-output fidelity | ✅ 20/20 lines · 6498B rendered | ✅ 20/20 · 470B structured |
| error visibility | ✅ 6.7s | ✅ 5.8s |

**Decision D-verdict (map D6 rule applied):** the role-split STANDS and is now
complex-case-proven — with the sharpest evidence coming from the FAILURES: every
red cell across three matrix rounds was a SCREEN-LANE HARNESS defect (predicate
lastText-only with no screen fallback; screenText() returning a FROZEN cache that
direct pollers never refreshed; verified-submit treating a quiet fresh-boot screen
as submitted while the eaten Enter left the prompt in the composer). rpc produced
ZERO harness defects across all rounds — its evidence channel is protocol-shaped,
so it cannot lie about rendering, caching, or submission. Maintenance asymmetry is
the real complex-case signal: the rendered-truth lane keeps demanding pty discipline;
the structured lane does not.

**For the self-develop arc:** bun-terminal remains the production lane (rendered
truth is the receipt standard; TUI surfaces unreachable via rpc), and rpc is the
lower-maintenance structured complement for state/continuity probes. The arc keeps
BOTH (qualify.ts --rpc-pair), not either/or.

## Honest notes

- Three screen-lane harness defects were found and fixed in-arc (pickText fallback;
  live screenText(); composer-region verified-submit). All three predate this arc —
  the base suite never exercised direct screen polling, which is why they hid.
- long-output: rpc receives 470B of structured text vs 6498B of rendered screen —
  the fidelity/size trade made visible (rendered truth costs 14× the bytes).
- steer: deployed bundle carries the symbol ×4; recorded as a capability row
  (rpc protocol command; screen lane relies on pi's steering queue — not scored).
- Model-slow first turns exhausted a 120s step cap once (matrix round 1) — per-step
  caps raised; classified as case calibration, not lane fragility.
