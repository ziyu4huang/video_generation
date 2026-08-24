# 01 — Armed-guidance CC parity (G1+G2+G3, guidance layer)

## Scope

Map: `.planning/2026-08-25-ultracode-cc-parity/` tickets phase A. Spec §1–4.
Make the guidance an armed model receives match CC's ultracode semantics.

1. **`src/effort-command.ts`** — rewrite `HIGH_DIRECTIVE` / `ULTRA_DIRECTIVE`
   (currently two generic lines, :27-30) to carry:
   - scale-to-request ladder ("find any bugs" → few finders + single-vote
     verify; "thoroughly audit" → wider pool + 3–5-vote adversarial verify +
     synthesis),
   - the quality-pattern names inline (`verify()`/`judgePanel()`/`loopUntilDry()`/`completenessCheck()`),
   - CC framing: exhaustive-by-default, token thrift is not the constraint
     (only an explicit user budget directive bounds spend),
   - ULTRA adds multi-phase sequencing (one workflow per phase, read results
     between) and big-tier synthesis.
   Keep them compact (they append to EVERY armed message): ≤ ~120 tokens each.
2. **`src/workflow-tool.ts`** — add `effortLevel?: "high" | "ultra"` to
   `WorkflowGuidelinesForTurnOptions` (:352-364) and a
   `buildUltracodeAddendum(level)` bullet block appended by
   `buildWorkflowGuidelinesForTurn` when set (:365-376):
   - standing author-by-default + solo carve-out bullet ("Ultracode is ON for
     this session … solo turns are conversation or trivial mechanical edits"),
   - scale ladder bullet,
   - multi-phase sequencing bullet,
   - inline pattern-catalog bullet (so the simplified set — which defers to
     workflow_help at :270 — carries the catalog on armed turns).
   Target ≤ ~300 tokens over the current simplified set (measure, record in
   map fog resolution).
3. **`extensions/ultracode.ts`** — `before_agent_start` (:212-225) passes
   `effortLevel: effort.level`.
4. **Tests** — pin the new directive strings (`tests/effort-command.test.ts`)
   and the addendum (guideline builder test): armed+simplified → addendum
   present; non-armed → absent; pointer turn → absent.
5. **Fog call to settle in-ticket**: `verify()` default reviewers=2 vs the
   ladder's "3–5-vote" phrasing — keep runtime default, phrase the ladder as
   "verify(item, {reviewers: 3-5})" (guidance shows the knob) unless evidence
   says otherwise; record the choice.

Non-goals (map D2/D3): baseline first bullet unchanged; forced-prompt text in
workflow-editor.ts byte-stable.

## Acceptance criteria

- [ ] HIGH/ULTRA directives rewritten + unit-pinned (scale ladder, pattern
      names, solo carve-out or addendum bullet, budget framing present)
- [ ] `buildWorkflowGuidelinesForTurn({full, effortLevel})` appends the
      addendum ONLY when effortLevel set; pointer/non-armed paths unchanged
- [ ] Addendum token cost measured and recorded (≤ ~300 tok over simplified)
- [ ] `bun run --cwd bun-apps/s2-agent-ext-ultracode test` (canonical gate)
      green
- [ ] PR via devops chain; reviewer pass; effort map + spec + tickets ride the
      same PR (planning never lands on main directly)
