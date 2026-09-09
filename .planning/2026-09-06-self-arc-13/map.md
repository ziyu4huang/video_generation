---
effort: 2026-09-06-self-arc-13
created: 2026-09-08
last: 2026-09-09
status: done
---

# Wayfinder map: 2026-09-06-self-arc-13 — base-tech benchmark: which driver tech drives the self-develop arc

## Destination

One merged implementation PR adding a committed, four-lane **base-tech benchmark** under
`bun-apps/s2-agent-ext-subagent/scripts/` that drives the **DEPLOYED**
`s2-agent.sh` (`/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh`)
through four adapters — **bun-terminal** (incumbent `Bun.spawn` `terminal` lane),
**bun-pty** (raw-pty via macOS `script(1)`), **tmux**, and **rpc** (`--mode rpc` JSONL) —
over one shared case registry (boot, trivial-ask, subagent-dispatch, state-probe,
tui-gesture, robustness-3×), emitting machine-readable per-case receipts under `output/`
(never committed) and a **GENERATED** comparison table (timings, success rates, capability
matrix, adapter LOC) committed under `.planning/2026-09-06-self-arc-13/results/`, plus a
pre-registered, numbers-cited recommendation in this map's Decisions. Docs close-out PR +
validated successor next-goal follow. **Production harness does not change in-arc** — this
is an evaluation arc; a losing incumbent produces a migration *successor goal*, not a rewrite.

## Context

Measured 2026-09-08 on this machine (planner recon; session recon of 2026-09-06 cited where noted):

- **Incumbent harness**: `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts` — 1,416 LOC,
  10 scenarios, `Bun.spawn` `terminal` option (Bun 1.4.2) + xterm-headless + latch engine.
  Full deployed sweep **10/10 green on `0.10.0+g80419f1`** (self-arc-12 Shipped-as,
  receipts `output/sweep12-deployed-*`). Pty rules are PINNED by
  `tests/tui-drive-hardening.test.ts` (TERM forcing, 64B awaited chunks, DA/kitty handling,
  settle-on-live-markers-only, key pacing, model policy) — bench adapters must conform.
- **Deployed launcher**: executable, 2,925 B, at the path above (`ls`, 2026-09-08).
  Its `--help` line 22 reads `--mode <mode>  Output mode: text (default), json, or rpc`
  — the RPC lane is real on the deployed tree, not just upstream.
- **Candidate tooling present**: tmux 3.7c (`/opt/homebrew/bin/tmux`), `script(1)`
  (`/usr/bin/script`). In-tree tmux precedent: `scripts/tui-e2e-lane.ts:77–142` —
  `new-session -d -x 200 -y 50 -s <sess>`, `send-keys -l`, `capture-pane -p`,
  `set-option extended-keys on`, `kill-session` cleanup, SKIPPED verdict when tmux missing.
- **RPC protocol surface** (upstream `modes/rpc/rpc-mode.js`, session recon 2026-09-06):
  JSONL commands on stdin — `prompt`, `steer`, `follow_up`, `abort`, `get_state`,
  `get_entries`, `get_last_assistant_text`, `bash`, `export_html`, `fork`/`clone`/`switch_session`, …;
  responses `{id, type:"response", command, success, data|error}` + streamed
  AgentSessionEvents + `extension_ui_request`/`extension_ui_response` for dialogs.
  TUI-only surfaces (/subagents viewer, /workflows navigator, task panel) have **no** rpc
  commands. Deployed-tree message shapes unverified → t03 discovery pass.
- **Bun terminal API reality**: Bun 1.4.x exposes exactly ONE terminal API — the
  `Bun.spawn` `terminal` option ("Bun.Terminal"). There is no distinct `Bun.pty` API at
  the pinned version → lane interpretation is D1 below.
