# Ticket 05 — "+500k" budget directives (binding run-wide ceiling)

Status: done (2026-08-23) · Phase 3 (ultracode-only; independent of Phase 2)

## Scope

CC-style user token directives: `+500k`, `+1m`, `+1.5m` in the user's message
when a workflow arms, parsed and enforced as a HARD run-wide ceiling the model
cannot lower (map D6). Also surfaced to the model so it passes the number
through. `/effort` prose stays advisory; the directive is binding.

## Approach

1. Parser: new pure `src/budget-directive.ts` in ultracode —
   `parseBudgetDirective(text): number | undefined`, matching
   `/`\+(\d+(?:\.\d+)?)(k|m)\b`/i` on the raw user text (first match wins;
   `+1.5m` → 1,500,000).
2. Prompt seam: in `workflow-editor.ts`'s `pi.on("input")` transform (:518,
   `{action:"transform", text: buildForcedWorkflowPrompt(event.text, extra)}`),
   append the directive to `extra` — the model is TOLD the ceiling.
3. Enforcement seam: a session-level `BudgetDirectiveHolder` (module-level,
   reset on `session_start`, mirroring the transient-config reset pattern);
   `WorkflowManager` run entry (where `tokenBudget` lands,
   `workflow-manager.ts:175-188/510/555`) computes
   `effective = max(directive, params.tokenBudget ?? 0)` and records
   `tokenBudgetSource: "directive" | "model" | "merged"`.
4. Persistence/display: add `tokenBudgetSource` to the run record
   (`run-persistence.ts`) so resume keeps the ceiling; display line in
   `display.ts` (precedent: `modelSource` label from teams-parity ticket 06).
5. Scoping: a directive binds only the session that parsed it; `cron_create`
   definitions are unaffected (their budget comes from the script) — document
   in the cron-tools description.

## Files

- New: `bun-apps/s2-agent-ext-ultracode/src/budget-directive.ts`
- `src/workflow-editor.ts`, `src/workflow-manager.ts`,
  `src/run-persistence.ts`, `src/display.ts`, `extensions/ultracode.ts`
- spec.md §2 budget-directives row — same PR

## Risks

- Interplay with phase sub-budgets and per-agent hard budgets: `max()` only
  raises the run ceiling; sub-budgets still carve from it — add a test.
- Leakage: a directive parsed in a message that does NOT arm must not leak
  into a later armed message — the holder holds only the latest ARMED
  message's value; cleared when consumed or when an armed message carries no
  directive.

## Verification

- New `tests/budget-directive.test.ts` (parser); extend
  `workflow-manager.test.ts` (max() precedence, source labels, resume
  persistence) and `workflow-editor.test.ts` (transform appends the directive;
  non-armed messages don't set the holder).
- Full gates in s2-agent-ext-ultracode (check + typecheck + test).
