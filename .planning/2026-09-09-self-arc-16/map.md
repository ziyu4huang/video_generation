---
effort: 2026-09-09-self-arc-16
created: 2026-09-09
last: 2026-09-09
status: open
---

# Wayfinder map: 2026-09-09-self-arc-16 — verify arc: wayfind + superpowers families

## Destination

The user directive (2026-09-09): "define your self-develop-arc, focus on VERIFY
s2-agent-ext-wayfind and s2-agent-ext-superpowers, see how far we can do." End
state = one merged planner-led PR that pushes VERIFICATION of the two
skill/methodology families as far as it can honestly go: a per-surface
verification matrix (extension registration, every skill's integrity, unit
suites, probe) executed against BOTH the source tree and the deployed tree with
named-check receipts (`output/self-arc14-*/receipt.json`), fixes for whatever
verification uncovers, and an explicit recorded frontier for what verification
CANNOT reach (live-agent surfaces) — mirroring arc-13's receipts discipline.

## Context

Measured 2026-09-09 on this machine, pre-planner:

- **Both families SHIP already** (registry: superpowers `deploy: { order: 30 }`,
  wayfind `deploy: { order: 40 }` — unlike arc-13, there is no shipping gap to
  close). Deployed tree: `~/proj/dist/s2-agent-sh/darwin-arm64/current` →
  `0.10.1+g9cef1fa` (post-arc-13 redeploy).
- **wayfind**: 16 skill dirs (ask-matt, codebase-design, domain-modeling,
  grill-me, grill-me-with-docs, grilling, handoff,
  improve-codebase-architecture, resolving-merge-conflicts, teach,
  to-questionnaire, to-spec, to-tickets, triage, wait-what, wizard);
  25 test files in `tests/` + `extensions/wayfind.test.ts`;
  `scripts/probe-ext.ts` asserts the FULL registration surface BY NAME in two
  scenarios (enabled; `BUN_PI_WAYFIND=0` registers nothing) and is wired into
  `bun run test` via `test:probe`; `sweep-zero-citation.ts` is the second
  runnable script; `procedures/wayfinder.md`; 6 ADRs.
- **superpowers**: 16 skill dirs incl. brainstorming, executing-plans,
  subagent-driven-development, systematic-debugging, test-driven-development,
  writing-plans/skills, using-superpowers; 12 test files (skills-fidelity,
  artifact-leak [ADR-0009 guard], skill-exclude, bootstrap, references,
  sdd-workspace, find-polluter ×2, update-superpowers, hitl-loop-template,
  superpowers, dispatch…); `scripts/{update,rebaseline-upstream-skills}.ts`
  (+ `scripts/lib/skill-provenance.ts` library); 8 ADRs.
- **Known open seam**: the using-s2-agent-skills gate table routes Ticket/
effort work through the wayfind family "via ask-matt" and Idea/Feature work
through superpowers `brainstorming` → `writing-plans` — these paths have never
been receipted end-to-end from THIS harness.
- Planner machinery proven yesterday (arc-13): `arc-plan.ts` (PASS 320s/372k
  tokens), needs `ZAI_API_KEY` sourced from `~/.zshrc` (not inherited by tool
  shells).

## Tickets

Planner: GLM-5.3 via `arc-plan.ts` (PASS, 259s/164k tokens —
`output/arc-plan-self-arc14/plan-receipt.json`; plan promoted to
`plans/arc-plan.md`, findings F1–F7 cited per ticket).

- [ ] t01 `tickets/01-matrix-source-legs.md` — T1: committed skills-integrity
      (wayfind) + skills-inventory (superpowers) tests + source-leg receipts
      (`output/self-arc16-{wayfind,superpowers}-src-<date>/`)
- [ ] t02 `tickets/02-deployed-legs-prefix.md` — T2: deployed-leg receipts
      PRE-fix: ext dirs, sha256 skills parity, wayfind loadExt + read-only
      execute, superpowers `loadExt-expected-throw` as EVIDENCE;
      commands-surface recorded-gap
