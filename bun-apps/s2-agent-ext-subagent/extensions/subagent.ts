import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
// Moved to @repo/s2-agent-core-runtime (in-flight registry with the dispatch
// layer; run persistence with the record layer).
import {
  getLiveAgentRegistry,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
  setTransientModelTierConfig,
} from "@repo/s2-agent-core-runtime";
import { registerModelsPresetCommand } from "../extensions/models-preset.js";
import {
  convertToBackground,
  createSendMessageTool,
  createSubagentRunsTool,
  createSubagentsTool,
  createSubagentTool,
  dispatchCtrlB,
  GLOBAL_DETACH_KEY,
  getBackgroundRunManager,
  getParentMessageBus,
  makeProdDetachDeps,
  wireBackgroundDeliverer,
  wireParentMessageDeliverer,
} from "../src/index.js";
import { createSubagentsCommand } from "../src/subagents-command.js";

/**
 * s2-agent-ext-subagent — owns the `subagent` + `subagent_runs` tools and the
 * shared in-flight registry / run-persistence singletons. Extracted from
 * s2-agent-ext-ultracode so the subagent capability loads independently of the
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
  // (s2-agent.registry.yaml) shares one symmetric full-disable knob; enforced by
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
  // Named live agents (agent-teams parity, ticket 01): the process-singleton
  // registry the spawn tool registers persistent sessions into. session_shutdown
  // (quit/reload/new/resume/fork) disposes them all — they are in-process child
  // sessions whose parent addressability ends with the session.
  const liveRegistry = getLiveAgentRegistry();
  // Background roster (spawn_subagent background:true) + its completion
  // notifier. Wiring the deliverer here is the followUp wake seam: a finished
  // background run queues a <task-notification> via pi.sendMessage(..., followUp)
  // — best-effort; without it results still land in run-persistence.
  const backgroundManager = getBackgroundRunManager();
  wireBackgroundDeliverer(pi, backgroundManager);
  // Child→parent messaging (ticket 02): a child's send_message to:"main"
  // publishes through this process-singleton bus; its deliverer uses the SAME
  // followUp + triggerTurn wake seam as the background deliverer above.
  wireParentMessageDeliverer(pi, getParentMessageBus());

  const subagentTool = createSubagentTool({
    cwd,
    liveRegistry,
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
    background: backgroundManager,
  });

  // Best-effort guard: warn if another extension already registered
  // 'spawn_subagent' (renamed from 'subagent' 2026-08-20 — docs/agents/extension-naming.md).
  try {
    const activeAtLoad = pi.getActiveTools();
    if (Array.isArray(activeAtLoad) && activeAtLoad.includes("spawn_subagent")) {
      console.warn(
        "[s2-agent-ext-subagent] a 'spawn_subagent' tool is already active; the two will shadow each other. This repo expects s2-agent-ext-subagent to own the 'spawn_subagent' name.",
      );
    }
  } catch {
    // getActiveTools may be unavailable in some hosts — best-effort only.
  }
  pi.registerTool(subagentTool);

  const subagentRunsTool = createSubagentRunsTool({ persistence, inFlight, background: backgroundManager });
  pi.registerTool(subagentRunsTool);

  // send_message — follow-up messaging for named live agents (ticket 02):
  // parent-side routing over the live registry + child-side to:"main" over the
  // bus wired above. Reaches children automatically through the parent tools
  // captured at session_start (extensionTools bridge).
  const sendMessageTool = createSendMessageTool({ liveRegistry, bus: getParentMessageBus() });
  pi.registerTool(sendMessageTool);

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

  // /models-preset — TRANSIENTLY switch this session's model config: main
  // model (pi.setModel) + subagent tier/vision routing (in-memory transient
  // override). Never writes ~/.pi — ADR-subagent-0006. Preset templates live
  // in src/presets.ts; pairs with /workflows-models (persisted fine-edit).
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
  // repo-wide guard test in s2-agent/src/__tests__/extension-shortcut-guard.
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
  // Mirrors s2-agent-ext-ultracode's activateWorkflowTools: session_start alone is
  // not enough — getSystemPromptOptions().selectedTools can lag setActiveTools(),
  // so before_agent_start bridges it per-turn. Without this the registered tools
  // would not reliably appear in the model's active toolset.
  const activateSubagentTools = () => {
    try {
      const active = pi.getActiveTools();
      const missing = [subagentTool.name, subagentRunsTool.name, subagentsTool.name, sendMessageTool.name].filter(
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
    // A preset applied via /models-preset is SESSION-scope (ADR-subagent-0006):
    // starting or switching a session resets tier routing to the file/built-in
    // config. (Also covers the initial session — a no-op clear.)
    setTransientModelTierConfig(null);
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

  // Named live agents die with the session that owns them (quit / reload / new /
  // resume / fork all fire session_shutdown). disposeFor("*") because entries
  // default to the unknown-owner scope — in this process there is exactly one
  // parent session at a time.
  pi.on("session_shutdown", () => {
    liveRegistry.disposeFor("*");
  });
}
