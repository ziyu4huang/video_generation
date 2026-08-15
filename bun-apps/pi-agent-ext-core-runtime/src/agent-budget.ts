/**
 * Per-run token/spend budget enforcement for a subagent session: usage
 * bookkeeping types, the pure threshold checks, and the stateful guard that
 * wires them to session events (two-stage token stop with a wrap-up grace
 * turn; spend as an immediate hard abort).
 *
 * Depends on nothing else in this package — the file has ZERO imports, and the
 * guard reaches its session only through the structural BudgetSessionSurface.
 * That makes both halves testable against a fake session with no runtime, and
 * it is a deliberate invariant, not an accident: keep it that way. It is why
 * the turn_end check below is duplicated rather than importing agent-turns.js.
 */

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** Why a budget-capped subagent run was aborted mid-run. */
export interface BudgetExhaustion {
  /** Which budget was exceeded. */
  kind: "tokens" | "spend";
  /** The caller-declared ceiling. */
  limit: number;
  /** The cumulative usage at the moment of abort. */
  actual: number;
}

/**
 * Pure: check cumulative session usage against an optional per-run budget.
 * Returns the first exceeded budget (tokens checked before spend), or
 * `undefined` when neither is set or neither is exceeded. Uses `>` (strictly
 * greater), so reaching the limit exactly is allowed. Extracted from
 * `CoreAgent.run` so the threshold logic is unit-testable independent of
 * the session/subscribe wiring (which mirrors the existing onHistory/timeout
 * seams and is exercised via the spawnSubagent classification tests).
 */
export function checkBudgetExhaustion(
  stats: { tokens: { total: number }; cost: number },
  budget: { tokenBudget?: number; spendBudget?: number },
): BudgetExhaustion | undefined {
  if (budget.tokenBudget !== undefined && stats.tokens.total > budget.tokenBudget) {
    return { kind: "tokens", limit: budget.tokenBudget, actual: stats.tokens.total };
  }
  if (budget.spendBudget !== undefined && stats.cost > budget.spendBudget) {
    return { kind: "spend", limit: budget.spendBudget, actual: stats.cost };
  }
  return undefined;
}

/**
 * Informational 80%-of-budget warning — structurally mirrors
 * {@link BudgetExhaustion} but is purely advisory: it NEVER aborts a run.
 * Computed by callers from the FINAL usage the runner already reports via
 * `AgentRunOptions.onUsage` (the existing usage-out channel — no new result
 * channel is introduced for it).
 */
export interface BudgetWarning {
  /** Which budget reached ≥80% of its ceiling. */
  kind: "tokens" | "spend";
  /** The caller-declared ceiling. */
  limit: number;
  /** The final cumulative usage. */
  actual: number;
}

/** Fixed warning ratio: final usage at ≥ this fraction of a set budget trips the warning. No config knob by design. */
export const BUDGET_WARNING_RATIO = 0.8;

/**
 * Pure: check cumulative usage against the informational 80% warning line.
 * Mirrors {@link checkBudgetExhaustion}'s shape and tokens-before-spend
 * precedence, but with `>=` at BUDGET_WARNING_RATIO × limit — reaching
 * exactly 80% trips, 79.99% does not. Returns `undefined` when no budget is
 * set or neither trips. Informational only: never aborts, never retries.
 */
export function checkBudgetWarning(
  stats: { tokens: { total: number }; cost: number },
  budget: { tokenBudget?: number; spendBudget?: number },
): BudgetWarning | undefined {
  if (budget.tokenBudget !== undefined && stats.tokens.total >= BUDGET_WARNING_RATIO * budget.tokenBudget) {
    return { kind: "tokens", limit: budget.tokenBudget, actual: stats.tokens.total };
  }
  if (budget.spendBudget !== undefined && stats.cost >= BUDGET_WARNING_RATIO * budget.spendBudget) {
    return { kind: "spend", limit: budget.spendBudget, actual: stats.cost };
  }
  return undefined;
}

/**
 * Minimal session surface the budget guard needs (real AgentSession or a test
 * double): cumulative stats + mid-run abort. `getSessionStats()` is the SAME
 * stat source the onUsage path reads just before disposal. `sendUserMessage`
 * (optional) queues a user-role message; the two-stage token stop needs it to
 * inject the wrap-up notice — when absent (or when the queue call rejects) the
 * guard falls back to the immediate hard abort, so the budget is still enforced.
 */
