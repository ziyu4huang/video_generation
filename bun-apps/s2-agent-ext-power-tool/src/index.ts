/// <reference types="@repo/s2-agent-core-interface" />
/**
 * s2-agent-ext-power-tool — extension factory.
 *
 * TOOL_FACTORIES below is the single inventory of what this extension provides:
 * registration iterates it, and POWER_TOOL_NAMES is derived from it. Nothing
 * else — not the CLI allowlist, not the README, not the PRD — restates the list,
 * because five places once each claimed a different tool count and only the code
 * was right. If you add a tool, add it there and everything downstream follows.
 *
 * Layering: tools/ depend on the leaves (cost, report, gating, findings); the
 * leaves depend on schema-cost/; sdk-patch depends on runner-hooks. Never the
 * other way — infra must not import a tool module.
 *
 * Usage:
 *   bun bun-apps/s2-agent/src/cli.ts -e bun-apps/s2-agent-ext-power-tool/extensions/power-tool.ts -p "call inspect_context"
 */
import type { ExtensionAPI, ExtensionFactory, ToolInfo } from "@earendil-works/pi-coding-agent";
import { ensureGetSystemPromptOptions } from "./sdk-patch.js";
import { makeExtensionsCommand } from "./extensions-command.js";
import { makeInspectContextTool } from "./tools/inspect-context.js";
import { makeInspectAgentTool } from "./tools/inspect-agent.js";
import { makeInspectExtensionsTool } from "./tools/inspect-extensions.js";
import { makeInspectHooksTool } from "./tools/inspect-hooks.js";
import { makeInspectTuiTool } from "./tools/inspect-tui.js";
import { makeBrowserTool } from "./tools/browser-tool.js";
import { makeWebuiTool } from "./tools/webui-tool.js";
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
import {
  buildSidecarRecord,
  defaultSidecarPath,
  resolveGitSha,
  writeSidecar,
} from "./history/sidecar.ts";

// ─── Public surface ───────────────────────────────────────────────────────────
// Re-exported so `@repo/s2-agent-ext-power-tool` stays one import site for
// consumers and tests. New code should prefer the owning module directly.

export { type ToolApiCost, toolApiCost } from "./cost.js";
export { type Finding, type Severity, shortPath, summarizeFindings } from "./findings.js";
export { TOKEN_RATIO, bar, est, estTok, miniBar, reportHeader } from "./report.js";
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
export { makeBrowserTool } from "./tools/browser-tool.js";
export { makeWebuiTool } from "./tools/webui-tool.js";

// ─── Tool inventory ───────────────────────────────────────────────────────────

/**
 * Every tool this extension registers. Factories that don't need `getAllTools`
 * simply ignore the argument. This array is the ONLY inventory — see the header.
 */
const TOOL_FACTORIES: ((getAllTools: () => ToolInfo[]) => { name: string })[] = [
  makeInspectContextTool,
  makeInspectAgentTool,
  makeInspectExtensionsTool,
  makeInspectHooksTool,
  makeInspectTuiTool,
  makeInspectPathologyTool,
  makeBrowserTool,
  makeWebuiTool,
];

/**
 * The registered tool names, derived by constructing each tool (the factories are
 * pure — `defineTool` just returns a descriptor). Consumers that need an allowlist
 * — notably `extensions/cli-subcommand.ts` — read this instead of hand-listing,
 * which is how `inspect_hooks` and `inspect_tui` were previously unreachable from
 * `s2-agent cli power-tool`.
 */
export const POWER_TOOL_NAMES: readonly string[] = TOOL_FACTORIES.map((make) => make(() => []).name);

// ─── Extension factory ────────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Self-gate: BUN_PI_POWER_TOOL=0 disables the entire extension — it registers
  // nothing and publishes no seam. Mirrors prompt-history's
  // BUN_PI_PROMPT_HISTORY=0 so every extension in the portable base set
  // (s2-agent.registry.yaml) shares one symmetric full-disable knob; enforced by
  // tests/extension-isolation-contract.test.ts. Safe: every cross-extension
  // consumer reads its seam defensively, so disabling degrades features,
  // never crashes.
  if (process.env.BUN_PI_POWER_TOOL === "0") return;
  // Apply SDK compatibility shim: ensures getSystemPromptOptions() is available
  // on the tool execution context (ExtensionContext). This is a memory-only
  // monkey-patch — no filesystem writes. Safe to call multiple times.
  ensureGetSystemPromptOptions();

  // getAllTools() is on ExtensionAPI (pi), not ExtensionContext (ctx).
  // Pass it as a closure into the tool so execute() can call it.
  const getAllTools = () => pi.getAllTools();
  for (const make of TOOL_FACTORIES) pi.registerTool(make(getAllTools) as never);

  // /extensions slash command: browse loaded s2-agent extensions and the
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
    // Record the environment fingerprint for longitudinal analysis. Everything
    // else the analyzer needs is derived from transcripts on demand; only these
    // facts (which commit, which tools) cannot be reconstructed later. Written
    // at session_start rather than shutdown because shutdown does not fire on a
    // crash, and crashed long sessions are among the most diagnostic ones.
    // Fully best-effort — writeSidecar swallows its own errors and this block
    // must never fail a session start.
    try {
      const cwd = process.cwd();
      writeSidecar(
        defaultSidecarPath(),
        buildSidecarRecord({
          sessionId: ctx?.sessionManager?.getSessionId() ?? "",
          ts: Date.now(),
          cwd,
          toolNames: pi.getAllTools().map((t) => t.name),
          gitSha: resolveGitSha(cwd),
        }),
      );
    } catch {
      // never break session start
    }
  });
  // Delete this session's pathology bucket on shutdown so the Map doesn't grow
  // unbounded across many sessions in one process. (In-process children that
  // skip session_start also skip session_shutdown, but their buckets are tiny
  // and process-lifetime-bounded; keying already isolates them from the parent.)
  pi.on("session_shutdown", (_e, ctx) => resetAccumulator(ctx?.sessionManager?.getSessionId()));
};

export default extension;
