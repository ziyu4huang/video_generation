---
effort: 2026-09-09-superpowers-wayfind-drive
created: 2026-09-09
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-09-superpowers-wayfind-drive — live-drive the two methodology families, improve side-by-side

## Destination

User directive (2026-09-09, verbatim): "go next iter of self-develop-arc
focus on imporve s2-agent-ext-superpower/wayfind … do real case by case
experiements then improve side-by-siide". End state = one merged
implementation PR where every live experiment case has a PAIRED receipt:
pre-fix observation (what actually happened when the LIVE agent faced the
prompt — red or green) + post-fix re-run of the SAME case (the delta), plus
the minimal fixes the observations justified. Green/null observations are
recorded as such with no fix. The two families' routing surfaces (skill
description: frontmatter, bootstrap advertisement, keywords/guard tables)
end up driven-by-receipt rather than asserted-by-test. Closes the arc-16
map's four recorded live-agent gaps. Close-out per CONVENTIONS (status flip
in the close-out PR, successor next-goal).

## Context (measured 2026-09-09 late, planner recon + executor verification)

- **Passive detector EXISTS** — session JSONL persists both observables:
  sessions at `~/.pi/agent/sessions/<dashed-cwd>/<ts>_<uuid>.jsonl`
  (`bun-apps/s2-agent/src/cli/sessions/discover.ts:35-45`); 28 of 150
  sessions in this worktree's dir contain the bootstrap marker
  `superpowers:using-superpowers bootstrap for pi` (injected at
  `superpowers/src/superpowers.ts:246`); a skill load is a toolCall
  `read {path: …/skills/<name>/SKILL.md}` in the JSONL. Closes arc-16
  recorded gap #4 passively.
- **Session isolation lever**: `PI_CODING_AGENT_SESSION_DIR` (dist config
  ENV_SESSION_DIR) moves only the sessions dir — t01 verifies on the
  deployed bundle; fallback = per-case scratch cwd + newest-JSONL-by-mtime +
  per-case nonce in the prompt.
- **`-p` print mode persists sessions**; `-ne -ns` fast path is WRONG for
  experiments (suppresses extensions/skills). Legs boot bare, ≤180s cap,
  contention precheck per oneshot-smoke's lesson. Default live model zai/
  glm-5.3 (settings.json).
