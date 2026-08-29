/**
 * /autocompact slash command for s2-agent-ext-power-tool — absolute-threshold
 * context compaction trigger.
 *
 * Upstream already auto-compacts on a RELATIVE threshold
 * (`settings.json` `compaction.reserveTokens`: fires at
 * `contextTokens > contextWindow − reserveTokens`, see upstream
 * settings-manager `getCompactionSettings`). This command adds an ABSOLUTE,
 * per-session threshold (`/autocompact 400k` → compact once estimated tokens
 * reach 400 000) — useful for low-threshold testing and for pinning a working
 * set smaller than the model's window. Threshold state is deliberately
 * in-memory only (keyed by sessionId, same discipline as the pathology
 * accumulator): persisting it would create a second config surface for one
 * behavior alongside upstream's `compaction` settings block.
 *
 * Trigger point: the `agent_settled` event — fired after a run has fully
 * settled with no automatic retry, compaction, or queued continuation left.
 * That is AFTER upstream's own `_checkCompaction` pass, so this sees the
 * post-upstream-compaction state and cannot race it. `turn_end` was rejected:
 * it fires per turn mid-run (inside tool loops), where calling `ctx.compact()`
 * would yank the context out from under a streaming agent.
 *
 * The summary side of compaction (CC-style summaries) already lives in
 * s2-agent-ext-compact's `session_before_compact` hook — this file owns only
 * the trigger side.
 */
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

/** Parsed result of the command argument. */
export type AutocompactArg =
  | { kind: "status" } // no argument
  | { kind: "off" }
  | { kind: "set"; threshold: number };

/** Parse a user argument into an action. Pure — unit-tested directly. */
export function parseAutocompactArg(raw: string): { ok: true; value: AutocompactArg } | { ok: false; error: string } {
  const arg = raw.trim().toLowerCase();
  if (!arg) return { ok: true, value: { kind: "status" } };
  if (arg === "off" || arg === "none" || arg === "disable") return { ok: true, value: { kind: "off" } };
  // `<N>k` / `<N>K` (thousands) or a bare token count.
  const m = arg.match(/^(\d+(?:\.\d+)?)(k?)$/);
  if (!m) return { ok: false, error: `Invalid argument '${raw.trim()}'. Use /autocompact <N>k | <N> | off, or no args for status.` };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Threshold must be a positive number." };
  const threshold = m[2] ? Math.round(n * 1000) : Math.round(n);
  if (threshold <= 0) return { ok: false, error: "Threshold rounds to zero — use a larger value." };
  return { ok: true, value: { kind: "set", threshold } };
}

/** Per-session threshold state. Keyed by sessionId (UUIDv7) so an in-process
 *  subagent child keeps its OWN threshold — same isolation rule as the
 *  pathology accumulator (D9 fresh-load property: a new session starts
 *  unarmed). Absent key = auto-compact off. */
const thresholds = new Map<string, number>();

/** Sessions with a compaction we initiated still in flight. Guards the
 *  agent_settled check against re-triggering while the previous compact is
 *  running or immediately after it (tokens may not have refreshed yet). */
const compacting = new Set<string>();

export function getThreshold(sessionId: string): number | undefined {
  return thresholds.get(sessionId);
}

export function setThreshold(sessionId: string, threshold: number | undefined): void {
  if (threshold === undefined) thresholds.delete(sessionId);
  else thresholds.set(sessionId, threshold);
}

export function isCompacting(sessionId: string): boolean {
  return compacting.has(sessionId);
}

/** Clear a stuck in-flight guard. Called when the user re-arms or disarms —
 *  a fresh /autocompact intent must not inherit a guard left behind by a
 *  compaction that hung or never called back (review #2144 finding 1). */
export function clearCompacting(sessionId: string): void {
  compacting.delete(sessionId);
}

/** Test-only: wipe all per-session state. */
export function resetAutocompact(): void {
  thresholds.clear();
  compacting.clear();
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);
}

/** Render the status line shown by the command for the current session. */
export function renderStatus(sessionId: string, usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined): string {
  const threshold = thresholds.get(sessionId);
  const head = `/autocompact: ${threshold === undefined ? "OFF" : `armed at ${fmt(threshold)} tokens`}`;
  if (!usage) return `${head}\nContext usage unknown (no active model).`;
  const cur = usage.tokens === null ? "unknown (fresh compaction?)" : `${usage.tokens.toLocaleString()} (${usage.percent?.toFixed(1) ?? "?"}%)`;
  return `${head}\nContext: ${cur} of ${usage.contextWindow.toLocaleString()} window.`;
}

