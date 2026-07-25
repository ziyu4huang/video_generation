import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyHostFnRegistration, HostFnRegistry } from "../src/host-fn-registry.js";
import {
  buildWorkflowGuidelinesForTurn,
  createEffortState,
  createWorkflowControlTool,
  createWorkflowHelpTool,
  createWorkflowStorage,
  createWorkflowTool,
  installResultDelivery,
  installTaskPanel,
  installWorkflowEditor,
  loadWorkflowSettings,
  redeliverPendingResults,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  saveWorkflowSettingsForCwd,
  shouldInjectFullWorkflowGuidelines,
  WorkflowManager,
} from "../src/index.js";
import { getSubagentInFlightRegistry } from "@repo/pi-agent-ext-subagent/src/index.ts";
import { createSubagentsCommand } from "../src/subagents-command.js";
import { installSubagentProgressWidget } from "../src/subagent-progress-widget.js";

export default function extension(pi: ExtensionAPI) {
  // Single manager/storage shared by the workflow tool and the /workflows command,
  // so background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  const settings = loadWorkflowSettings({ cwd });
  const manager = new WorkflowManager({
    cwd,
    loadSavedWorkflow: (name) => storage.load(name)?.script,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
  });

  // Session-scoped host-fn registry for the `call('ns.name', args)` global
  // (sub-project ②). Peer extensions register over the workflow:hostfn:v1:*
  // event bus; the registry is mutated in place so late registrations reach runs
  // started after they arrive. Load-order safe via the session_start solicitation.
  const sessionHostFns = new HostFnRegistry();
  manager.setHostFns(sessionHostFns);
  const HOSTFN_REGISTER = "workflow:hostfn:v1:register";
  const HOSTFN_REQUEST = "workflow:hostfn:v1:request";
  // `pi.events` is optional — absent in the schema-cost capturing mock and
  // any host without the event bus (see the emit-side guard + comment below).
  // Guard the host-fn registration so an absent bus skips instead of throwing
  // `undefined is not an object (evaluating 'pi.events.on')`.
  if (pi.events) {
    pi.events.on(HOSTFN_REGISTER, (payload: unknown) => applyHostFnRegistration(sessionHostFns, payload));
  }

  const workflowTool = createWorkflowTool({
    cwd,
    manager,
    storage,
    verboseWorkflowGuidelines: settings.verboseWorkflowGuidelines,
  });
  pi.registerTool(workflowTool);
  // On-demand reference companion (helpers/budget/phases/patterns/models).
  // The workflow tool's always-on guidelines stay slim; advanced docs live here
  // and appear only in the turn they are requested (tool result, not schema).
  const workflowHelpTool = createWorkflowHelpTool();
  pi.registerTool(workflowHelpTool);

  // Shared holder for parent-session tool definitions, updated in session_start.
  // WorkflowManager bridges these into child sessions so workflow-run children
  // inherit the parent's extension tools. (The `subagent` tool — now owned by
  // pi-agent-ext-subagent — reads the same set via its OWN holder; the two no
  // longer share a closure.)
  const extensionToolsHolder: { current: ToolDefinition[] | undefined } = { current: undefined };
  // Shared singleton from pi-agent-ext-subagent (process-wide). Imported via the
  // SRC subpath so the SAME module instance is shared with the subagent extension
  // (which loads via ../src/ too): the /subagents viewer reads `subagentInFlight`,
  // which the `subagent` tool writes to in the OTHER extension. (Persistence is
  // owned entirely by the subagent extension; workflow no longer touches it.)
  // The literal `.ts` (not `.js`) is required: the package `exports` map exposes
  // "./src/*" → "./src/*" verbatim, and only the `.ts` source exists under that
  // subpath — a `.js` specifier would not resolve through Bun's runtime resolver.
  const subagentInFlight = getSubagentInFlightRegistry();
  const workflowControlTool = createWorkflowControlTool({ manager });
  pi.registerTool(workflowControlTool);

  // /subagents — list running + past subagent runs and view their output.
  // Implemented in src/subagents-command.ts (extracted so the registry → viewer →
  // live-timer wiring is unit-testable without a live TUI context).
  pi.registerCommand("subagents", createSubagentsCommand({ subagentInFlight }));

  // Layer-3 conditional guideline injection. The workflow tool's authoring
  // guidelines are NO LONGER a static promptGuidelines tax on every turn; they
  // are injected here, per-turn, by before_agent_start:
  //   - workflow-intent turn (vocab match or effort armed) → full authoring block (~668 tok)
  //   - otherwise → a one-line pointer (~71 tok; tool stays always-active, so
  //     the model can still start a workflow and self-correct via workflow_help).
  // Cache cost of the per-turn swap is ~0 on BOTH cloud and local: the Goal 4
  // probes (cache-probe-workflow.mjs + cache-probe-workflow-local.mjs) confirmed
  // multi-entry prefix caching on zai AND on local LM Studio/MLX gemma
  // (transition latency 0.98× warm). Net ~−597 tok on every non-workflow turn.
  pi.on("before_agent_start", async (event: { prompt?: string; systemPrompt?: string }) => {
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const effortArmed = effort.level !== "off";
    const full = shouldInjectFullWorkflowGuidelines(prompt, effortArmed);
    const block = await buildWorkflowGuidelinesForTurn({
      full,
      verbose: settings.verboseWorkflowGuidelines,
    });
    const base = event.systemPrompt ?? "";
    return { systemPrompt: `${base}\n\n${block}` };
  });
  // Standing /effort opt-in (off|high|ultra): auto-arms a workflow for substantive
  // messages, like CC's ultracode. Shared with the editor's input hook below and
  // with the explicit /workflows run <prompt> manual trigger.
  const effort = createEffortState();
  registerWorkflowCommands(pi, manager, { storage, cwd, effort });
  registerWorkflowModelsCommand(pi);
  registerBuiltinWorkflows(pi, { cwd });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  registerEffortCommand(pi, effort);
  // "Workflows mode": type `workflow(s)` to arm a forced workflow (animated),
  // Backspace right after the word disarms it. Registers the `input` hook now;
  // the editor itself is installed once the UI is available (session_start).
  let editorInstalled = false;

  // ── Tool activation ──────────────────────────────────────────────────
  // Activate workflow + workflow_help at EVERY lifecycle hook that precedes
  // a system-prompt rebuild.  Relying on session_start alone is not enough
  // because getSystemPromptOptions().selectedTools sometimes lags behind the
  // setActiveTools() call — the before_agent_start hook below bridges that
  // gap so the tools are visible on every turn (not just after the first).
  const activateWorkflowTools = () => {
    const active = pi.getActiveTools();
    // The `subagent` + `subagent_runs` tools are activated by pi-agent-ext-subagent's
    // own before_agent_start + session_start hooks (same pattern as below); workflow
    // no longer touches their activation.
    const missing = [workflowTool.name, workflowHelpTool.name, workflowControlTool.name].filter((nm) => !active.includes(nm));
    if (missing.length) {
      pi.setActiveTools([...active, ...missing]);
    }
  };

  pi.on("before_agent_start", (_event) => {
    activateWorkflowTools();
  });

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    // Solicit host-fn registrations from peer extensions (load-order robust:
    // catches peers that loaded — and eagerly emitted — before this listener
    // existed). Peers re-emit on request; re-registering overwrites (idempotent).
    try {
      pi.events.emit(HOSTFN_REQUEST, {});
    } catch {
      // pi.events is optional in some contexts — host fns just stay absent.
    }
    activateWorkflowTools();
    // Inject extension-registered tool definitions so WorkflowAgent child
    // sessions can call the same extension tools the parent session has.
    // getAllToolDefinitions() is added by the ext-api-get-all-tool-definitions
    // runtime patch (not on the ExtensionAPI type, so we cast).
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      manager.setExtensionTools(extTools);
      extensionToolsHolder.current = extTools;
    }
    // Tell the manager the session's main model so "explore" agents auto-tier
    // down to a lighter same-family sibling (e.g. Claude → Haiku).
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    // Scope the /workflows history to this session: runs persist on disk across
    // sessions, but the navigator/task panel show only the current session's runs.
    // Switching back to a previous session re-shows that session's runs.
    try {
      manager.setSessionId(ctx.sessionManager?.getSessionId());
    } catch {
      // sessionManager may be unavailable in some contexts — fall back to global history.
    }
    // Deliver a background run's result into the conversation when it finishes.
    installResultDelivery(pi, manager);
    // Recover results for background runs that finished while no session was open
    // to receive them (the originating session closed first — e.g. a `-p` batch
    // run). Each is delivered once, then stamped so it never repeats.
    redeliverPendingResults(pi, manager);
    // Live "workflows running" panel below the input (focus + enter to open).
    // Pass a live settings loader so /workflows-progress (compact|detailed) takes
    // effect without a restart.
    installTaskPanel(pi, manager, ctx.ui, { storage, cwd, loadSettings: () => loadWorkflowSettings({ cwd }) });
    // Always-on below-editor panel: one live line per running subagent (mirrors
    // the /subagents Running row), invisible when idle. Reads the shared
    // subagentInFlight singleton the `subagent` tool writes to.
    installSubagentProgressWidget(ctx.ui, { registry: subagentInFlight });
    if (!editorInstalled) {
      installWorkflowEditor(pi, ctx.ui, effort, {
        settingsStore: {
          load: () => loadWorkflowSettings({ cwd }),
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
        },
      });
      editorInstalled = true;
    }
  });
}