- [ ] t03 `tickets/03-standalone-blindness-fix.md` — T3 (fires on F2 evidence):
      standalone.ts records commands + `commands()` + `allowEmptySurface`
      opt-in (default stays fail-loud); redeploy; re-run deployed legs →
      commands-surface flips gap→PASS
- [ ] t04 `tickets/04-contingent-fix.md` — T4: contingent on red receipts;
      closes NO-OP with evidence if clean
- [ ] t05 `tickets/05-closeout.md` — T5: map done + Shipped-as, arc-13
      back-link, collision cross-link with `2026-09-08-self-arc-14`, successor
      next-goal

**Execution order** (planner's): t01 → t02 (PRE-fix evidence — receipt, fix,
re-receipt per arc-13 t01) → t03 (only deploy-needing ticket) → t04
(interleaves wherever a red lands) → t05.

## Decisions

- D1 (2026-09-09): this round is self-arc-16 (renumbered TWICE on 2026-09-09: parallel sessions claimed arc-14 [#2217] and arc-15 [#2224, "merge-chain UX hardening"] while this round planned/executed — this effort is arc-16); the loop's numbering continues
  (arc-13 opened research-tool; 14 opens the two methodology families).
- D2 (2026-09-09): planner-led open per the standing directive (arc-9): GLM-5.3
  via `arc-plan.ts`, `hard-problem`, explicit read budget.
- D3 (2026-09-09): "how far we can do" is a VERIFICATION objective — the arc
  proves what is provable and RECORDS the frontier honestly (live-agent skill
  surfaces may be unreachable without an LLM session; those become recorded
  gaps, not fake passes — arc-13's credentials-gap pattern).

## Frontier

t01 first (no blockers): the two committed integrity tests, then the source-leg
receipt drivers. t02 must complete BEFORE t03 lands so the superpowers
expected-throw and the invisible commands surface are receipted as the PRE-fix
contract.

## Fog of war

- ~~loadExt commands exposure~~ RESOLVED (planner F2 + executor measured):
  `standalone.ts:registrarCollector` records only registerTool; `loadExt`
  throws on zero-tool factories. Executor confirmed live: wayfind loads with
  `wayfind_effort`; superpowers throws the documented zero-tools error;
  `--ext-list` (real boot path) loads BOTH + registers both skills paths.
- ~~Deployed skills parity~~ MEASURED pre-plan (diff -rq): both families'
  deployed skills/ byte-identical to source on the checked tree — t02
  formalizes it as sha256 named checks and re-verifies at receipt time.
- ~~Baseline suites~~ RESOLVED: wayfind `bun run test` exit 0 (check+unit+
  probe, 483 pass), superpowers exit 0 (169 pass) — no pre-existing red (F1).
- Deployed `current` MOVED mid-arc to `0.10.2+g67a7001` (parallel session's
  deploy): receipts must resolve the symlink and record the label at run time.
- Live-agent surfaces (slash-command bodies, session bootstrap injection,
  resources_discover) stay RECORDED-GAP — unreachable without a live session
  (map D3).

## Cross-effort links

Builds-on: `2026-09-08-self-arc-13` (receipts discipline for a no-TUI family —
direct execute + ext-standalone loadExt legs; credentials/env gaps recorded,
never faked), `2026-09-06-self-arc-9` (planner-led shape + read budget).
Shares-decision-with: `2026-09-08-self-arc-13` D3/D4 (live legs via the
consumption surface; no LLM inside gates).
Collision-note: `2026-09-08-self-arc-14` (merged as #2217 by a parallel
session) claimed the arc-14 number first; this effort renumbered to 15 on
2026-09-09 (planner F7). No content overlap — theirs was the B3 workflow
pattern, ours is the verify arc.
Second-collision note: `.planning/2026-09-09-self-arc-15/` ("merge-chain UX hardening", #2224) claimed arc-15 while this round executed — same day, same shape as the arc-14 collision. Loop lesson: round numbers are claimed at MERGE time by whichever parallel session lands first; an executing arc must expect renumbering at rebase.
