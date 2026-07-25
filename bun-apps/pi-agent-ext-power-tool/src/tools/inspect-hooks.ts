/**
 * inspect_hooks — hook observability for extension development.
 *
 * Lists every loaded extension's registered lifecycle hooks (pi.on handlers):
 * which events each extension listens on, handler counts, and any handler
 * registered against an UNKNOWN event name (almost certainly a typo / dead
 * handler — it can never match the dispatch loop's real eventType).
 *
 * This module is SELF-CONTAINED (imports only from the SDK) to avoid a
 * module-init cycle with ../index.js. The Finding/Severity types are
 * duplicated here but structurally identical to index's, so JSON output stays
 * consistent across inspect_* tools.
 */
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Shared with inspect_extensions (structurally identical) ────────────────

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  /** machine id, e.g. "unknown-event-name" */
  check: string;
  /** one human-readable line */
  message: string;
  /** structured payload (for JSON mode / assertions) */
  detail?: Record<string, unknown>;
}

export function summarizeFindings(findings: Finding[]): {
  total: number;
  high: number;
  medium: number;
  low: number;
} {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === "info") continue;
    counts[f.severity as "high" | "medium" | "low"] += 1;
  }
  return { total: counts.high + counts.medium + counts.low, ...counts };
}

/** Compact a source path: prefer the bun-apps/... tail, else last 2 segments. */
function shortPath(p: string): string {
  const i = p.indexOf("bun-apps/");
  if (i >= 0) return p.slice(i);
  return p.split("/").slice(-2).join("/");
}

// ─── Known events (pi 0.82.0) ───────────────────────────────────────────────
// The on() overload string literals. A handler registered on an event NOT in
// this set can never fire → likely a typo. Keep in sync with the SDK's
// ExtensionEvent.type union if the SDK adds events.

export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "project_trust", "resources_discover",
  "session_start", "session_info_changed", "session_before_switch",
  "session_before_fork", "session_before_compact", "session_compact",
  "session_shutdown", "session_before_tree", "session_tree",
  "context", "before_provider_request", "before_provider_headers",
  "after_provider_response", "before_agent_start", "agent_start",
  "agent_end", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "model_select", "thinking_level_select", "tool_call", "tool_result",
  "user_bash", "input",
]);

// ─── Snapshot types (also the analyzeHooks input) ───────────────────────────

export interface HookRegistration {
  event: string;
  /** handler-array length for this event */
  count: number;
}
export interface ExtensionHooks {
  path: string;
  hooks: HookRegistration[];
}
export interface HooksSnapshot {
  extensions: ExtensionHooks[];
  /** false when the polyfill couldn't reach runner.extensions */
  available: boolean;
}

/**
 * PURE: map the raw runner.extensions[] (each `{ path, handlers: Map<event,Fn[]> }`)
 * into a typed HooksSnapshot. Tolerates shape drift → available:false.
 */
export function collectHooks(rawExtensions: unknown): HooksSnapshot {
  if (!Array.isArray(rawExtensions)) return { extensions: [], available: false };
  const extensions: ExtensionHooks[] = rawExtensions.map((ext: any) => {
    const handlers: Map<string, unknown[]> | undefined = ext?.handlers;
    const path: string = ext?.path ?? ext?.resolvedPath ?? "(unknown)";
    const hooks: HookRegistration[] =
      handlers && typeof handlers.entries === "function"
        ? [...(handlers as Map<string, unknown[]>).entries()].map(([event, hs]) => ({
            event: String(event),
            count: Array.isArray(hs) ? hs.length : 0,
          }))
        : [];
    return { path, hooks };
  });
  return { extensions, available: true };
}

/**
 * PURE: analyze a HooksSnapshot. No SDK, no fs. Order: unknown-event-name
 * (medium), then per-extension inventory (info), then stats (info). If
 * available:false, only a single hooks-unavailable info finding is returned.
 */
export function analyzeHooks(snapshot: HooksSnapshot): Finding[] {
  const findings: Finding[] = [];
  if (!snapshot.available) {
    findings.push({
      severity: "info",
      check: "hooks-unavailable",
      message:
        "Hooks unavailable — SDK context shape changed (getHooks polyfill couldn't reach runner.extensions)",
    });
    return findings;
  }

  // 🟡 unknown-event-name — handler on an event NOT in KNOWN_EVENTS → dead (typo)
  for (const ext of snapshot.extensions) {
    for (const h of ext.hooks) {
      if (!KNOWN_EVENTS.has(h.event)) {
        findings.push({
          severity: "medium",
          check: "unknown-event-name",
          message: `${shortPath(ext.path)} registers handler on unknown event "${h.event}" — likely a typo / dead handler`,
          detail: { path: ext.path, event: h.event, count: h.count },
        });
      }
    }
  }

  // ℹ️ per-extension inventory
  let totalHandlers = 0;
  let totalUnknown = 0;
  for (const ext of snapshot.extensions) {
    const handlers = ext.hooks.reduce((s, h) => s + h.count, 0);
    const unknown = ext.hooks.filter((h) => !KNOWN_EVENTS.has(h.event)).length;
    totalHandlers += handlers;
    totalUnknown += unknown;
    findings.push({
      severity: "info",
      check: "extension-hook-inventory",
      message: `${shortPath(ext.path)}: ${ext.hooks.length} event(s), ${handlers} handler(s)`,
      detail: { path: ext.path, events: ext.hooks.length, handlers, unknown },
    });
  }

  findings.push({
    severity: "info",
    check: "hook-stats",
    message: `${snapshot.extensions.length} extension(s), ${totalHandlers} handler(s); ${totalUnknown} unknown-event finding(s)`,
    detail: { extensions: snapshot.extensions.length, handlers: totalHandlers, unknown: totalUnknown },
  });

  return findings;
}

