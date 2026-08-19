# Findings: "Wayfind effort state" report — PATH PREMISE MISMATCH + actual state

Investigated: `.planning/2026-08-16-power-browser-tool/` vs the described effort (tickets 04
ratify-skill-cuts, 05–09 open). Repo: `/Users/huangziyu/proj/video_generation__superpowers`.

## 0. Premise correction (READ FIRST)

The described effort is NOT at `2026-08-16-power-browser-tool/`. That dir holds ONLY a
`map.md`, marked **"Status: done"** (different, closed effort: headless-Chrome `browser`
tool for power-tool; single ticket 01 closed; D1–D8 decisions; STATE.md residue folded at
closeout). No `tickets/`, `spec.md`, `plans/`, `sdd/`, `brainstorm/` exist there.

The effort matching the task's tickets (04 `ratify-skill-cuts`, 05–09, wayfind/superpowers/
subagent trio cuts) is:

> `.planning/2026-08-16-simplefied-redesign-make-less-code-to-archive/` (map.md + tickets/01–09)

Also present at `.planning/` root: `findings-wayfind-status.md` — a separate, unrelated
investigation (whether `/wayfind status` is report-only vs agent-triggering; answer: report-only).

## 1. Actual map.md state (simplefied-redesign effort)

- Frontmatter: `status: active`, created/last 2026-08-16.
- Destination: landed, STAGED redesign of wayfind/superpowers/subagent trio — keep ≥80%
  user-facing features per package (feature-count anchor vs ticket-01 census), shrink code/
  prose, subagent FIRST and net-negative LOC despite gaining TUI tracking, then wayfind and
  superpowers skill cuts, each stage merged with gates green.
