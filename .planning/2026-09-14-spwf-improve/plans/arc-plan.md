# Plan — effort `2026-09-14-spwf-improve`

Written to `output/spwf-improve-plan/plan.md` (planner-receipt precedent). Learnings applied: **#1/#2** (read the deployed artifact before theorizing — this plan's anchor finding exists only because I grepped the shipped bundle) and PB-09 byte-verify. Playbook ids cited inline.

## The anchor finding (NEW — verified red today, not in any prior map)

**The `wayfind_effort` tool description is NaN-mangled; the #455 token-budget guidance sentence has never reached a model.**

- `bun-apps/s2-agent-ext-wayfind/src/effort-tool.ts:228` — a line starting `+"Prefer action:'status' over reading whole map.md …"` (unary plus on a string → `NaN`) follows a line already ending in `" +`. Runtime eval of `makeWayfindEffortTool()`: the description reads `…filterable by effort/status/type). NaNUse this for the mechanical…` — the entire "Prefer action:'status' … can't blow the token budget (failure memory #455)" sentence is deleted, replaced by literal `NaN`.
- **Byte-verified in the deployed tree** `0.10.3+gbee16fd` (where `current` points): `ext/wayfind/ext.cjs` greps `NaN"+"Use` (=1) and `Prefer action:'status' over reading whole` (=0). Live in every boot (PB-09).
- Zero coverage: `tests/effort-tool.test.ts` never asserts description content; tsc/biome pass `+ +"str"`; `rg '^\s*\+ "'` across all three src trees → exactly this one hit.
- The tool was hardened against agents blowing the budget on whole map.md reads (#455) — and the steering sentence is precisely the lost text. Candidate 3 upgrades from "ergonomics, never A/B-tested" to **broken-by-construction, verified**.

## Context (all verified this session, file:line)

- Detector residuals confirmed in `scripts/drive-case.ts`: `detectFromLines` sets `d.firstRead` on **any** skill read (the C2 check `c2Compliant(det.firstRead, det.firstMutate)` therefore anchors to the wrong skill — reviewer #6); `BASH_WRITE_OPERATORS` regexes `(^|[\s;|&])>/>>` cannot match `2>`/`1>>` and lack `git apply|am|clean`, `curl -o`, `perl -pi`, `rsync`, `install`, `truncate`. Fixture set (`tests/drive-case-detector.test.ts`, 5 locks) has neither refinement.
- `session_compact`: re-arm is unit-locked (`superpowers/tests/bootstrap.test.ts:105`) but never driven live; F0a (injection not persisted to store) forces a behavioral detector.
- Battery ready: `scripts/spwf-battery.sh` with frozen C1–C5/C8 prompts, triple pinning, pin dir `0.10.3+gc172fd3`; gemma column cells remain UNTESTED-infrastructure.
- Routing topology verified: `to-spec`, `to-tickets`, `ask-matt` are all `disable-model-invocation: true` (11 of 16 wayfind skills; the 5 visible are content skills — codebase-design, domain-modeling, grilling, resolving-merge-conflicts, wizard); the repo gate `.claude/skills/using-s2-agent-skills/SKILL.md` carries the F3-ruled trigger-layer paragraph. C5-glm PASSED via the gate — no measured gap in the visible-skill descriptions.
- **Map-hygiene finding**: all three predecessor maps (spwf-drive-ab, spwf-ab-closing, selfimprove-playbook) still carry front-matter `status: active` on origin/main, and spwf-ab-closing's `## Shipped-as` holds the literal placeholder `PR <impl>` (real PR: #2266). PB-05's same-PR flip did not happen.
- Collisions: only open PR is #2268 (devops local_ci src + ext package.json) — this arc touches neither. Ledger checked: spwf efforts are unnumbered content slugs; no series claim needed (PB-02).

## Improvement set (weighed with evidence)

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1 | NaN description fix + regression lock | effort-tool.ts:228, runtime eval, deployed grep | **IN — anchor (red today)** |
| 2 | Detector: C2 keyed to expected skill + operator list + fixtures + rescan reproduction | drive-case.ts code; reviewer #6 | **IN** (token-free) |
| 3 | session_compact live receipt | unit-locked, never live | **IN** (1 pty leg, defer path) |
| 4 | gemma column fill | 4 UNTESTED cells; battery + D5 protocol ready | **IN** (precondition-gated) |
| 5 | Prior-map terminal-flip repair + `PR <impl>` → #2266 | three `status: active` maps | **IN** (small hygiene) |
| 6 | C9 paired pre/post adoption legs for the fix | the guidance becomes model-visible for the first time | **IN** (2 cheap `-p` legs) |
| — | Bootstrap beyond F2 | C1 5/5 YES | **OUT** (no-edit decision) |
| — | Wayfind visible-skill descriptions → gate cross-refs | C5 PASS via gate; visible skills aren't planning-flow | **OUT** (no measured gap) |
| — | wayfind_effort schema rework | no red beyond NaN | **OUT** until C9 shows one |
| — | Research-tool agent-surface round | out of family scope | OUT (stays successor #2) |

**Live legs needed?** Yes, but bounded: gemma (≤2 windows), one compact session, two C9 legs. If LM Studio never quiets, items 1/2/5 still ship — majority value is token-free.

## Tickets

- **t01** open effort + PRE-fix receipts: branch, map+tickets; capture NaN evidence (eval slice + deployed grep + planner plan) under `evidence/pre-fix/` **before** the fix (PB-10). PB-01 sync at open.
- **t02** fix + lock: plain concat; test asserts description contains `Prefer action:'status' over reading whole map.md`, no `NaN` splice; wayfind gates; deploy; **pin the new immutable dir** (PB-08); PB-09 grep (`Prefer action:'status'` =1, `NaNUse` =0 in ext/wayfind/ext.cjs).
- **t03** detector refinement: `firstReadBySkill` map, C2 anchors to the `--expect-read` skill; extend operators; fixtures (other-skill-first → NON-COMPLIANT; `2>out.txt` mutating; `git apply` mutating; recon stays clean); `--rescan` the two committed C2 session JSONLs under `.planning/2026-09-10-spwf-ab-closing/evidence/` must reproduce CLOSED-PASS (the refinement gates its own settled verdicts — PB-07 flavor).
- **t04** session_compact live receipt: pty on pinned dir (learnings #3/#4: xterm-256color, ~64-byte awaited chunks, DA answer, kitty silence, first-keypress retry); pre-compact YES → compact → post-compact YES. ≤2 attempts else dated defer (PB-14).
- **t05** gemma column: D5 precondition (3 polls ≥60s apart, gemma resident AND ≤1 large model) **plus** `lms ps` residency per PB-12's catalog-vs-residency clause; ≤2 legs/cell, ≤2 windows, else second dated defer + escalation; gaps never vacuous passes (PB-15).
- **t06** C9 paired legs: frozen neutral prompt with effort-planning vocabulary (the tool is gate-demoted — `GATE_DEFS.wayfind_effort`), pre on old pin, post on t02's pin; toolCall-vs-map.md-read delta is the finding; a non-firing gate is a gate-keywords finding, not a description red (PB-11 pre-registered expectations).
- **t07** conditional content edits ONLY on a fresh neutral-leg RED; bootstrap ≤1 line (F2/D4 discipline); else close considered-rejected with receipts.
- **t08** close-out: matrix delta + findings; map terminal-flip repair (item 5); Completed-by links on all three predecessor maps (PB-16); independent reviewer, blockers fixed same session (PB-06); effort-audit exit 0 (PB-20); devops-chain PR with status flip in the landing PR (PB-05); push-then-successor (PB-03/04); evidence committed under `evidence/` (PB-18); playbook curation delta.

## Decisions

- **D1** anchor-first: the NaN fix is the verified-RED centerpiece; detector rides the same package; live legs follow.
- **D2** fix-only-on-RED extends to ALL model-visible content (bootstrap, skill descriptions, tool schema).
- **D3** PRE/post receipt pairing mandatory for the description fix (t01 PRE → t02 fix → t06 POST on both pins).
- **D4** gemma protocol = D5 + `lms ps` residency; budgets as in the closing map.
- **D5** session_compact detector is behavioral (C1-style self-report) because F0a measured injections don't persist; tier-3 label carried.
- **D6** evidence home `.planning/2026-09-14-spwf-improve/evidence/`; battery raw receipts copied there, not left in `output/`.
- **D7** no devops local_ci src, no ext package.json (sibling #2268); wayfind src/scripts/tests + .planning/ + conditional superpowers skill bodies only.
- **D8** all legs target pinned immutable dirs; `current` resolved-and-recorded only if unavoidable.

## Frontier / fog

**Frontier: t01** — PRE receipts gate the fix's evidential value; t02 gates t06's post leg and the redeploy; t03 is token-free and interleaves.
**Fog:** LM Studio window (sibling-owned, defer path) · pty compact-trigger reliability (defer path, nothing depends) · gate firing on the C9 prompt (finding either way) · sibling #2268 landing mid-arc (rebase only) · minifier folding of the fixed description (verify by grep, never assume).

## Immediate executor sequence

1. PB-01 sync hands-on; baseline `bun run --cwd bun-apps/s2-agent-ext-wayfind test`.
2. Branch + open `.planning/2026-09-14-spwf-improve/` (map + tickets + planner plan under evidence/); commit (PB-17).
3. t01 PRE-fix receipts → `evidence/pre-fix/`.
4. t02 fix + lock + gates + deploy + pin + PB-09 grep.
5. t03 detector + fixtures + rescan reproduction.
6. t04 → t05 → t06 (each with its precondition/budget gate).
7. t07 conditional; t08 close per devops chain + reviewer + validated successor.