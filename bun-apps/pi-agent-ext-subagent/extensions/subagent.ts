import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
// Moved to @repo/pi-agent-core-runtime (in-flight registry with the dispatch
// layer; run persistence with the record layer).
import { getSubagentInFlightRegistry, getSubagentRunPersistence } from "@repo/pi-agent-core-runtime";
import { registerModelsPresetCommand } from "../extensions/models-preset.js";
import {
  convertToBackground,
  createSubagentRunsTool,
  createSubagentsTool,
  createSubagentTool,
  dispatchCtrlB,
  GLOBAL_DETACH_KEY,
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
  // Self-gate: BUN_PI_SUBAGENT=0 disables the entire extension — it registers
  // nothing and publishes no seam. Mirrors prompt-history's
  // BUN_PI_PROMPT_HISTORY=0 so every extension in the portable base set
  // (deploy-config.yaml) shares one symmetric full-disable knob; enforced by
  // tests/extension-isolation-contract.test.ts. Safe: every cross-extension
  // consumer reads its seam defensively, so disabling degrades features,
  // never crashes.
  if (process.env.BUN_PI_SUBAGENT === "0") return;
  const cwd = process.cwd();
  const extensionToolsHolder: { current: ToolDefinition[] | undefined } = { current: undefined };
  const mainModelHolder: { current: string | undefined } = { current: undefined };
  // Session model scope (--models / enabledModels). Snapshotted at session_start
  // like mainModelHolder; empty means the full catalog, i.e. no clamping.
  const scopedModelsHolder: { current: readonly string[] | undefined } = { current: undefined };

  const inFlight = getSubagentInFlightRegistry();
  const persistence = getSubagentRunPersistence();

  const subagentTool = createSubagentTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
    getMainModel: () => mainModelHolder.current,
    getScopedModels: () => scopedModelsHolder.current,
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
    getScopedModels: () => scopedModelsHolder.current,
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

  // alt+s (Task 06, rebound from ctrl+b) — GLOBAL detach: background the
  // OLDEST live foreground subagent run. Both detach key surfaces share one
  // lever: convertToBackground over makeProdDetachDeps (the /subagents
  // viewer's in-viewer ctrl+b passes the SAME assembly through the viewer's
  // onDetach seam).
  //
  // The chord itself is GLOBAL_DETACH_KEY — see src/ctrl-b.ts for the full
  // why. Short form: ctrl+b shadowed pi's built-in `tui.editor.cursorLeft`
  // (a startup conflict warning on every launch); #1481's ctrl+shift+b
  // rebound was reverted by #1492 because pi-tui has no legacy fallback for
  // ctrl+shift+<letter> — the chord was silently dead on terminals without
  // Kitty CSI-u / modifyOtherKeys. alt+<letter> HAS the legacy fallback
  // (ESC+s → "alt+s"), and alt+s is free of ALL pi built-in defaults, so it
  // claims cleanly: no warning, shadows nothing. See ADR-subagent-0004; the
  // repo-wide guard test in pi-agent/src/__tests__/extension-shortcut-guard.
  // test.ts keeps it that way.
  //
  // Terminal note: alt+s requires the terminal to send ESC+s for Option+S —
  // iTerm2: Profiles → Keys → Option key = "Esc+"; Terminal.app: "Use Option
  // as Esc+" (Preferences → Profiles → Keyboard); Ghostty and kitty pass
  // alt+s through by default.
  //
  // The scoped ctrl+b surface keeps ctrl+b deliberately — it acts only while
  // the /subagents viewer owns the input (no pi editor active), so it cannot
  // collide with built-in editor bindings: the in-viewer key in
  // subagent-viewer.ts (raw \x02 byte sniff, unregistered).
  pi.registerShortcut(GLOBAL_DETACH_KEY, {
    description: "subagent: detach foreground run to background (alt+s)",
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
    // beneath each row) now lives in ext-task's `subagents` status section.
    // Drill-down for the live trace stays `/subagents`.
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      extensionToolsHolder.current = extTools;
    }
    mainModelHolder.current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    scopedModelsHolder.current = (ctx.scopedModels ?? []).map((sm) => `${sm.model.provider}/${sm.model.id}`);
  });

  // Track runtime model switches (e.g. /model, model cycling): future dispatches
  // use the newly selected main model. Mirrors the session_start capture above;
  // in-flight runs are not mutated.
  pi.on("model_select", (event) => {
    mainModelHolder.current = event.model ? `${event.model.provider}/${event.model.id}` : undefined;
  });
}
