import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createSubagentRunsTool,
  createSubagentTool,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
} from "../src/index.js";
import { installSubagentProgressWidget } from "../src/subagent-progress-widget.js";
import { createSubagentsCommand } from "../src/subagents-command.js";

/**
 * pi-agent-ext-subagent — owns the `subagent` + `subagent_runs` tools and the
 * shared in-flight registry / run-persistence singletons. Extracted from
 * pi-agent-ext-workflow so the subagent capability loads independently of the
 * workflow DSL. The `/subagents` viewer + command + below-editor progress widget
 * live here too (self-contained), reading the local in-flight singleton directly.
 *
 * session_start captures parent-session tools + the main model from the SAME
 * sources workflow used (pi.getAllToolDefinitions / ctx.model), independently
 * of workflow's closure.
 */
export default function extension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const extensionToolsHolder: { current: ToolDefinition[] | undefined } = { current: undefined };
  const mainModelHolder: { current: string | undefined } = { current: undefined };

  const inFlight = getSubagentInFlightRegistry();
  const persistence = getSubagentRunPersistence();

  const subagentTool = createSubagentTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
    getMainModel: () => mainModelHolder.current,
    inFlight,
    persistence,
  });

  // Best-effort guard: warn if another extension already registered 'subagent'.
  try {
    const activeAtLoad = pi.getActiveTools();
    if (Array.isArray(activeAtLoad) && activeAtLoad.includes("subagent")) {
      console.warn(
        "[pi-agent-ext-subagent] a 'subagent' tool is already active; the two will shadow each other. This repo expects pi-agent-ext-subagent to own the 'subagent' name.",
      );
    }
  } catch {
    // getActiveTools may be unavailable in some hosts — best-effort only.
  }
  pi.registerTool(subagentTool);

  const subagentRunsTool = createSubagentRunsTool({ persistence });
  pi.registerTool(subagentRunsTool);

  // /subagents — list running + past subagent runs and view their output.
  // Self-contained: reads the local in-flight registry this extension owns.
  pi.registerCommand("subagents", createSubagentsCommand({ subagentInFlight: inFlight }));

  // Force-activate on EVERY lifecycle hook that precedes a system-prompt rebuild.
  // Mirrors pi-agent-ext-workflow's activateWorkflowTools: session_start alone is
  // not enough — getSystemPromptOptions().selectedTools can lag setActiveTools(),
  // so before_agent_start bridges it per-turn. Without this the registered tools
  // would not reliably appear in the model's active toolset.
  const activateSubagentTools = () => {
    try {
      const active = pi.getActiveTools();
      const missing = [subagentTool.name, subagentRunsTool.name].filter(
        (nm) => !Array.isArray(active) || !active.includes(nm),
      );
      if (missing.length) {
        pi.setActiveTools([...(Array.isArray(active) ? active : []), ...missing]);
      }
    } catch {
      // getActiveTools/setActiveTools may be unavailable in some hosts — best-effort.
    }
  };

  pi.on("before_agent_start", () => {
    activateSubagentTools();
  });

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    activateSubagentTools();
    // Always-on below-editor panel: one live line per running subagent (mirrors
    // the /subagents Running row), invisible when idle. Reads the local in-flight
    // singleton the `subagent` tool writes to.
    installSubagentProgressWidget(ctx.ui, { registry: inFlight });
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      extensionToolsHolder.current = extTools;
    }
    mainModelHolder.current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  });
}
