---
effort: 2026-09-09-superpowers-wayfind-drive
created: 2026-09-09
last: 2026-09-09
status: active
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

- [ ] t01 harness + census + baseline: `output/spwf-drive/drive-case.ts`
      driver (precheck, isolation per D3, JSONL detectors, per-case
      receipt.json) + pty variant off tui-drive; verify isolation tier;
      census (what a bare repo-root boot actually advertises); 8 baseline
      receipts (C1 on both legs)
- [ ] t02 superpowers -p batch: C1–C4 + C8 findings → minimal fixes (D4
      rank) → gates → redeploy → re-run same cases → paired receipts
- [ ] t03 wayfind -p batch: C5 + unit gaps → fixes → gates → redeploy →
      paired re-run
- [ ] t04 pty command-body batch: C6–C7 → fixes → redeploy → re-run with
      snapshots diffed (≤3 iters/case)
- [ ] t05 close-out: map done + Shipped-as (status flip in the close-out PR
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
