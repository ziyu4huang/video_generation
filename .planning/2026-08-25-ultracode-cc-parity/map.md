---
effort: 2026-08-25-ultracode-cc-parity
created: 2026-08-25
last: 2026-08-25
status: charted
---

# ultracode CC-parity — make ext-ultracode behave like claude-code ultracode

## Destination

When ultracode is armed (`/ultracode`, `/effort high|ultra`, or the `ultracode`/`workflow` keyword), the host model receives claude-code-equivalent ultracode guidance: a standing author-by-default directive with a solo carve-out, a scale-to-request ladder, the quality-pattern catalog inline (not behind `workflow_help`), multi-phase sequencing guidance, a `synthesize()` fan-in helper in the stdlib, and no silent capability caps (clamps are logged). Runtime primitives are already at or beyond CC parity — this effort is guidance-layer + two small runtime additions, verified by unit tests pinning the injected text and one real e2e smoke run.

## Context

Measured 2026-08-25 on this machine (branch off origin/main @ 3d1ac80d; two read-only explore agents over `bun-apps/s2-agent-ext-ultracode/`, user scope-confirmed G1–G5 below, G6 rejected).

### Already at parity (NOT re-built here)

- Primitives: `agent/parallel/pipeline/phase/log/workflow/budget` globals (src/workflow.ts:372-401) + CC-absent extras (`checkpoint()`, `call()`, `isolation:"worktree"`, per-agent hard `tokenBudget`/`spendBudget`, journal resume).
- Quality patterns all exist as stdlib (src/workflow-stdlib.ts:99-237): `verify()` (N refuters + majority kill + `lens` perspective diversity), `judgePanel()`, `loopUntilDry()` (dedup + `truncated` flag), `completenessCheck()`, `retry()`, `gate()`.
- Budget directive `+500k` parses (src/budget-directive.ts:22-35) and is a BINDING floor — `max(directive, tokenBudget)` enforced at run entry (src/workflow-manager.ts:520-536).
- Standing opt-in exists: `/ultracode` = `/effort ultra` alias (src/effort-command.ts:68-86), `ultracode` keyword trigger (src/config.ts:34), forced-workflow transform on armed substantive messages (src/workflow-editor.ts:496-534).
- Caps: 16-concurrent / 1000-total backstop (src/config.ts:6-15).

### Gaps (the work)

- **G1 — armed guidance is thin.** ULTRA directive is two lines of generics (effort-command.ts:29-30); the quality-pattern catalog is deferred to `workflow_help` in the default guideline set (workflow-tool.ts:270) and only inlined in verbose mode; no "author by default / solo carve-out" framing anywhere (there is deliberately no `token cost is not a constraint`-style line; the baseline budget bullet says the opposite, workflow-tool.ts:265 — correct for baseline, absent for armed).
- **G2 — no scale-to-request ladder.** CC: "find any bugs" → few finders + single-vote verify; "thoroughly audit" → wider pool + 3–5-vote adversarial + synthesis. Pi has only HIGH/ULTRA tier prose, no graduated mapping (effort-command.ts:27-30).
- **G3 — no multi-phase sequencing guidance.** CC: multi-phase work → several workflows in sequence, one per phase, back in the loop between. Absent from every guideline set.
- **G4 — no `synthesize()` stdlib helper.** Fan-in is prose-only ("include a final synthesis/assertion agent", workflow-tool.ts:298 in verbose set only).
- **G5 — silent caps.** `normalizeConcurrency` clamps silently (workflow.ts:433-436); no no-silent-caps logging contract.
- **G6 — multi-modal sweep pattern: REJECTED by user 2026-08-25** (this repo is single-modality code work; low value).

Baseline (non-armed) "use workflow only when the user explicitly asks" (workflow-tool.ts:258/283) stays — CC ultracode is also opt-in; pi's arming mechanism is the structural equivalent. No flip.

## Tickets

**Execution order:** 01 → 02 → 03 — user-confirmed 2026-08-25 (scope answer G1–G5 implies guidance-first; no blocker edges; 03 last so the e2e smoke validates 01+02 output end-to-end)