- **Scripts-dir contract**: `bun-apps/s2-agent-ext-devops/tests/scripts-dir-contract.test.ts:23`
  `ALLOWED_RUNNABLE_ENTRIES` snapshot; `scripts/lib/` subtree + `*.test.*` are exempt —
  bench shape = ONE allowlisted runnable entry + libraries in the exempt zone (D10).
- **Canonical gates** (package.json, 2026-09-08): ext-subagent `test` = `check && build && test:unit`
  (+ separate `typecheck`); devops `check` = `tsc --noEmit`, `test` = `bun test`.
- **Model-policy precedent**: children = zai/glm-5.3, NEVER flash, flash excluded BY NAME
  ("glm-5.3" is a substring of "glm-5.3-flash" — learnings-hardening D2); scratch-cwd
  seeding of the `hard-problem` agentType (tui-drive.ts) is the dispatch-case vehicle.

## Tickets

**Execution order:** 01 → 02 → 03 → 04 → 05. 02/03 are a choice pair (no dependency
between them); default 02 first — it reuses t01's ported screen-lane helpers, while 03 is
discovery-heavy. Confirm-or-rechoose at kickoff (to-tickets gate).

**Phase 1 — build (all land in the ONE implementation PR)**

- [x] `tickets/01-driver-cases-bun-terminal.md` — bench skeleton: driver CLI, shared case
      registry + evidence predicates, receipt schema, comparison/scoring generator, and the
      bun-terminal control adapter (minimal ported helpers — port, never import tui-drive.ts);
      boot + trivial-ask receipts vs the deployed launcher; scripts-dir-contract allowlist line
- [x] `tickets/02-bun-pty-tmux-adapters.md` — bun-pty lane (`script(1)` raw pty + plain stdio
      pipes) and tmux lane (new-session/send-keys/capture-pane, per tui-e2e-lane precedent);
      each green on boot + trivial-ask vs deployed; quirks documented
- [x] `tickets/03-rpc-adapter.md` — rpc adapter: discovery pass first (capture REAL deployed
      JSONL shapes as committed fixtures), then boot/state/prompt-roundtrip/subagent-dispatch
      via the event stream; unreachable TUI surfaces documented with evidence

**Phase 2 — evaluate**

- [x] `tickets/04-matrix-run-recommendation.md` — full 4-lane × case matrix + robustness 3×
      against the deployed tree; `--all` generates comparison.json/md; generated artifacts
      committed under `results/`; recommendation recorded as a map Decision citing the numbers

**Phase 3 — close-out (separate docs PR)**

- [x] `tickets/05-closeout.md` — Shipped-as, reciprocal cross-effort links, docs note if
      warranted, validated successor next-goal (migration goal iff incumbent lost), learnings
      entries for any new confirmed quirk

## Decisions

- **D1 (2026-09-08) — lane interpretation**: "Bun.Terminal" = the incumbent
  `Bun.spawn` `terminal`-option lane; "Bun.pty" = the RAW-PTY lane: external pty allocator
  `script -q /dev/null <sh>` (child gets a real tty) driven over plain stdio pipes, NO Bun
  terminal API. Grounds: Bun 1.4.x ships exactly one terminal API (measured via the pinned
  harness); the raw lane answers the real question "should the loop depend on Bun's
  terminal API at all". Arbitration: if `script(1)` proves unusable on macOS (BSD quirks),
  record the evidence and mark the lane N/A — do NOT silently reinterpret mid-arc.
- **D2 (2026-09-08) — one driver, four adapters, shared cases**: cases are defined by
  evidence predicates ("sentinel rendered AND no live markers"), never by screen bytes;
  each adapter maps predicates onto its lane's native evidence (rendered text, capture
  diff, protocol events). Asymmetries become capability-matrix rows, not test flakiness.
- **D3 (2026-09-08) — port, never import**: tui-drive.ts is a side-effectful script
  (top-level driver — importing it RUNS a drive). The bench reimplements the small helpers
  (xterm-headless shim load, 64B awaited feeder, DA responder, latch engine, scratch
  seeding). Production harness untouched; the two may diverge freely.