- Map carries EXECUTION in-map (Plan-don't-do OVERRIDE): staged landings subagent → wayfind → superpowers.
- Tickets 01–04 CLOSED, recorded in "Decisions so far" (this is the resolution log; no
  separate resolution-log section):
  - 01 feature+LOC baseline: features wayfind 39 / superpowers 14 / subagent 15; src LOC
    4,169 / 347 / 7,463 (2026-08-16 snapshot = gate baselines); subagent ≈62% of trio LOC;
    wayfind README stale (says 6 skills, 22 ship); runWatchdog + 3 tool factories zero external consumers.
  - 02 probe cut evidence: wayfind 0/16 ported skills cuttable; superpowers
    verification-before-completion already default-excluded (−241 via rebalance),
    brainstorming companions ungated (−1,014); subagent all KEEP; only trivia cuttable →
    net-negative needs trio-level accounting.
  - 03 ratify subagent cuts: 4× KEEP; cuts = trivia; budget FIRM: Δtrio ≤ −400,
    subagent Δsrc ≤ +800, superpowers Δ ≤ −1,200, features ≥80%/pkg.
  - 04 ratify skill cuts (closed, claimed ratify-session 2026-08-16): wayfind 0/16 cut
    (39/39 anchor); superpowers: DELETE verification-before-completion −241 (runtime-excluded
    already; prose refs left dangling per ADR) + brainstorming companions −1,014 (SKILL.md
    byte-pin kept); Δsuperpowers −1,255 ≤ −1,200; trio gates firm. Full 5-point resolution in
    `tickets/04-ratify-skill-cuts.md` §Resolution.
- Open: 05, 06, 07, 08, 09 (none have status/claimed lines except 04; 06 last touched 18:58,
  07/08/09 + map at 19:15 — tickets 07–09 appear freshly written/re-scoped same evening).
- Not yet specified: subagents-tool.ts (993L) monolith split; batch-fan-out gauges; monitor
  message formats beyond data rendering (deferred).
- Out of scope: render-vocabulary unification; editing upstream-verbatim superpowers bodies
  (ADR); cost-spec workstreams A/B; TUI outside subagent package; persistent cost telemetry.
- Frontier (open, unblocked): none — 05 blocked by 01(closed) → actually unblocked; but 06
  needs 05; 07/08 need 04(closed) → 07/08 likely frontier; 09 blocked by 6,7,8. Frontmatter
  blocking lists: 05←1, 06←1,3,5, 07←4, 08←4, 09←6,7,8. With 01/03/04 closed, frontier ≈ {05, 07, 08}.

## 2. Open ticket detail

### 05 — tui-tracking-design (`type: prototype`, blocking: 1)
- Question: design TUI tracking additions as concrete text mockups (before → after), wired to
  real RunView fields: (a) viewer/dock Running row — live tokens·cost·turns + budget gauge
  (bar or fractional, e.g. `▮▮▮▯ 71% · 340k/480k`); (b) archive row — turns/tier/error/fallback
  fields; (c) singular inline progress header upgraded with token counts + budget/wrap event
  lines; (d) gauge limit source (tier defaults vs calibrated table — coordinate with absorbed
  workstream C).
- Deliverable: text mockups of each surface. No acceptance gates written beyond that.

### 06 — land-subagent-stage (`type: task`, blocking: 1,3,5)
- Land subagent stage = ratified cuts (03) + TUI additions (05) + absorbed cost-spec
  workstream C (wrap-now injection at 85% token budget / maxTurns−3; calibration persistence
  `~/.pi/subagents/budget-calibration.json`, ≥50-run recalibration cadence, precedence
  env > calibrated > frozen) + stale-artifact cleanup.
- Gates: `bun run check && bun test` green; trio-wide net-negative per 03 (Δtrio ≤ −400,
  subagent Δsrc ≤ +800, superpowers Δ ≤ −1,200, features ≥80%/pkg); feature count ≥80%
  (viewer/dock/list/follow/output all survive); runs-DB schema backward-compatible.
- Devops: branch → PR → local CI → gh ship.

### 07 — land-wayfind-stage (`type: grilling`, blocking: 4)
- Re-scoped: skill cuts landed at zero (04: 0/16 KEEP) → src side instead. Probe then ratify
  wayfind src trims — effort-query.ts (354L), architecture-render.ts (329L), stale-seam
  surfaces, README staleness (6 vs 22 skills) — vs trio budget (Δtrio ≤ −400 vs ticket-01
  snapshot). Small ratified trims land here; big items become own landing tickets.
- Output: ratified trim list + Δwayfind number.

### 08 — land-superpowers-stage (`type: task`, blocking: 4) — LANDING SPEC (verbatim)
> Land the superpowers stage per ticket 04: DELETE verification-before-completion (skill dir
> + fidelity fixture + skills-fidelity.test.ts PORTED_SKILLS entry + skills.test.ts
> expected-set entry + rebalance-upstream-skills.ts entry + CONTEXT.md count 14→13); KEEP
> DEFAULT_SKILL_EXCLUDE entry (superpowers.ts:46); LEAVE systematic-debugging L189 +
> writing-skills L401 prose refs dangling (ADR: no upstream-body edits). CUT brainstorming
> companions visual-companion.md + server.cjs (−1,014; SKILL.md byte-pin untouched); sweep
> spec-document-reviewer-prompt.md + scripts/ only if landing-check shows the deleted
> companion was sole referencer. No PI_SUPERPOWERS_SKILL_EXCLUDE default change (already
> excludes v-b-c). Gates: fidelity tests green after edits; features 13/14 = 93%;
> superpowers Δ ≤ −1,200 (−1,255 expected). Devops chain: branch → PR → local CI → gh ship.

### 09 — closeout-audit (`type: grilling`, blocking: 6,7,8) — one-line blocker note
Blocked by all three landing tickets (06/07/08): runs before/after table per package
(features ≥80% vs census, LOC deltas, gates green per merge), verifies workstream-C wrap-now
fires in real dispatch, decides follow-ups, then closing ceremony (`/wayfind done`, file to
`.planning/done/`).

## 3. 06 blocker note
06 needs 05's TUI mockups (05 unblocked since 01 closed) — 05 is the critical path into the
subagent landing; 03 already closed so its gate budget is firm.

## 4. Artifacts inventory
- Effort dir: `map.md` + `tickets/01..09` ONLY. No spec.md, plans/, sdd/, brainstorm/ under
  the effort dir (execution lives in-map + tickets, per the Plan-don't-do OVERRIDE note).
- Ticket 08's landing spec source: `tickets/04-ratify-skill-cuts.md` §Resolution (quoted
  above incorporates it; the ticket-04 resolution is the authoritative ratified list).
- Absorbed spec reference: `.planning/done/2026-08-16-optimize-planning-pipeline-aka-extension/spec.md`
  workstream C (folded into 06); workstreams A/B stay there.

## 5. Caveats
- Ticket 01/02/03 frontmatter statuses not directly re-verified (final-turn budget); closure
  inferred from map "Decisions so far" entries + map showing open chain 05→06→09 and
  07/08→09. 04 confirmed `status: closed`, `claimed: ratify-session 2026-08-16`.