### Phase A — guidance layer

- [ ] 01 — Armed-guidance CC parity: rewrite HIGH/ULTRA directives (effort-command.ts), thread `effortLevel` through `buildWorkflowGuidelinesForTurn` (workflow-tool.ts) with a `buildUltracodeAddendum` block — standing author-by-default + solo carve-out, scale ladder, multi-phase sequencing, inline pattern catalog; wire in extensions/ultracode.ts `before_agent_start`; unit tests pin the strings. (executed 2026-08-25 branch chart/ultracode-cc-parity, PR #2016; gates 1182/0 + local_ci 103s; reviewer APPROVE_WITH_NITS, nits applied; merge pending)
- [ ] 02 — `synthesize()` stdlib helper (workflow-stdlib.ts): fan-in agent (big-tier default) with compact `{ok, verdict, summary}`-shaped result; guidance wired into `workflowHelpersDoc` + verbose bullet + `workflow_help` patterns topic; tests in quality-stdlib.test.ts.

### Phase B — caps + verification

- [ ] 03 — No-silent-caps: log concurrency clamp in/after `normalizeConcurrency` and the 1000-total / maxAgents clamp at dispatch (workflow-runtime.ts:214-220 seam) so a clamped run says so in its log; run `samples/smoke-e2e.ts` once (PI_MODEL local) as the real-path e2e receipt.

## Decisions

- **D1 — Guidance layer only for parity; runtime primitives are NOT rebuilt** (explore evidence: parity or better already; effort confined to G1–G5).
- **D2 — Baseline only-when-asked guidance stays inverted-off** — CC ultracode is opt-in too; arming (keyword / effort / slash) is where CC-parity guidance lands. Rejected: flipping the default guideline bullet (would tax every session, not just armed ones).
- **D3 — Forced-prompt "ONLY acceptable action is run_workflow" mechanics untouched** (workflow-editor.ts:297-318) — it is the anti-loose-interpretation guard; the solo carve-out lives in the effort directive/addendum where it can't weaken that guard.
- **D4 — G6 (multi-modal sweep) rejected by user 2026-08-25** — single-modality repo.
- **D5 — Verification depth: unit-string-pinning + one real smoke-e2e run** (user-confirmed 2026-08-25); no new always-on LLM e2e lane.

## Frontier

Ticket 01 — no blocker; all seams measured (effort-command.ts:27-37, workflow-tool.ts:347-376, extensions/ultracode.ts:212-225).

## Fog of war

- ~~Token cost of the armed addendum~~ RESOLVED t01: measured ≈307 tok over the ≈816-tok simplified set (char/3.8 estimate, 2026-08-25) — at the ≤~300 target boundary; accepted.
- Where `normalizeConcurrency`'s clamp can log to is UNVERIFIED (the clamp happens at workflow.ts:433-436, possibly before the run's log sink exists) — t03 verifies the seam first; fallback = surface in the run's initial status/event record.
- ~~`verify()` default reviewers=2 vs CC's "3–5 vote" phrasing~~ RESOLVED t01: runtime default stays 2; the ladder guidance names the knob explicitly (`verify(item, {reviewers: 3-5, lens})` in ULTRA + addendum, `reviewers: 3` in HIGH) so the model sets breadth per request instead of a silently-raised global default.
- Reviewer pass t01 (independent subagent, 2026-08-25): APPROVE_WITH_NITS, all three nits applied pre-merge — ULTRA directive's "set generous tokenBudget" self-contradiction reworded to "leave tokenBudget unset unless the user set an explicit budget directive"; addendum bullet 1 now says "this supersedes the use-only-when-asked default above" (~10 tok) so the armed-turn coexistence of the two defaults is unambiguous.

## Cross-effort links

- `Builds-on: 2026-08-22-ultracode-rename` — package identity + registry wiring this effort edits inside.
- `Complements: 2026-08-25-s2-agent-simplify-round2` — its D4 kept the engine alive for exactly this "future engine-side effort"; its ticket 02 trims s2-agent's OWN cli surface (orthogonal files, no seam overlap).