export interface BudgetSessionSurface {
  abort(): unknown;
  getSessionStats(): { tokens: { total: number }; cost: number };
  sendUserMessage?(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
}

/**
 * Detect a usage observation: one assistant API response has finished and
 * carries usage (assistant message_end with `usage`). This is the finest
 * granularity at which cumulative usage becomes observable — finer than a
 * turn boundary, so checking here bounds budget overshoot to one API response.
 */
export function isUsageObservation(event: unknown): boolean {
  const evt = event as { type?: unknown; message?: { role?: unknown; usage?: unknown } } | null;
  return (
    typeof evt === "object" &&
    evt !== null &&
    evt.type === "message_end" &&
    typeof evt.message === "object" &&
    evt.message !== null &&
    evt.message.role === "assistant" &&
    evt.message.usage != null
  );
}

/** Which seam first reported budget exhaustion. */
export type BudgetSeam = "usage" | "turn";

/**
 * The single wrap-up notice injected on the FIRST tokenBudget crossing. The
 * model sees it as a user message on its next (final) turn: flush state to
 * disk, then reply with a pointer — instead of being killed mid-flight and
 * losing everything it had learned.
 */
export const BUDGET_WRAP_UP_MESSAGE =
  "Token budget exhausted — this is your FINAL turn. Do not start new exploratory work or long tool calls. Write your current findings/state/artifacts to disk now (files, not prose), then reply with a one-line pointer to what you saved.";

/**
 * Hard ceiling on the grace window, as a ratio over tokenBudget. During
 * grace-in-flight the guard still aborts once cumulative tokens exceed
 * tokenBudget * BUDGET_GRACE_CEILING_RATIO.
 */
export const BUDGET_GRACE_CEILING_RATIO = 1.25;

/**
 * Per-run budget guard: stops the session once cumulative usage exceeds the
 * ceiling. Both firing seams share ONE pure check
 * (checkBudgetExhaustion over session.getSessionStats()):
 *   - "usage" — evaluated on every usage observation (each assistant API
 *     response), i.e. MID-TURN; overshoot is bounded by one API response.
 *   - "turn" — backstop evaluated on every other session event (turn
 *     boundaries), in case the usage seam never fires.
 * spendBudget is a money valve: it ALWAYS hard-aborts immediately, even
 * mid-grace. tokenBudget gets a TWO-STAGE stop: the first crossing (on either
 * seam) injects BUDGET_WRAP_UP_MESSAGE as a followUp user message and does NOT
 * abort — token-kind aborts are then suppressed at BOTH check sites until the
 * wrap-up has been DELIVERED (a user-role message_start/message_end event after
 * issuance; pi-agent-core drains followUps only at a natural stop, so the
 * issuing turn's own turn_end fires first and must be ignored) AND the next
 * `turn_end` lands (the grace turn completed). That turn-end check then re-arms
 * the abort with the old hard-stop semantics (no third turn). The grace
 * window itself is hard-capped: once cumulative tokens exceed tokenBudget *
 * BUDGET_GRACE_CEILING_RATIO, the guard aborts immediately even mid-grace.
 * Idempotent: the first seam to fire wins — one abort, no double-throw of the
 * caller's TOKEN_BUDGET_EXHAUSTED error (run() reads `exhaustion` once after
 * prompt() returns).
 */
export interface BudgetGuard {
  /** The winning exhaustion record once a seam has fired; undefined before. */
  readonly exhaustion: BudgetExhaustion | undefined;
  /** Which seam fired first ("usage" mid-turn or "turn" backstop). */
  readonly firedVia: BudgetSeam | undefined;
  /** Whether the one-shot wrap-up message was already issued. */
  readonly wrapUpIssued: boolean;
  /** Route a session event to its seam: usage observation vs state-change backstop. */
  onSessionEvent(event: unknown): void;
}

/** A user-role message event — the delivery signal for the queued wrap-up followUp. */
function isUserMessageEvent(event: unknown): boolean {
  const evt = event as { type?: unknown; message?: { role?: unknown } } | null;
  return (
    typeof evt === "object" &&
    evt !== null &&
    (evt.type === "message_start" || evt.type === "message_end") &&
    evt.message?.role === "user"
  );
}

/**
 * Build a BudgetGuard over a session. Module-level and session-injected so the
 * seam wiring (usage observation → mid-turn check; state change → backstop;
 * two-stage token grace; idempotence) is unit-testable with a minimal fake
 * session, independent of CoreAgent.run / createAgentSession.
 */
export function createBudgetGuard(
  session: BudgetSessionSurface,
  budget: { tokenBudget?: number; spendBudget?: number },
): BudgetGuard {
  let exhaustion: BudgetExhaustion | undefined;
  let firedVia: BudgetSeam | undefined;
  let wrapUpIssued = false;
  // "none": no grace turn outstanding. "grace-in-flight": the wrap-up
  // followUp is queued and its turn has NOT yet emitted a post-delivery
  // "turn_end" — token-kind exhaustion checks are suppressed (spend still
  // hard-aborts). graceDelivered flips true once the injected wrap-up user
  // message is actually observed in the event stream; until then turn_end
  // events belong to the issuing/continuation turns and are ignored.
  let graceState: "none" | "grace-in-flight" = "none";
  let graceDelivered = false;
  const hasBudget = budget.tokenBudget !== undefined || budget.spendBudget !== undefined;
  const check = (seam: BudgetSeam, event: unknown) => {
    if (exhaustion || !hasBudget) return;
    let detected: BudgetExhaustion | undefined;
    let cost: number;
    let totalTokens: number;
    try {
      const stats = session.getSessionStats();
      cost = stats.cost;
      totalTokens = stats.tokens.total;
      detected = checkBudgetExhaustion(
        { tokens: { total: totalTokens }, cost },
        { tokenBudget: budget.tokenBudget, spendBudget: budget.spendBudget },
      );
    } catch {
      // getSessionStats not available yet (e.g. before the first turn) — skip;
      // a later observation re-checks.
      return;
    }
    if (graceState === "grace-in-flight") {
      if (isUserMessageEvent(event)) {
        // The wrap-up followUp was drained into the transcript — the grace
        // turn (the one the model is about to run on it) may now complete.
        graceDelivered = true;
      }
      // Raw type check rather than agent-turns.js's isTurnEndObservation:
      // deliberate duplication, not drift. Importing that module would couple
      // this guard to the turn guard's module, costing this file its
      // zero-local-import property (see the module header).
      const evt = event as { type?: unknown } | null;
      if (evt?.type !== "turn_end" || !graceDelivered) {
        // Mid-grace token-only overshoot is expected (cumulative tokens are
        // monotonic) — the grace turn must be allowed to finish streaming.
        // This also covers the issuing turn's turn_end while the followUp is
        // still queued. spendBudget stays an immediate hard abort.
        if (
          detected &&
          (detected.kind === "spend" || (budget.spendBudget !== undefined && cost > budget.spendBudget))
        ) {
          exhaustion = detected;
          firedVia = seam;
          void session.abort();
          return;
        }
        // Grace ceiling: #1334's wrap-up grace suppresses token-kind aborts
        // for an ENTIRE agentic turn with no upper bound — one turn can loop
        // many API rounds, and usage totals count cacheRead 1:1 (each round
        // re-bills the full context), so real incidents overshot 3.4-7.3x.
        // Hard-abort once cumulative tokens exceed tokenBudget * the ceiling
        // ratio even mid-grace. A wrap-up truncated mid-stream is acceptable
        // — hard safety beats graceful wording. Big-context children may hit
        // the ceiling within 1-2 rounds of crossing, which is the intent.
        if (
          detected?.kind === "tokens" &&
          budget.tokenBudget !== undefined &&
          totalTokens > budget.tokenBudget * BUDGET_GRACE_CEILING_RATIO
        ) {
          exhaustion = detected;
          firedVia = seam;
          void session.abort();
        }
        return;
      }
      // A turn_end observed AFTER the wrap-up message was delivered — the
      // grace turn completed. Re-arm; this very check (and any later one)
      // resumes the old hard-abort semantics. No third turn.
      graceState = "none";
    }
    if (!detected) return;
    // Hard-abort unless this is the FIRST tokenBudget crossing with no spend
    // crossing — only tokenBudget earns a wrap-up turn.
    if (
      detected.kind === "tokens" &&
      !wrapUpIssued &&
      !(budget.spendBudget !== undefined && cost > budget.spendBudget)
    ) {
      wrapUpIssued = true;
      graceState = "grace-in-flight";
      graceDelivered = false;
      // followUp queues the message for the model's NEXT turn (we are inside
      // the streaming loop). Token-kind aborts are suppressed until that
      // message is delivered (a user-role message event) AND its turn's
      // "turn_end" lands; the turn-end check after it (or any later check)
      // hits the already-issued path and aborts for real.
      const queued = session.sendUserMessage?.(BUDGET_WRAP_UP_MESSAGE, { deliverAs: "followUp" });
      if (queued) {
        void queued.catch(() => {
          // Could not queue the wrap-up turn — fall back to the hard abort
          // so the budget is still enforced.
          if (!exhaustion) {
            exhaustion = detected;
            firedVia = seam;
            void session.abort();
          }
        });
      } else {
        // Session surface cannot queue user messages — no grace possible;
        // keep the immediate hard abort (#1329 semantics).
        exhaustion = detected;
        firedVia = seam;
        void session.abort();
      }
      return;
    }
    exhaustion = detected;
    firedVia = seam;
    void session.abort();
  };
  return {
    get exhaustion() {
      return exhaustion;
    },
    get firedVia() {
      return firedVia;
    },
    get wrapUpIssued() {
      return wrapUpIssued;
    },
    onSessionEvent(event: unknown) {
      if (exhaustion) return; // idempotent: first seam wins, no double-abort
      check(isUsageObservation(event) ? "usage" : "turn", event);
    },
  };
}