- **D4 (2026-09-08) — pre-registered settle semantics per lane** (learning 5): screen
  lanes (bun-terminal, bun-pty, tmux) settle = answer latch present AND live markers
  (spinner frames / `Working…` / `esc to interrupt`) ABSENT — transcript text is never a
  settle signal; tmux ADDITIONALLY requires two consecutive stable `capture-pane` frames
  ≥300 ms apart (spinner churn defeats naive latches). rpc settles on PROTOCOL completion
  (response envelope + turn-done event) — no screen semantics exist there.
- **D5 (2026-09-08) — model honesty**: every lane forces zai/glm-5.3 (ZAI_API_KEY parsed
  from ~/.zshrc when not exported, injected into the child env); state-probe asserts the
  model line; flash excluded BY NAME in every receipt check (shares learnings-hardening D2,
  narrowed per self-arc-12 D5: glm-5.3-only, no flash floor).
- **D6 (2026-09-08) — receipts generated, table generated**: per-tech per-case
  `receipt.json` under `output/bench13-<tech>-<sweep>/` (scratch, NEVER committed);
  `--all` emits `comparison.{json,md}`; the comparison table committed under this effort's
  `results/` is the generated artifact, and the recommendation cites its numbers — nothing
  hand-written.
- **D7 (2026-09-08) — pre-registered decision rule** (full rubric in spec §8): eligibility
  = robustness 3/3 on trivial-ask with no adapter-crash failures; numeric score over
  evidence-fidelity 0.30 / robustness 0.30 / async-event-visibility 0.15 / latency 0.15 /
  simplicity 0.10, computed per-lane over the criteria it is structurally capable of
  (denominators reported, never hidden). **Rendered-truth capability is REQUIRED for the
  production-harness role** (today's loop receipts ARE rendered truth — arc-12 sweeps);
  rpc therefore competes for a **structured-complement** verdict (recovery/verification
  passes, cf. learning 6's fresh-process CLI twin) unless no screen lane reaches
  eligibility. A challenger beats the incumbent (bun-terminal) only on >10% score margin;
  ties keep the incumbent. If the incumbent loses, the outcome is a MIGRATION SUCCESSOR
  GOAL — never an in-arc production rewrite.
- **D8 (2026-09-08) — N/A ≠ FAIL**: structural capability absence (rpc tui-gesture; screen
  lanes' structured data) is recorded as evidence feeding the matrix, never as a red case —
  the capability matrix's asymmetries ARE deliverables.
- **D9 (2026-09-08) — deployed-artifact discipline** (learning 1): receipts record the sh
  path + deployed version string; adapters only ever SPAWN the launcher with flags — the
  deployed tree is read-only. If a deployed arm misbehaves, grep the deployed artifact for
  the expected symbol BEFORE theorizing; never delete a failing receipt.
- **D10 (2026-09-08) — scripts-dir shape**: one runnable entry
  `scripts/bench-base-tech/bench.ts` (allowlist line in devops'
  `scripts-dir-contract.test.ts`); all adapters/cases/lib code under the contract's exempt
  library path (t01 verifies the exact exemption match — `scripts/lib/` subtree per the
  contract header — and pins it); unit tests in `tests/bench-base-tech.test.ts`.

## Frontier

`tickets/01-driver-cases-bun-terminal.md`: the case registry + Adapter interface is the
surface every other ticket mounts on, and the bun-terminal arm is the CONTROL — a
known-good lane (10/10 sweep) that validates the abstraction against reality before any
new tech is wired in. Fastest path to a green deployed receipt; de-risks t02/t03 shape.

## Fog of war

- **Deployed rpc JSONL shapes**: recon read UPSTREAM source; the deployed tree may lag or
  differ — t03's discovery pass captures ≥20 real lines as committed fixtures before any
  adapter logic is trusted.
- **tmux settle-by-capture-stability**: unproven against real spinner churn; t02 validates
  and may fall back to marker-regex + stability hybrid (D4 records whichever held).
- **`script(1)` BSD quirks**: CRLF translation, `-q` semantics, relay pacing — whether the
  64B chunk rule must apply to OUR stdin or only to the xterm-headless feed; t02 documents
  with snaps.
- **Extensions under rpc**: whether run-dir `.pi/agents` (hard-problem agentType) loads in
  rpc mode — determines if subagent-dispatch is N/A-with-evidence there (D8) or a real arm.
- **Notification visibility under rpc**: which AgentSessionEvent (if any) carries
  background-child completion — probed in t03.
- **ZAI key + model routing under rpc**: state-probe case verifies; if rpc boots a
  fallback model, that is a receipt-visible FAIL per D5.
- **Contract exemption path detail**: exact matcher for the lib exemption — read the
  contract test before choosing the directory (t01, D10).

## Cross-effort links

Builds-on: `2026-09-06-subagent-tui-cc-parity-2` (the Bun.Terminal harness, D1 pty
learnings, D2 model wiring — this arc benchmarks its lane), `2026-09-06-learnings-hardening`
(operating learnings → hard-problem agentType + tui-drive-hardening pins the bench must
conform to), `2026-09-06-self-arc-12` (latest harness state: rendered-truth boot gate,
verified submit, dual-latch; cc-parity scenario + model policy D5),
`2026-09-06-self-arc-9` (planner-led arc shape + dual source/deployed receipts discipline).
Shares-decision-with: `2026-09-06-learnings-hardening` D2 (flash-by-name exclusion — D5 here).
Reciprocal back-links added to those maps at close-out (ticket 05).

Back-links: this effort extends the tui-drive harness decision lineage (arc-8/9/10/11/12 maps) and answers the base-tech question those maps assumed — see their maps for the harness history that made bun-terminal the incumbent.

## Shipped-as (benchmark results, 2026-09-08)

Deployed tree 0.10.0+g80419f1, nonce s20260908a (+ robustness re-run rb20260908); receipts `output/bench13-matrix-20260908/`; generated tables committed at `results/comparison.{json,md}`.

- **bun-terminal 0.834** — 6/6 cases ✅ (robustness 3/3, 152/151/152ms residuals). Production lane KEEPS the seat.
- **rpc 0.847 (highest total, role-ruled)** — structured complement: 5/6 ✅ (tui-gesture N/A by construction), true turn times 4.7–7.0s, model object `{id:"glm-5.3"}`, notification events visible. Verdict: keep as the fresh-process/structured twin (recovery passes, get_state/get_entries probes), NOT the production driver — today's loop receipts are rendered truth.
- **tmux 0.719** — 6/6 ✅ but fidelity 0.8 (pane scrape, no byte lane), external dep, slower gestures. Clear loser to the incumbent on every criterion that differs.
- **bun-pty N/A** — D1 arbitration FIRED: macOS script(1) hard-fails `tcgetattr` on non-tty stdin (exit 1, zero bytes, evidence in receipts). Lane recorded unusable, no reinterpretation.

Decision D11 (recommendation, pre-registered rules held): production lane stays **Bun.Terminal**; adopt **rpc as a structured complement** in future arcs (successor candidate); no migration.

## Honest notes (recorded, not hidden)

- Latency bias: screen-lane trivial ms are post-verified-submit RESIDUALS (submit blocks 6–12s on its verification waits); rpc ms are true turn times. Cross-class latency comparison is biased toward screen lanes; contained by the 0.15 weight and the role rule; raw ms published in receipts.
- robustness-3x was redesigned mid-arc (defect fix): identical literal repeats made GLM-5.3 drop the exact sentinel on rep 3 on EVERY lane (model compliance, not lane fragility). Reps now carry distinct framing; per-rep lastText/screen evidence added; per-lane re-run overwrote the case receipts. Spec §8 scoring unchanged.
- `--compare` regeneration mode added so per-case re-runs can refresh the tables without a full re-matrix.
