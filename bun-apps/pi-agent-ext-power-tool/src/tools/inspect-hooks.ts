/**
 * inspect_hooks — hook observability for extension development.
 *
 * Lists every loaded extension's registered lifecycle hooks (pi.on handlers):
 * which events each extension listens on, handler counts, and any handler
 * registered against an UNKNOWN event name (almost certainly a typo / dead
 * handler — it can never match the dispatch loop's real eventType).
 *
 * This file owns the ANALYSIS and the REPORT only. The runner-shape adapters it
 * reads from (`KNOWN_EVENTS`, `collectHooks`, `wrapHookHandlers`) live in
 * `../runner-hooks.js`, because `sdk-patch.ts` needs them too and infra must not
 * import a tool module.
 */
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Finding, shortPath, summarizeFindings } from "../findings.js";
import { DIAGNOSTIC_GATING } from "../gating.js";
import { bulletSection, findingsSummaryLine, reportHeader } from "../report.js";
import { KNOWN_EVENTS, type HooksSnapshot } from "../runner-hooks.js";

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
  const lines = reportHeader("Inspect Hooks");

  if (!snapshot.available) {
    for (const f of findings) lines.push(`  • ${f.message}`);
    lines.push("");
    return lines.join("\n");
  }

  lines.push(findingsSummaryLine(findings), "");

  // The two checks this report speaks to, called out by name rather than by
  // severity bucket — a hooks reader wants "which handlers are dead?", not
  // "what is medium?".
  const unknown = findings.filter((f) => f.check === "unknown-event-name");
  if (unknown.length > 0) {
    lines.push(...bulletSection("🟡", "Medium — unknown event name", unknown));
  } else if (findings.every((f) => f.severity === "info" || f.check === "never-fired")) {
    lines.push("✓ No unknown-event findings — hook registrations look healthy.", "");
  }
  lines.push(...bulletSection("🟢", "Low — never fired", findings.filter((f) => f.check === "never-fired")));

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

/** Deterministic self-test snapshot: one real event + one typo'd event. */
const SELF_TEST_SNAPSHOT: HooksSnapshot = {
  extensions: [
    {
      path: "bun-apps/example/ext.ts",
      hooks: [
        { event: "turn_end", count: 1, fired: 0 },
        { event: "turn_starts", count: 1, fired: 0 },
      ],
    },
  ],
  available: true,
};

export function makeInspectHooksTool() {
  return defineTool({
    name: "inspect_hooks",
    gating: DIAGNOSTIC_GATING,
    label: "Inspect Hooks",
    description:
      "List every loaded extension's registered lifecycle hooks (pi.on handlers) — which events each extension listens on, handler counts, and any handler registered against an unknown event name (likely a typo / dead handler). Fact-finder companion to inspect_extensions.",
    parameters: Type.Object({
      by_event: Type.Optional(Type.Boolean({ description: "Group inventory by event instead of by extension (who listens on X?)" })),
      return_json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON instead of a text report" })),
      self_test: Type.Optional(Type.Boolean({ description: "When true, run against deterministic test data instead of live ctx" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const snapshot = params.self_test ? SELF_TEST_SNAPSHOT : (ctx as ExtensionContext).getHooks();
      const findings = analyzeHooks(snapshot);
      const report = formatHooksReport(snapshot, findings, Boolean(params.by_event));

      if (params.return_json) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ findings, summary: summarizeFindings(findings), snapshot }, null, 2),
            },
          ],
          details: null,
        };
      }
      return {
        content: [
          { type: "text" as const, text: params.self_test ? `self_test: true\n\n${report}` : report },
        ],
        details: null,
      };
    },
  });
}
