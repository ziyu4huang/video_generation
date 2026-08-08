import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerModelsPresetCommand } from "../extensions/models-preset.js";
import {
  createSubagentRunsTool,
  createSubagentsTool,
  createSubagentTool,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
} from "../src/index.js";
import { installSubagentContextWidget, isCtrlO } from "../src/subagent-context-widget.js";
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
    // Parent's gated active set, read lazily at spawn time so a child inherits
    // the freshest ~24-tool gated set (optimization #1), not the full ~55-tool
    // universe. Best-effort: getActiveTools may be unavailable in some hosts.
    getActiveTools: () => {
      try {
        return pi.getActiveTools();
      } catch {
        return undefined;
      }
    },
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

  // subagents — the plural batch tool (fan-out wraps spawnSubagent).
  // Same options shape as subagentTool: parent tools + main model holders,
  // shared in-flight registry + run-persistence singletons.
  const subagentsTool = createSubagentsTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
    getMainModel: () => mainModelHolder.current,
    getActiveTools: () => {
      try {
        return pi.getActiveTools();
      } catch {
        return undefined;
      }
    },
    inFlight,
    persistence,
  });
  pi.registerTool(subagentsTool);

  // /subagents — list running + past subagent runs and view their output.
  // Self-contained: reads the local in-flight registry this extension owns.
  pi.registerCommand("subagents", createSubagentsCommand({ subagentInFlight: inFlight }));

  // /models-preset — apply a named model-config preset (tiers + vision) to
  // ~/.pi/workflows/model-tiers.json. The one-stop setup/switch command; pairs
  // with /workflows-models (fine-edit). Preset templates live in src/presets.ts.
  registerModelsPresetCommand(pi);

  // Force-activate on EVERY lifecycle hook that precedes a system-prompt rebuild.
  // Mirrors pi-agent-ext-workflow's activateWorkflowTools: session_start alone is
  // not enough — getSystemPromptOptions().selectedTools can lag setActiveTools(),
  // so before_agent_start bridges it per-turn. Without this the registered tools
  // would not reliably appear in the model's active toolset.
  const activateSubagentTools = () => {
    try {
      const active = pi.getActiveTools();
      const missing = [subagentTool.name, subagentRunsTool.name, subagentsTool.name].filter(
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
    // Unified subagent-context box (ABOVE the editor): live-renders every
    // background/concurrent run that ISN'T already shown inline by Surface A
    // (the current turn's subagent/subagents call lines register `foreground:
    // true` and are excluded). Invisible when idle. Replaces the old
    // below-editor progress widget; drill-down via `/subagents`.
    const widgetHandle = installSubagentContextWidget(ctx.ui, { registry: inFlight });
    // Ctrl-O toggles the box's expanded/collapsed state. Ctrl-O is the RESERVED
    // `app.tools.expand` keybinding, so pi.registerShortcut CANNOT claim it
    // (silently rejected) — the raw ctx.ui.onTerminalInput hook bypasses the
    // reserved list. We return { consume: false } so the 0x0F byte ALSO reaches
    // the editor, where the default `app.tools.expand` action (setToolsExpanded)
    // fires: Ctrl-O therefore expands/collapses BOTH the box and the inline
    // tool output together ("show all detail"). Verified in the pi-tui host:
    // handleTerminalInput runs inputListeners first and only stops when a
    // listener returns consume:true — a non-consuming return lets the byte
    // proceed to the focused component's handleInput (the keybinding path).
    // onTerminalInput is interactive-mode only; RPC/print hosts stub it — guard
    // for robustness against partial-ui mocks.
    if (ctx.ui && typeof ctx.ui.onTerminalInput === "function") {
      ctx.ui.onTerminalInput((data) => {
        if (isCtrlO(data)) widgetHandle.toggle();
        return { consume: false };
      });
    }
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      extensionToolsHolder.current = extTools;
    }
    mainModelHolder.current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  });
}
