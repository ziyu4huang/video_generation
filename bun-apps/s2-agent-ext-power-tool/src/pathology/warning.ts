/**
 * Proactive pathology warning (Phase 1.1).
 *
 * Runs in the `tool_execution_end` hook: after each call, re-evaluates the
 * accumulator and — when a HIGH-severity pattern (retry-loop or consecutive-
 * error, the highest-confidence signals) is active — surfaces a non-invasive
 * status-line warning via `ctx.ui.setStatus`. Medium modes (error-storm,
 * saturation) stay on-demand only (noisier). No context injection, no turn
 * hijack — it is just a status bar line, like the git-branch indicator.
 *
 * Dedup: each distinct (check, tool) signature warns ONCE per active episode;
 * when no high finding is active the status is cleared and the dedup set resets,
 * so a recurring loop re-warns on each fresh episode. In print mode (no UI) the
 * surface is absent and the warner silently no-ops.
 *
 * Pure core (pickWorstHighFinding, loopSignature, makeWarner) is unit-tested;
 * the factory wires the module-singleton surfacePathologyWarning into the hook.
 */
import type { Finding } from "../findings.ts";
import { analyzePathology } from "./detector.ts";
import type { ToolCallRecord } from "./types.ts";

const STATUS_KEY = "pi-pathology";

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

/**
 * Build a warner over an injectable surface + dedup set. Returns a function that
 * takes the recent call log, runs the detector, and set/clears the status line.
 * PURE-ish: deterministic given the surface + set (both injectable for tests).
 */
export function makeWarner(surface: WarningSurface, warned: Set<string> = new Set()): (calls: ToolCallRecord[]) => void {
  return (calls) => {
    const findings = analyzePathology({ calls, contextPercent: null });
    const worst = pickWorstHighFinding(findings);
    if (!worst) {
      surface.setStatus(STATUS_KEY, undefined);
      warned.clear();
      return;
    }
    const sig = loopSignature(worst);
    if (warned.has(sig)) return;
    warned.add(sig);
    const d = (worst.detail ?? {}) as Record<string, unknown>;
    const tool = (d.tool as string) ?? "?";
    const n = (d.count as number) ?? (d.consecutive as number) ?? "?";
    const label = worst.check === "consecutive-error" ? "consecutive errors" : "retry loop";
    surface.setStatus(STATUS_KEY, `⚠ ${label}: ${tool} ×${n} — call inspect_pathology`);
  };
}

// ─── module singleton (wired into the factory hook) ──────────────────────────

const defaultWarned = new Set<string>();

/** Reset the warning dedup state (session_start). */
export function resetWarning(): void {
  defaultWarned.clear();
}

/**
 * Surface a proactive pathology warning from a hook context. No-ops silently
 * when the context has no setStatus (print mode / non-TTY). `ctx` is typed
 * loosely to avoid coupling to the full SDK UI interface.
 */
export function surfacePathologyWarning(
  ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } },
  calls: ToolCallRecord[],
): void {
  const setStatus = ctx.ui?.setStatus;
  if (!setStatus) return;
  makeWarner({ setStatus: setStatus.bind(ctx.ui) }, defaultWarned)(calls);
}