type CtxLike = {
  ui: { notify: (m: string, l?: string) => void };
  isIdle(): boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  compact(options?: { onComplete?: () => void; onError?: (e: Error) => void }): void;
  sessionManager?: { getSessionId(): string };
};

function sid(ctx: CtxLike): string {
  return ctx.sessionManager?.getSessionId() ?? "";
}

/**
 * The agent_settled hook: check the absolute threshold and trigger compaction
 * when armed and crossed. Returns true when a compaction was initiated.
 * Exported for unit tests; registered by src/index.ts.
 */
export function checkAutocompact(ctx: CtxLike): boolean {
  const id = sid(ctx);
  const threshold = thresholds.get(id);
  if (threshold === undefined) return false;
  if (compacting.has(id)) return false;
  // Only trigger while idle — agent_settled guarantees it, this is a belt for
  // any future caller reusing the helper mid-stream.
  if (!ctx.isIdle()) return false;
  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens === null) return false; // unknown estimate (fresh compaction) — skip this tick
  if (usage.tokens < threshold) return false;
  compacting.add(id);
  ctx.ui.notify(`/autocompact: threshold ${fmt(threshold)} reached (${usage.tokens.toLocaleString()} tokens) — compacting…`, "info");
  ctx.compact({
    onComplete: () => compacting.delete(id),
    onError: (e) => {
      compacting.delete(id);
      // Surface the failure — upstream refuses some compactions ("Nothing to
      // compact (session too small)", "Already compacted", a compact-ext
      // cancel); without this the retry loop is silent after the arming
      // notice (review #2144 finding 2).
      ctx.ui.notify(`/autocompact: compaction failed (${e.message}); will re-check at next settle.`, "error");
    },
  });
  return true;
}

/** Build the /autocompact command. */
export function makeAutocompactCommand(): Pick<RegisteredCommand, "name" | "description" | "handler" | "getArgumentCompletions"> {
  return {
    name: "autocompact",
    description:
      "Auto-compact at an ABSOLUTE token threshold (per-session): /autocompact 400k arms, /autocompact off disarms, no args = status. Upstream's relative reserveTokens compaction is unaffected.",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const ui = (ctx as unknown as CtxLike).ui;
      const id = sid(ctx as unknown as CtxLike);
      const usage = (ctx as unknown as CtxLike).getContextUsage();
      const parsed = parseAutocompactArg(args);
      if (!parsed.ok) {
        ui.notify(parsed.error, "error");
        return;
      }
      if (parsed.value.kind === "status") {
        ui.notify(renderStatus(id, usage), "info");
        return;
      }
      if (parsed.value.kind === "off") {
        setThreshold(id, undefined);
        // Fresh intent clears any guard a hung compaction left behind.
        clearCompacting(id);
        ui.notify("/autocompact: disarmed.", "info");
        return;
      }
      const threshold = parsed.value.threshold;
      if (usage && threshold >= usage.contextWindow) {
        ui.notify(
          `Threshold ${fmt(threshold)} ≥ context window ${fmt(usage.contextWindow)} — upstream auto-compaction already covers this range. Pick a smaller threshold.`,
          "error",
        );
        return;
      }
      setThreshold(id, threshold);
      // Re-arming is fresh intent — a guard stuck from a compaction that
      // never called back must not silently kill the new threshold.
      clearCompacting(id);
      ui.notify(renderStatus(id, usage), "info");
    },
    getArgumentCompletions(prefix: string) {
      const items = [
        { value: "off", label: "off", description: "Disarm absolute-threshold auto-compaction" },
        { value: "50k", label: "50k", description: "Arm at 50 000 tokens" },
        { value: "100k", label: "100k", description: "Arm at 100 000 tokens" },
        { value: "400k", label: "400k", description: "Arm at 400 000 tokens" },
      ];
      if (!prefix) return items;
      const p = prefix.toLowerCase();
      const filtered = items.filter((it) => it.value.startsWith(p));
      return filtered.length ? filtered : null;
    },
  };
}
