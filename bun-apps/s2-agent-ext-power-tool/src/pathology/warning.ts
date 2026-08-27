/**
 * Proactive pathology warning (Phase 1.1; ticket 04 — count refresh +
 * per-session key + opt-in model-visible note arming).
 *
 * Runs in the `tool_execution_end` hook: after each call, re-evaluates the
 * accumulator and — when a HIGH-severity pattern (retry-loop or consecutive-
 * error, the highest-confidence signals) is active — surfaces a non-invasive
 * status-line warning via `ctx.ui.setStatus`. Medium modes (error-storm,
 * saturation) stay on-demand only (noisier). By default there is no context
 * injection and no turn hijack — it is just a status bar line, like the
 * git-branch indicator. The ONLY model-visible path is the OPT-IN injection
 * (inject.ts, `BUN_PI_PATHOLOGY_INJECT=1`), armed here at the same evaluation.
 *
 * Dedup: each distinct (check, tool) signature arms ONCE per active episode;
 * when no high finding is active the status is cleared and the dedup set resets,
 * so a recurring loop re-arms on each fresh episode. The status TEXT is re-set
 * on every evaluation so the magnitude stays current (a loop that grows from ×3
 * to ×8 must not display a stale ×3 — the pre-ticket-04 freeze bug), while the
 * one-time semantics live in the episode map, not the status update.
 *
 * Per-session keying (ticket 04): the status key is sessionId-qualified and the
 * episode map is per-sessionId, so an in-process subagent child renders its own
 * line instead of overwriting the parent's (same keying as the accumulator).
 *
 * Pure core (pickWorstHighFinding, loopSignature, makeWarner) is unit-tested;
 * the factory wires the module-singleton surfacePathologyWarning into the hook.
 */
import type { Finding } from "../findings.ts";
import { analyzePathology } from "./detector.ts";
import { makeInjectionHooks } from "./inject.ts";
import type { ToolCallRecord } from "./types.ts";

const BASE_STATUS_KEY = "pi-pathology";

/** Status-line key, sessionId-qualified so parent and subagent children each render their own line. PURE. */
export function statusKey(sid?: string): string {
  return sid ? `${BASE_STATUS_KEY}:${sid}` : BASE_STATUS_KEY;
}

/** A finding's magnitude for ranking: retry-loop uses count, consecutive-error uses consecutive. */
function magnitude(f: Finding): number {
  const d = (f.detail ?? {}) as Record<string, unknown>;
  return (typeof d.count === "number" ? d.count : typeof d.consecutive === "number" ? d.consecutive : 0);
}

/**
 * Among HIGH-severity findings, return the one with the largest magnitude, or
 * null if none. (Retry-loop + consecutive-error are the high-confidence signals
 * worth a proactive nudge.) PURE.
 */
export function pickWorstHighFinding(findings: Finding[]): Finding | null {
  const highs = findings.filter((f) => f.severity === "high");
  if (highs.length === 0) return null;
  return highs.reduce((best, f) => (magnitude(f) > magnitude(best) ? f : best));
}

/** Stable dedup key for a high finding: check + tool (count-independent). PURE. */
export function loopSignature(f: Finding): string {
  const tool = ((f.detail ?? {}) as Record<string, unknown>).tool ?? "?";
  return `${f.check}\0${tool}`;
}

/** Injectable status surface (the subset of ExtensionUIContext the warner needs). */
export interface WarningSurface {
  setStatus(key: string, text: string | undefined): void;
}

/** Episode callbacks the warner fires alongside the status update. */
export interface WarnerHooks {
  /** Fired once per (check, tool) signature per episode — arms the opt-in injection. */
  onNewEpisode?: (worst: Finding) => void;
  /** Fired when the episode ends (no high finding active) — drops armed state. */
  onEpisodeEnd?: () => void;
}

export interface WarnerOptions {
  /** sessionId for the status key + injection keying ("" fallback = ctx-less callers). */
  sid?: string;
  hooks?: WarnerHooks;
}

const NOOP_SURFACE: WarningSurface = { setStatus: () => {} };

/**
 * Build a warner over an injectable surface + episode map. Returns a function
 * that takes the recent call log, runs the detector, and set/clears the status
 * line. The status text is REFRESHED on every evaluation (current magnitude);
 * the episode map dedups the one-time hooks. PURE-ish: deterministic given the
 * surface + set + hooks (all injectable for tests).
 */
export function makeWarner(
  surface: WarningSurface,
  warned: Set<string> = new Set(),
  opts: WarnerOptions = {},
): (calls: ToolCallRecord[]) => Finding | null {
  return (calls) => {
    const findings = analyzePathology({ calls, contextPercent: null });
    const worst = pickWorstHighFinding(findings);
    if (!worst) {
      surface.setStatus(statusKey(opts.sid), undefined);
      warned.clear();
      opts.hooks?.onEpisodeEnd?.();
      return null;
    }
    const sig = loopSignature(worst);
    const isNew = !warned.has(sig);
    warned.add(sig);
    const d = (worst.detail ?? {}) as Record<string, unknown>;
    const tool = (d.tool as string) ?? "?";
    const n = (d.count as number) ?? (d.consecutive as number) ?? "?";
    const label = worst.check === "consecutive-error" ? "consecutive errors" : "retry loop";
    // Count refresh: re-set every evaluation so the magnitude stays current.
    surface.setStatus(statusKey(opts.sid), `⚠ ${label}: ${tool} ×${n} — call inspect_pathology`);
    if (isNew) opts.hooks?.onNewEpisode?.(worst);
    return worst;
  };
}

// ─── module singleton (wired into the factory hook) ──────────────────────────

/** Per-session episode maps, keyed like the accumulator ("" fallback = ctx-less). */
const sessionWarned = new Map<string, Set<string>>();

function warnedSet(sid?: string): Set<string> {
  const key = sid ?? "";
  let s = sessionWarned.get(key);
  if (!s) {
    s = new Set();
    sessionWarned.set(key, s);
  }
  return s;
}

/** Reset the warning episode state. No-arg / undefined = clear ALL sessions
 * (session_start full-reset + tests); a string sid = drop just that session. */
export function resetWarning(sid?: string): void {
  if (sid === undefined) sessionWarned.clear();
  else sessionWarned.delete(sid);
}

/**
 * Surface a proactive pathology warning from a hook context, keyed by session.
 * No setStatus (print mode / non-TTY) → status silently skipped, but the
 * evaluation still runs so the OPT-IN injection (model-visible note) stays
 * armed in headless runs. `ctx` is typed loosely to avoid coupling to the full
 * SDK UI interface.
 */
export function surfacePathologyWarning(
  ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } },
  calls: ToolCallRecord[],
  sid?: string,
): void {
  const setStatus = ctx.ui?.setStatus;
  const surface: WarningSurface = setStatus ? { setStatus: setStatus.bind(ctx.ui) } : NOOP_SURFACE;
  const { onNewEpisode, onEpisodeEnd } = makeInjectionHooks(sid);
  makeWarner(surface, warnedSet(sid), { sid, hooks: { onNewEpisode, onEpisodeEnd } })(calls);
}
