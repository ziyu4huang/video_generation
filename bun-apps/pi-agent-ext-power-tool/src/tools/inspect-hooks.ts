/**
 * inspect_hooks — hook observability for extension development.
 *
 * Lists every loaded extension's registered lifecycle hooks (pi.on handlers):
 * which events each extension listens on, handler counts, and any handler
 * registered against an UNKNOWN event name (almost certainly a typo / dead
 * handler — it can never match the dispatch loop's real eventType).
 *
 * The finding vocabulary comes from ../findings.js, which every inspect_* tool
 * shares. (It used to be duplicated here to avoid a module-init cycle with
 * ../index.js — that cycle is gone now the vocabulary no longer lives in the
 * same file as the extension factory.)
 */
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Finding, shortPath, summarizeFindings } from "../findings.js";

export { type Finding, type Severity, summarizeFindings } from "../findings.js";

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

// ─── Firing-count intercept (Phase 2) ───────────────────────────────────────
// Idempotent in-place counting wrapper installed on the live extension.handlers
// arrays. The SDK emit() (runner.js) calls createContext() at the top of every
// emit, then reads the LIVE handlers array (no captured copy), so replacing an
// array entry IN-PLACE intercepts dispatch. applyContextPolyfills() (sdk-patch.ts)
// calls wrapHookHandlers() on every createContext — i.e. before handlers run.
//
// Counters are keyed by the ORIGINAL handler fn (the wrapper closes over orig);
// readers of extension.handlers still see a callable fn delegating to orig, and
// getHookFiringCount() unwraps (via Symbols) so the live (post-wrap) array reads
// back the right count. Wrap is idempotent (Symbol guard) and cheap (one Symbol
// check per handler per emit — createContext is on the hot emit path).

const hookFiringCounts = new WeakMap<Function, number>();
const kWrapped = Symbol("power-tool.hook.wrapped");
const kOrig = Symbol("power-tool.hook.orig");

type AnyHandler = (...args: any[]) => unknown;

/**
 * Idempotently wrap every registered hook handler on every extension's live
 * handlers array with a counting proxy (IN-PLACE array mutation). Safe to call
 * repeatedly (Symbol guard) — already-wrapped entries are skipped, so repeated
 * createContext walks never double-wrap or double-count. PURE w.r.t. counts: a
 * handler is wrapped at most once.
 */
export function wrapHookHandlers(extensions: unknown): void {
  if (!Array.isArray(extensions)) return;
  for (const ext of extensions as any[]) {
    const handlers: Map<string, AnyHandler[]> | undefined = ext?.handlers;
    if (!handlers || typeof handlers.values !== "function") continue;
    for (const arr of handlers.values()) {
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const orig = arr[i];
        if (typeof orig !== "function") continue;
        if ((orig as { [kWrapped]?: unknown })[kWrapped]) continue; // already wrapped
        const wrapped: AnyHandler & { [kWrapped]: true; [kOrig]: AnyHandler } =
          (...args) => {
            hookFiringCounts.set(orig, (hookFiringCounts.get(orig) ?? 0) + 1);
            return orig(...args);
          };
        wrapped[kWrapped] = true;
        wrapped[kOrig] = orig;
        arr[i] = wrapped; // IN-PLACE — emit() reads this live array at fire time
      }
    }
  }
}

/**
 * Read the firing count for a handler. Accepts either the original fn or its
 * counting wrapper (unwraps via the Symbols), so callers reading the live
 * extension.handlers array (post-wrap) get the right count. Default 0.
 */
export function getHookFiringCount(handler: Function): number {
  const marked = handler as { [kWrapped]?: unknown; [kOrig]?: Function };
  const orig = marked[kWrapped] ? (marked[kOrig] ?? handler) : handler;
  return hookFiringCounts.get(orig) ?? 0;
}

// ─── Snapshot types (also the analyzeHooks input) ───────────────────────────

export interface HookRegistration {
  event: string;
  /** handler-array length for this event */
  count: number;
  /** how many times the registered handlers actually fired since first emit */
  fired: number;
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
            fired:
              Array.isArray(hs)
                ? hs.reduce<number>(
                    (s, h) => s + (typeof h === "function" ? getHookFiringCount(h) : 0),
                    0,
                  )
                : 0,
          }))
        : [];
    return { path, hooks };
  });
  return { extensions, available: true };
}

/**
 * PURE: analyze a HooksSnapshot. No SDK, no fs. Order: unknown-event-name
 * (medium), then per-extension inventory (info), then stats (info), then
 * never-fired (low). If available:false, only a single hooks-unavailable info
 * finding is returned.
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

  // 🟢 never-fired — registered but never fired this session. Low severity
  // (not an error): rare events legitimately never fire in a short session;
  // this is a hint that a handler may be dead / wired to the wrong event.
  for (const ext of snapshot.extensions) {
    for (const h of ext.hooks) {
      if (h.fired === 0) {
        findings.push({
          severity: "low",
          check: "never-fired",
          message: `${shortPath(ext.path)} handler on "${h.event}" never fired (0/${h.count})`,
          detail: { path: ext.path, event: h.event, count: h.count, fired: 0 },
        });
      }
    }
  }

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

  // Low: never-fired (registered but never dispatched this session)
  const neverFired = findings.filter((f) => f.check === "never-fired");
  if (neverFired.length > 0) {
    lines.push(`▶ 🟢 Low — never fired (${neverFired.length}):`);
    for (const f of neverFired) lines.push(`  • ${f.message}`);
    lines.push("");
  }

  // Inventory
  if (byEvent) {
    const byEvt = new Map<string, { exts: string[]; handlers: number; fires: number }>();
    for (const ext of snapshot.extensions) {
      for (const h of ext.hooks) {
        const e = byEvt.get(h.event) ?? { exts: [], handlers: 0, fires: 0 };
        e.exts.push(shortPath(ext.path));
        e.handlers += h.count;
        e.fires += h.fired;
        byEvt.set(h.event, e);
      }
    }
    lines.push("▶ Hooks by event:");
    for (const [event, e] of [...byEvt].sort((a, b) => b[1].handlers - a[1].handlers)) {
      const flag = KNOWN_EVENTS.has(event) ? "" : "  ⚠ unknown";
      lines.push(`  ${event.padEnd(28)} ${e.exts.length} ext(s)  ${e.handlers} handler(s)  ${e.fires} fires${flag}`);
      lines.push(`  ${"".padEnd(30)}${e.exts.join(", ")}`);
    }
  } else {
    lines.push("▶ Hooks by extension:");
    for (const ext of snapshot.extensions) {
      const handlers = ext.hooks.reduce((s, h) => s + h.count, 0);
      const fires = ext.hooks.reduce((s, h) => s + h.fired, 0);
      lines.push(`  ${shortPath(ext.path).padEnd(42)} ${String(ext.hooks.length).padStart(3)} event(s)  ${String(handlers).padStart(3)} handler(s)  ${String(fires).padStart(3)} fires`);
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
    gating: {
      keywords: ["schema cost", "pathology", "extension health", "工具開銷", "context window", "token usage"],
      requires: {
        nouns: ["agent", "context", "extension", "pathology", "token", "schema", "tui", "工具"],
        verbs: ["inspect", "show", "check", "diagnose", "dump", "report"],
      },
    },
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
            { path: "bun-apps/example/ext.ts", hooks: [{ event: "turn_end", count: 1, fired: 0 }, { event: "turn_starts", count: 1, fired: 0 }] },
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
