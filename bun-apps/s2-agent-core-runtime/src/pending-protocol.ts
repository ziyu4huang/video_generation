/**
 * Pending-protocol map — the plan-approval half of the protocol-message layer
 * (agent-teams parity ticket 04, effort
 * `.planning/2026-08-22-subagent-teams-parity`).
 *
 * A child's injected `request_plan_approval` tool holds ONE pending exchange
 * here, keyed by the child's self-declared live-agent name; the parent's
 * `send_message {type:"plan_approval_response"}` resolves it. Timeout defaults
 * to DENY (map decision D6 — budget-safe; never block a dispatch forever).
 *
 * Lives in core-runtime next to the registry layer for the same reason as the
 * team task store (map D1): the child-side tool and the parent-side router are
 * the same package today, but peers (ultracode workflow agents) must be able
 * to hold/respond without an ext→ext edge. Process-local and in-memory by
 * design — a pending approval is per-session state, never persisted.
 */

/** One held plan-approval exchange's outcome. `approved:false` + `timedOut`/`released` distinguishes an explicit parental DENY from the default-deny paths. */
export interface PlanApprovalOutcome {
  approved: boolean;
  /** Parental guidance returned with the verdict (approve or deny). */
  feedback?: string;
  /** True when the timeout fired (default DENY, D6) rather than a response arriving. */
  timedOut?: boolean;
  /** True when the hold was dropped without a verdict (session end, superseding hold, child abort). */
  released?: boolean;
}

/** The injectable clock/timer surface tests swap for fakes. */
export interface PendingProtocolTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimer: PendingProtocolTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

interface HeldEntry {
  plan: string;
  resolve: (outcome: PlanApprovalOutcome) => void;
  timer: unknown;
  startedAt: number;
  timeoutMs: number;
}

/**
 * Keyed pending plan-approval holds. One entry per live-agent name: a second
 * `hold` under a taken key releases the first (default-deny, `released`) — a
 * child re-asking never orphans its previous wait.
 */
export class PendingProtocolMap {
  private entries = new Map<string, HeldEntry>();
  private timer: PendingProtocolTimer;

  constructor(timer: PendingProtocolTimer = realTimer) {
    this.timer = timer;
  }

  /**
   * Hold a pending approval and return the promise the child awaits. Resolves
   * via `respond`, the per-hold timeout (`timedOut`, default DENY per D6), or
   * `release`/`clear` (session end / child abort / superseded).
   */
  hold(key: string, plan: string, timeoutMs: number): Promise<PlanApprovalOutcome> {
    this.release(key);
    return new Promise<PlanApprovalOutcome>((resolve) => {
      const entry: HeldEntry = {
        plan,
        resolve,
        timer: this.timer.setTimeout(() => {
          this.entries.delete(key);
          resolve({ approved: false, timedOut: true });
        }, timeoutMs),
        startedAt: this.timer.now(),
        timeoutMs,
      };
      this.entries.set(key, entry);
    });
  }

  /**
   * Deliver the parent's verdict. Returns false when nothing is pending under
   * `key` (the caller surfaces "no pending plan approval" — a response with no
   * request is a routing mistake, never a silent pass).
   */
  respond(key: string, outcome: { approved: boolean; feedback?: string }): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.timer.clearTimeout(entry.timer);
    entry.resolve(outcome);
    return true;
  }

  /** Drop a hold without a verdict (resolves `released` default-deny). No-op when nothing is held. */
  release(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.timer.clearTimeout(entry.timer);
    entry.resolve({ approved: false, released: true });
    return true;
  }

  /** The names with a pending hold, for error hints and rosters. */
  pendingNames(): string[] {
    return [...this.entries.keys()];
  }

  /** One held request's read-only view (plan + waited ms), for diagnostics. */
  view(key: string): { plan: string; waitedMs: number; timeoutMs: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { plan: entry.plan, waitedMs: this.timer.now() - entry.startedAt, timeoutMs: entry.timeoutMs };
  }

  /** Release every hold (session_shutdown). Returns how many were dropped. */
  clear(): number {
    const keys = [...this.entries.keys()];
    for (const key of keys) this.release(key);
    return keys.length;
  }

  get size(): number {
    return this.entries.size;
  }
}

let _pendingProtocolSingleton: PendingProtocolMap | undefined;

/**
 * Process-wide singleton — the child-side `request_plan_approval` tool and the
 * parent-side `send_message` router must share ONE map across extension
 * instances (same sharing contract as the live-agent registry).
 */
export function getPendingProtocolMap(): PendingProtocolMap {
  _pendingProtocolSingleton ??= new PendingProtocolMap();
  return _pendingProtocolSingleton;
}

/** Test-only: reset the singleton (drops every hold). */
export function __resetPendingProtocolMapForTests(): void {
  _pendingProtocolSingleton?.clear();
  _pendingProtocolSingleton = undefined;
}
