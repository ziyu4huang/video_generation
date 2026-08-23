/**
 * Budget directives (cc-parity-2 ticket 05 / map D6): a `+500k` / `+1m` /
 * `+1.5m` in the user's ARMED workflow message is parsed into a binding
 * run-wide token ceiling the model cannot lower. `/effort` prose stays
 * advisory; this directive is enforced by WorkflowManager as
 * `max(directive, model-passed tokenBudget)`.
 *
 * The holder is session-level module state, mirroring the transient-config
 * reset pattern (model-role-config's setTransientModelTierConfig): the
 * workflows-mode input hook (workflow-editor.ts) is the ONLY writer — it sets
 * the value on every ARMED message (clearing when that message carries no
 * directive, so a stale directive never leaks into a later armed message) —
 * and WorkflowManager is the ONLY consumer, via a `consumeBudgetDirective`
 * getter that reads-and-clears (a directive binds exactly one run).
 */

/**
 * `+<n>k` / `+<n>m` (case-insensitive), first match wins. The `\b` after the
 * unit letter rejects `+500kx` while accepting `+500k,` / `+500k)` etc.
 * `+1.5m` → 1_500_000; decimals round to whole tokens.
 */
const BUDGET_DIRECTIVE_REGEX = /\+(\d+(?:\.\d+)?)(k|m)\b/i;

/**
 * Parse the FIRST budget directive in a message. Returns the ceiling in
 * tokens, or undefined when the text carries none (or the value rounds to 0).
 */
export function parseBudgetDirective(text: string): number | undefined {
  const match = BUDGET_DIRECTIVE_REGEX.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const value = Math.round(amount * (unit === "m" ? 1_000_000 : 1_000));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Which mechanism set a run's effective run-wide token ceiling. */
export type TokenBudgetSource = "directive" | "model" | "merged";

// ── Session-level directive holder ─────────────────────────────────────────
// Module-level state, same shape as model-role-config's transient config.
// Tests reset via resetBudgetDirective(); session_start resets it in
// extensions/ultracode.ts so a directive never crosses a session boundary.
let sessionDirective: number | undefined;

/** Overwrite (or clear, with undefined) the pending directive. ONLY the input hook calls this. */
export function setBudgetDirective(value: number | undefined): void {
  sessionDirective = value;
}

/** The pending directive, if any (does NOT clear). */
export function peekBudgetDirective(): number | undefined {
  return sessionDirective;
}

/** Read-and-clear: a consumed directive binds exactly one run. */
export function consumeBudgetDirective(): number | undefined {
  const value = sessionDirective;
  sessionDirective = undefined;
  return value;
}

/** Reset the holder (session_start + tests). */
export function resetBudgetDirective(): void {
  sessionDirective = undefined;
}

/**
 * The prompt block appended to a forced-workflow message so the model KNOWS
 * the ceiling and can pass it through (so `budget.total` in the script reflects
 * it). Enforcement is the manager's — a model-passed lower tokenBudget is
 * raised to the directive regardless of what the model does with this text.
 */
export function budgetDirectivePrompt(value: number): string {
  return [
    "[budget directive]",
    `The user set a BINDING run-wide token budget of ${value.toLocaleString()} tokens for this request.`,
    `Pass tokenBudget: ${value} on the run_workflow call (or omit it) — the runtime enforces`,
    "max(directive, tokenBudget) as the run ceiling; the directive cannot be lowered.",
  ].join("\n");
}