/** Render a HooksSnapshot + its findings as a severity-ranked text report. PURE. */
export function formatHooksReport(
  snapshot: HooksSnapshot,
  findings: Finding[],
  byEvent: boolean,
): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════╗");
  lines.push("║          Inspect Hooks               ║");
  lines.push("╚══════════════════════════════════════╝");
  lines.push("");

  if (!snapshot.available) {
    for (const f of findings) lines.push(`  • ${f.message}`);
    lines.push("");
    return lines.join("\n");
  }

  const summary = summarizeFindings(findings);
  lines.push(
    `▶ ${summary.total} issue(s): 🔴 ${summary.high} high · 🟡 ${summary.medium} medium · 🟢 ${summary.low} low`,
  );
  lines.push("");

  // Medium: unknown-event-name
  const unknown = findings.filter((f) => f.check === "unknown-event-name");
  if (unknown.length > 0) {
    lines.push(`▶ 🟡 Medium — unknown event name (${unknown.length}):`);
    for (const f of unknown) lines.push(`  • ${f.message}`);
    lines.push("");
  } else if (summary.total === 0) {
    lines.push("✓ No unknown-event findings — hook registrations look healthy.");
    lines.push("");
  }

  // Inventory
  if (byEvent) {
    const byEvt = new Map<string, { exts: string[]; handlers: number }>();
    for (const ext of snapshot.extensions) {
      for (const h of ext.hooks) {
        const e = byEvt.get(h.event) ?? { exts: [], handlers: 0 };
        e.exts.push(shortPath(ext.path));
        e.handlers += h.count;
        byEvt.set(h.event, e);
      }
    }
    lines.push("▶ Hooks by event:");
    for (const [event, e] of [...byEvt].sort((a, b) => b[1].handlers - a[1].handlers)) {
      const flag = KNOWN_EVENTS.has(event) ? "" : "  ⚠ unknown";
      lines.push(`  ${event.padEnd(28)} ${e.exts.length} ext(s)  ${e.handlers} handler(s)${flag}`);
      lines.push(`  ${"".padEnd(30)}${e.exts.join(", ")}`);
    }
  } else {
    lines.push("▶ Hooks by extension:");
    for (const ext of snapshot.extensions) {
      const handlers = ext.hooks.reduce((s, h) => s + h.count, 0);
      lines.push(`  ${shortPath(ext.path).padEnd(42)} ${String(ext.hooks.length).padStart(3)} event(s)  ${String(handlers).padStart(3)} handler(s)`);
    }
  }
  lines.push("");

  const stats = findings.find((f) => f.check === "hook-stats");
  if (stats) lines.push(`▶ ${stats.message}`);
  return lines.join("\n");
}

// ─── Tool factory ────────────────────────────────────────────────────────────

export function makeInspectHooksTool() {
  return defineTool({
    name: "inspect_hooks",
    label: "Inspect Hooks",
    description:
      "List every loaded extension's registered lifecycle hooks (pi.on handlers) — which events each extension listens on, handler counts, and any handler registered against an unknown event name (likely a typo / dead handler). Fact-finder companion to inspect_extensions.",
    parameters: Type.Object({
      by_event: Type.Optional(Type.Boolean({ description: "Group inventory by event instead of by extension (who listens on X?)" })),
      return_json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON instead of a text report" })),
      self_test: Type.Optional(Type.Boolean({ description: "When true, run against deterministic test data instead of live ctx" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      // self_test: deterministic mock, no live session.
      if (params.self_test) {
        const mock: HooksSnapshot = {
          extensions: [
            { path: "bun-apps/example/ext.ts", hooks: [{ event: "turn_end", count: 1 }, { event: "turn_starts", count: 1 }] },
          ],
          available: true,
        };
        const findings = analyzeHooks(mock);
        return {
          content: [{ type: "text" as const, text: "self_test: true\n\n" + formatHooksReport(mock, findings, Boolean(params.by_event)) }],
          details: null,
        };
      }

      const snapshot = (ctx as ExtensionContext).getHooks();
      const findings = analyzeHooks(snapshot);

      if (params.return_json) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { findings, summary: summarizeFindings(findings), snapshot },
                null,
                2,
              ),
            },
          ],
          details: null,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatHooksReport(snapshot, findings, Boolean(params.by_event)) }],
        details: null,
      };
    },
  });
}