- **pty vehicle exists**: `subagent/scripts/tui-drive.ts --sh <deployed>/
  s2-agent.sh --out <dir>` — C6/C7 (slash-command bodies, TUI-only) run as
  thin variants. First-keypress eat + settle-detector lessons (#3/#4) apply.
- **Surfaces under test**: superpowers bootstrap = using-superpowers body +
  piToolMapping/piBoundaryOverrides (superpowers.ts:296-320); exclude knob
  PI_SUPERPOWERS_SKILL_EXCLUDE + DEFAULT_SKILL_EXCLUDE (superpowers.ts:46,
  131-152, -ns caveat :203-215); wayfind = /grill + /wayfind commands
  (commands.ts:42,63), keywords.ts + ambiguous guard (:84-96),
  wayfind_effort tool.
- Deployed tree 0.10.3+g8921d19 (src 0.10.3, g8921d19); source acdac0b2;
  gates: wayfind 517 tests, superpowers suite green (arc-16).
- Improvements ranked (D4): ① skill description: frontmatter ② bootstrap
  advertisement (piBoundaryOverrides/piToolMapping) ③ keywords/guard ④
  wayfind_effort description ⑤ exclude-env docs. Minimal + test-backed; no
  wholesale skill-body rewrites (upstream-fidelity tests guard them).

## Case table (the experiment spine)

| # | Case (family) | Prompt / action | Expected | Detector |
|---|---|---|---|---|
| C1 | bootstrap inject (sp) | `-p "Reply with exactly: ok"` bare, source+deployed | marker exactly once among user-role msgs; reply "ok" | JSONL grep |
| C2 | routing→brainstorming (sp) | `-p "I want to add a --spwf-demo flag to scripts/hello.ts that echoes its value. Start by naming the skill you are using, then proceed."` | brainstorming SKILL.md read BEFORE any edit toolCall | toolCall path+order |
| C3 | skill-shaping→TDD (sp) | `-p "Implement is_leap_year(year) as a new scratch module under output/spwf-drive/scratch/ with tests."` | TDD skill read; test file written BEFORE impl | toolCall order |
| C4 | exclude-env authority (sp) | C2's prompt + `PI_SUPERPOWERS_SKILL_EXCLUDE=!,brainstorming` + `-ns` | brainstorming NOT read; bootstrap still injected | JSONL absence+marker |
| C5 | routing→ask-matt (wf) | `-p "I'm mid-effort under .planning/ and can't remember whether my settled grill output should go through to-spec or to-tickets — which wayfind flow fits, and what do I read?"` | ask-matt SKILL.md read | toolCall path |
| C6 | keywords/guard (wf) | pty: `/wayfind help`; `/wayfind status <done effort>`; bare non-keyword phrase w/ active effort | help table; frontier read-only; guard message | snapshot grep |
| C7 | /grill flow body (wf) | pty: `/grill me spwf-drive-probe` → one exchange → `/grill done` | started notify, overlay line, ONE question; done clears overlay | snapshot + tree diff |
| C8 | cross-family boundary (sp→wf) | `-p "The grill settled and spec exists but no plan — what's the next artifact and which skill owns it?"` | writing-plans (sp) cited/loaded, NOT to-spec | read path + reply |

## Tickets

- [x] t01 harness + census + baseline: `output/spwf-drive/drive-case.ts`
      driver (precheck, isolation per D3, JSONL detectors, per-case
      receipt.json) + pty variant off tui-drive; verify isolation tier;
      census (what a bare repo-root boot actually advertises); 8 baseline
      receipts (C1 on both legs)
- [x] t02 superpowers -p batch: C1–C4 + C8 findings → minimal fixes (D4
      rank) → gates → redeploy → re-run same cases → paired receipts
- [x] t03 wayfind -p batch: C5 + unit gaps → fixes → gates → redeploy →
      paired re-run
- [x] t04 pty command-body batch: C6–C7 → fixes → redeploy → re-run with
      snapshots diffed (≤3 iters/case)
- [x] t05 close-out: map done + Shipped-as (status flip in the close-out PR
      per CONVENTIONS), reviewer, PR chain, successor next-goal

## Decisions so far

- D1 name = content slug (self-arc-N retired by #2236).
- D2 detector hierarchy: (1) passive JSONL grep (marker / read-path /
  toolCall ORDER); (2) pty snapshot grep; (3) LAST resort self-report proxy,
  always labeled. Receipts name the tier used.
- D3 isolation: PI_CODING_AGENT_SESSION_DIR per case; fallback scratch cwd +
  newest-JSONL + nonce.
- D4 lever ranking (evidence-driven fixes; description frontmatter first).
- D5 batch = run → findings → fixes → gates → redeploy (deploy-cli, auto
  verify-deploy-e2e) → re-run SAME cases → paired receipts. Source+deployed
  twins where a fix shipped; C1 both legs at baseline.
- D6 budget honesty: ≤3 iterations/case, ≤2 model legs/iteration; residual
  reds recorded as gaps with preserved receipts; contention precheck every
  leg; never prompt-engineer the case to fake a pass.
- D7 scratch stays scratch (output/spwf-drive*/ never committed).

## Frontier

- PI_CODING_AGENT_SESSION_DIR on the DEPLOYED bundle — unverified (t01).
- Run-dir skill-advertisement scope at repo root — t01 census decides C2/C5
  phrasing.
- session_compact re-injection — out of budget this arc, stays recorded gap.
- glm-5.3 routing fidelity is the VARIABLE under test — reds are findings,
  not harness bugs; never "fix" by prompt-engineering the case.

## Fog of war

- The sibling session may redeploy mid-arc — receipts resolve the `current`
  symlink and record the label at run time.
- pty flakiness (first-keypress eat, settle detection) — tui-drive's lessons
  encoded; still expect iteration.
- Detection greps depend on JSONL schema stability — pinned by t01's census.

## Cross-effort links

- Builds-on: 2026-09-09-self-arc-16 — closes its four recorded live-agent
  gaps with the paired-receipt discipline it established.
- Shares-decision-with: 2026-09-08-self-arc-13 — receipts-before-fix
  ordering (read what actually shipped/drove before changing it).

## Findings + paired receipts (the experiment record)

Detector corrections (t01, measured — plan-deviations recorded):
- F0a: the superpowers bootstrap injection does NOT persist to the session
  JSONL (context-event rewrite lives only at the LLM-request layer; 5,813
  session files scanned, zero user-role markers — all hits are agents reading
  the source). C1's detector = machinery probe (probe-bootstrap.ts: real
  factory via jiti, session_start → context injects marker at messages[0],
  PASS) + model-visible self-report (both legs YES). C1 GREEN, no fix.
- F0b: PI_SESSIONS_DIR moves the session READER (discover.ts), not the
  writer — isolation by per-case nonce pinning in the default dir instead.
- Harness bugs found by the harness's own first run: Bun.spawnSync ignores
  `timeout` (manual kill); empty-checks receipts said RED (now UNSPECIFIED).

Case results (receipts under output/spwf-drive/{baseline,postfix}/, scratch):
- C1 bootstrap inject: GREEN both legs (g2e95efa / pinned dirs). No fix.
- C2 routing→brainstorming: GREEN behaviorally (C2b: brainstorming+TDD read,
  skills named, work done red→green in 119s). Two earlier legs stalled 13-19
  min on provider-side saturation (4 LM Studio models resident recorded; the
  default boot model is REMOTE zai so local residency is informational) —
  receipts preserved, driver now caps legs at 300s with a manual kill.
- C3 TDD shaping: PASS (tdd SKILL.md read; test-first order weakly checked).
- C4 exclude-env: PASS — PI_SUPERPOWERS_SKILL_EXCLUDE=!,brainstorming + -ns:
  brainstorming never read, TDD fallback, 72s. Knob authoritative (arc-16
  recorded gap #3 closed).
- C5 ask-matt routing: behavioral GREEN, expected-observable MIS-SPECIFIED by
  the planner: ask-matt (and to-spec/to-tickets) are disable-model-invocation —
  invisible to the model's skill list BY DESIGN (wayfind = user-driven family;
  superpowers = model-driven: 16/16 visible). The model answered the flow
  question correctly via leaf-skill descriptions. No fix justified.
- C6 keywords/guard (pty): RED → RED → **PASS**. TWO product defects found:
  - F-C6a: the ambiguous-phrase guard's notify fired BEFORE the status
    handler's own notifies and was never visible (toast pane keeps latest).
    Fixed 95f1d2ad (render status first, guard note last).
  - F-C6b: bare-/wayfind adoption rendered "adopting <effort>" but bound
    activeEffortBySession only after a successful claim — with nothing
    claimable the guard's precondition stayed void and `/wayfind <phrase>`
    charted a junk effort dir (observed live: 2026-09-10-what-should-i-...,
    deleted). Fixed 88611db1 (bind at adoption). Post-fix paired run on the
    pinned deploy g88611db: ALL 9 checks PASS, no junk charting.
- C7 /grill flow body (pty): PASS both legs (started notify, overlay, one
  exchange, ended) — arc-16 recorded gap #1 closed green.
- C8 cross-family boundary: GREEN in 21s — the model answered from the
  bootstrap's routing table verbatim (spec-exists → PLAN → writing-plans,
  "Superpowers owns DESIGN/PLAN/EXECUTE; Wayfind DECIDE/SYNTHESIZE") with no
  file read — arc-16 recorded gap #2 (bootstrap injection) behaviorally
  proven.

