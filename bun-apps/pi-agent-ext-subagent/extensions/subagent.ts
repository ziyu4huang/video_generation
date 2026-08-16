import type { ExtensionAPI, ExtensionContext, ModelSelectEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerModelsPresetCommand } from "../extensions/models-preset.js";
import {
  convertToBackground,
  createSubagentRunsTool,
  createSubagentsTool,
  createSubagentTool,
  dispatchCtrlB,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
  makeProdDetachDeps,
} from "../src/index.js";
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

  // Ctrl+shift+b (Task 06) — GLOBAL detach: background the OLDEST live foreground
  // subagent run. Both detach surfaces share one lever: convertToBackground
  // over makeProdDetachDeps (the /subagents viewer's in-viewer ctrl+b passes
  // the SAME assembly through the viewer's onDetach seam).
  //
  // Key-claim note: ctrl+shift+b is NOT a built-in default in any of pi's
  // keybinding tables (checked docs/keybindings.md), so registering it emits
  // no conflict diagnostic. The previous ctrl+b registration shadowed pi's
  // default `tui.editor.cursorLeft` binding and triggered the startup
  // conflict warning; the in-viewer \x02 handling in subagent-viewer.ts
  // stays viewer-scoped and unaffected.
  pi.registerShortcut("ctrl+shift+b", {
    description: "subagent: detach foreground run to background (ctrl+shift+b)",
    handler: () => {
      dispatchCtrlB(inFlight, (id) => convertToBackground(id, makeProdDetachDeps({ registry: inFlight, persistence })));
    },
  });

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
    // The always-on subagent-context box (aboveEditor widget + Ctrl-O
    // \x0f onTerminalInput byte-sniff) was retired in Task 04 of the CC-style
    // subagent TUI plan; its unique collapsed-view behavior (latestMessageLine
    // beneath each row) now lives in core-task's `subagents` status section.
    // Drill-down for the live trace stays `/subagents`.
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      extensionToolsHolder.current = extTools;
    }
    mainModelHolder.current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  });

  // Track runtime model switches (e.g. /model, model cycling): future dispatches
  // use the newly selected main model. Mirrors the session_start capture above;
  // in-flight runs are not mutated.
  pi.on("model_select", (event: ModelSelectEvent) => {
    mainModelHolder.current = event.model ? `${event.model.provider}/${event.model.id}` : undefined;
  });
}
