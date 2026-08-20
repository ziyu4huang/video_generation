import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
// The in-flight registry singleton MUST resolve to the SAME module instance the
// subagent extension + obsidian extension use. Imported via the package barrel
// (`@repo/pi-agent-core-runtime`) — verified to share one instance with the
// subagent extension + obsidian extension under the isolated linker (see the
// singleton docstring in src/subagent-in-flight.ts).
import { getSubagentInFlightRegistry, setRateLimitCapResolver } from "@repo/pi-agent-core-runtime";
import { applyHostFnRegistration, HostFnRegistry } from "../src/host-fn-registry.js";
import {
  buildWorkflowGuidelinesForTurn,
  createEffortState,
  createWorkflowControlTool,
  createWorkflowHelpTool,
  createWorkflowStorage,
  createWorkflowTool,
  getRateLimit,
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
import { shellRunHostFn } from "../src/shell-host-fn.js";

// ─── Gate family (wayfinder ticket 01 — reference form) ─────────────────────
// Declared ONCE by id, shared by the CROSS-PACKAGE workflow/subagent family:
// workflow / workflow_help / workflow_control (this package) + subagent /
// subagents (pi-agent-ext-subagent) all reference `gating: { gate: "workflow" }`
// so buildEffectiveGates groups all five into ONE co-firing gate (names[0] ===
// "workflow"). The former per-tool verbatim duplication across two packages is
// gone — edit the family here, all five tools follow.
GATE_DEFS["workflow"] = {
  id: "workflow",
  keywords: ["workflow", "pipeline", "orchestrate", "fan-out", "fan out", "parallel agent", "multi-step"],
  description: "Deterministic workflow orchestration + control",
};

/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime
 * `gating` object). Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts.
 * Plain object: no `satisfies` / type import, so this extension never depends
 * on tool-gate (avoids a circular dep); shape is enforced by tool-gate's
 * drift-guard test. Dispatch gate → controls-only (recallFloor 0, adversarial
 * []): narrow keywords are intentional, so we assert the predicate fires on
 * its own keywords, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
  // Canonical gate id = GATES[].names[0] = the first-registered family tool's
  // NAME — "run_workflow" since the 2026-08-20 verb_object rename (was "workflow";
  // see docs/agents/extension-naming.md). The GATE_DEFS family id stays "workflow".
  gate: "run_workflow",
  recallFloor: 0,
  adversarial: [],
  controls: ["orchestrate a fan-out of tasks", "run a multi-step pipeline", "用 workflow 編排"],
};

export default function extension(pi: ExtensionAPI) {
  // Self-gate: BUN_PI_WORKFLOW=0 disables the entire extension — it registers
  // nothing and publishes no seam. Mirrors prompt-history's
  // BUN_PI_PROMPT_HISTORY=0 so every extension in the portable base set
  // (pi-agent.registry.yaml) shares one symmetric full-disable knob; enforced by
  // tests/extension-isolation-contract.test.ts. Safe: every cross-extension
  // consumer reads its seam defensively, so disabling degrades features,
  // never crashes.
  if (process.env.BUN_PI_WORKFLOW === "0") return;
  // Single manager/storage shared by the workflow tool and the /workflows command,
  // so background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  const settings = loadWorkflowSettings({ cwd });
  // Register the rateLimits config resolver so BOTH this workflow's agent
  // dispatch and the `subagents`/`subagent` tools (pi-agent-ext-subagent) share
  // ONE per-provider concurrency budget. The resolver closes over the boot-time
  // settings snapshot (mirrors defaultConcurrency handling); `undefined` for an
  // unset provider means pass-through, so the cap is a no-op until configured.
  setRateLimitCapResolver((provider) => getRateLimit(settings, provider));
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
  // Register built-in shell.run host-fn (generic command execution for templates).
  applyHostFnRegistration(sessionHostFns, shellRunHostFn);
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
    // Process-wide singleton (decision 03 = b2): the SAME registry instance the
    // subagent/subagents tools + the unified context box + /subagents read, so
    // workflow runs surface in all three. Verified same module instance across
    // packages (root import resolves to one subagent-in-flight.ts module).
    inFlight: getSubagentInFlightRegistry(),
  });
  pi.registerTool(workflowTool);
  // On-demand reference companion (helpers/budget/phases/patterns/models).
  // The workflow tool's always-on guidelines stay slim; advanced docs live here
  // and appear only in the turn they are requested (tool result, not schema).
  const workflowHelpTool = createWorkflowHelpTool({ getScopedModels: () => manager.getScopedModels() });
  pi.registerTool(workflowHelpTool);

  // Shared holder for parent-session tool definitions, updated in session_start.
  // WorkflowManager bridges these into child sessions so workflow-run children
  // inherit the parent's extension tools. (The `subagent` tool — now owned by
  // pi-agent-ext-subagent — reads the same set via its OWN holder; the two no
  // longer share a closure.)
  const extensionToolsHolder: { current: ToolDefinition[] | undefined } = { current: undefined };
  const workflowControlTool = createWorkflowControlTool({ manager });
  pi.registerTool(workflowControlTool);

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
      // Same scope the dispatch clamp enforces, so the prompt cannot advertise
      // a model the session has excluded.
      scopedModels: manager.getScopedModels(),
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
    // The `spawn_subagent` + `list_subagent_runs` tools (renamed 2026-08-20 —
    // docs/agents/extension-naming.md) are activated by pi-agent-ext-subagent's
    // own before_agent_start + session_start hooks (same pattern as below); workflow
    // no longer touches their activation.
    const missing = [workflowTool.name, workflowHelpTool.name, workflowControlTool.name].filter(
      (nm) => !active.includes(nm),
    );
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
    // Session model scope (ticket 11): CLI --models / enabledModels restricts the
    // models this session may use. Snapshotted once at session start — empty when
    // no scoping is configured (full catalog). In-flight runs are not mutated,
    // mirroring setMainModel above.
    manager.setScopedModels((ctx.scopedModels ?? []).map((sm) => `${sm.model.provider}/${sm.model.id}`));
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

  // Track runtime model switches (e.g. /model, model cycling): future agent
  // dispatches auto-tier against the newly selected main model. Mirrors the
  // session_start capture above; in-flight runs are not mutated.
  pi.on("model_select", (event) => {
    manager.setMainModel(event.model ? `${event.model.provider}/${event.model.id}` : undefined);
  });
}