Environment findings (recorded, not fixed here):
- The boot's default model resolved to google/gemma-4-12b (LOCAL) — the -p
  behavioral legs ran on it, not zai/glm-5.3; receipts stand for that config.
- `current` is shared mutable state: siblings redeployed g2e95efa → gdd2c922
  → g0bf331a (#2244 lineage) mid-arc; paired legs pin explicit immutable
  version dirs. Deploy-time E2E: one FAIL was my key-less shell (env does not
  persist across tool calls); with the key eval'd the full E2E PASSES
  (0.10.3+g88611db: boot/ext-load/parity/tools/providers/model-call/vision/
  ocr all pass).
- print-idle-watchdog fires late under machine load (300s deadline fired at
  776-1102s) — code correct (5s interval, honest actuals); environmental.
- A bare-chat question made the model invoke wayfind_effort which claimed all
  5 of this effort's tickets (claims by dead session ids) — reverted; a
  caution for driving live agents against the repo's own .planning/.

## Shipped-as (2026-09-09)

- PR <impl>: wayfind guard-note ordering (95f1d2ad) + adoption session-binding
  (88611db1); deployed 0.10.3+g95f1d2a → 0.10.3+g88611db with FULL post-deploy
  E2E pass; wayfind gates 517/0 at every step.
- Honest nulls recorded for C1/C2/C3/C4/C5/C7/C8 (routing and bootstrap
  machinery verified working live — no fix justified by evidence).
- Arc-16's four recorded live-agent gaps: all four now receipted (C1/C8 =
  bootstrap; C2/C3/C5 = routing; C7 = slash-command body; C4 = exclude-env).
