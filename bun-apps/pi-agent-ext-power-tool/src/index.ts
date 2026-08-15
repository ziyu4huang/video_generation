/// <reference types="@repo/pi-agent-ext-core-interface" />
/**
 * pi-agent-ext-power-tool — extension factory.
 *
 * This file registers the extension. Every tool lives in its own module under
 * `src/tools/` (matching the `pathology/` and `schema-cost/` convention); the
 * shared finding vocabulary lives in `src/findings.ts` and the report-formatting
 * helpers in `src/format.ts`.
 *
 * Tools provided:
 *   inspect_context    — context-window breakdown by token bucket   (tools/inspect-context.ts)
 *   inspect_agent      — dump agent state to YAML                   (tools/inspect-agent.ts)
 *   inspect_extensions — lint extensions/tools/skills/guidelines    (tools/inspect-extensions.ts)
 *   inspect_hooks      — registered lifecycle hooks per extension   (tools/inspect-hooks.ts)
 *   inspect_tui        — above-editor widget state                  (tools/inspect-tui.ts)
 *   inspect_pathology  — how the agent is FAILING this session      (pathology/)
 *
 * Usage:
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/extensions/power-tool.ts -p "call inspect_context"
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/extensions/power-tool.ts -p "call inspect_agent"
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ensureGetSystemPromptOptions } from "./sdk-patch.js";
import { makeExtensionsCommand } from "./extensions-command.js";
import { makeInspectContextTool } from "./tools/inspect-context.js";
import { makeInspectAgentTool } from "./tools/inspect-agent.js";
import { makeInspectExtensionsTool } from "./tools/inspect-extensions.js";
import { makeInspectHooksTool } from "./tools/inspect-hooks.js";
import { makeInspectTuiTool } from "./tools/inspect-tui.js";
import {
  makeInspectPathologyTool,
  recordCallStart,
  recordCallEnd,
  recordTurnEnd,
  resetAccumulator,
  getCalls,
  surfacePathologyWarning,
  resetWarning,
} from "./pathology/index.ts";

// ─── Public surface ───────────────────────────────────────────────────────────
// Re-exported so `@repo/pi-agent-ext-power-tool` stays one import site for
// consumers and tests. New code should prefer the owning module directly.

export { type Finding, type Severity, shortPath, summarizeFindings } from "./findings.js";
export { TOKEN_RATIO, bar, est, estTok, miniBar } from "./format.js";
export { makeInspectContextTool } from "./tools/inspect-context.js";
export { makeInspectAgentTool } from "./tools/inspect-agent.js";
export {
  type AnalysisContextFile,
  type AnalysisInput,
  type AnalysisSkill,
  type AnalysisTool,
  analyzeExtensions,
  formatExtensionReport,
  makeInspectExtensionsTool,
} from "./tools/inspect-extensions.js";
export { makeInspectTuiTool } from "./tools/inspect-tui.js";

// ─── Extension factory ────────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Apply SDK compatibility shim: ensures getSystemPromptOptions() is available
  // on the tool execution context (ExtensionContext). This is a memory-only
  // monkey-patch — no filesystem writes. Safe to call multiple times.
  ensureGetSystemPromptOptions();

  // getAllTools() is on ExtensionAPI (pi), not ExtensionContext (ctx).
  // Pass it as a closure into the tool so execute() can call it.
  const getAllTools = () => pi.getAllTools();
  pi.registerTool(makeInspectContextTool(getAllTools));
  pi.registerTool(makeInspectAgentTool(getAllTools));
  pi.registerTool(makeInspectExtensionsTool(getAllTools));
  pi.registerTool(makeInspectHooksTool());
  pi.registerTool(makeInspectPathologyTool());
  pi.registerTool(makeInspectTuiTool());

  // /extensions slash command: browse loaded pi-agent extensions and the
  // tools/commands/skills each provides. getAllTools closure is reused above;
  // getCommands is deferred the same way. The framework auto-attaches sourceInfo.
  const getCommands = () => pi.getCommands();
  pi.registerCommand("extensions", makeExtensionsCommand(getAllTools, getCommands));

  // Feed the pathology accumulator: observe every tool call's args + outcome so
  // inspect_pathology can detect retry loops / error storms this session.
  // After each call, surface a non-invasive status warning if a HIGH-severity
  // loop / consecutive-error is active (Phase 1.1). session_start resets
  // per-session state (diagnostics are self-contained).
  //
  // All accumulator ops are keyed by ctx.sessionManager.getSessionId() (UUIDv7,
  // distinct per SessionManager) so an in-process subagent child — same process,
  // skips session_start — gets its OWN buffer instead of polluting the parent's.
  // ctx-less callers (absent ctx/sessionManager) fall back to the "" bucket.
  // Optimization #3 / ticket #16, stage 1.
  pi.on("tool_execution_start", (e, ctx) => recordCallStart(e, ctx?.sessionManager?.getSessionId()));
  pi.on("tool_execution_end", (event, ctx) => {
    const sid = ctx?.sessionManager?.getSessionId();
    recordCallEnd(event, sid);
    surfacePathologyWarning(ctx, getCalls(sid));
  });
  pi.on("turn_end", (e, ctx) => recordTurnEnd(e, ctx?.sessionManager?.getSessionId()));
  pi.on("session_start", (_e, ctx) => {
    resetAccumulator(ctx?.sessionManager?.getSessionId());
    resetWarning();
  });
  // Delete this session's pathology bucket on shutdown so the Map doesn't grow
  // unbounded across many sessions in one process. (In-process children that
  // skip session_start also skip session_shutdown, but their buckets are tiny
  // and process-lifetime-bounded; keying already isolates them from the parent.)
  pi.on("session_shutdown", (_e, ctx) => resetAccumulator(ctx?.sessionManager?.getSessionId()));
};

export default extension;
