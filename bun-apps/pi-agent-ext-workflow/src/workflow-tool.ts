import { existsSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentInFlightRegistry } from "@repo/pi-agent-core-runtime";
import {
  fmtCost,
  listAgentTypes,
  listAvailableModelSpecs,
  loadAgentRegistry,
  WorkflowError,
  WorkflowErrorCode,
} from "@repo/pi-agent-core-runtime";
import { Type } from "typebox";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { resolvePackRunContext } from "./pack-run-context.js";
import type { WorkflowRunResult } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { findRepoRoot, mergeArgs, resolveWorkflowPack } from "./workflow-pack.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";
import { parseWorkflowScript } from "./workflow-script-parser.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/**
 * Model routing guideline for workflow authors.
 * Tells the LLM about opts.tier (small/medium/big) for runtime-enforced
 * model selection, and opts.model for an exact provider/id override.
 *
 * This string is injected into the workflow tool's promptGuidelines and
 * therefore appears in the LLM's system prompt for every workflow execution.
 */
export async function modelRoutingGuideline(scopedSpecs?: readonly string[]): Promise<string> {
  // Session scope (--models / enabledModels) narrows what the model may route
  // to. Without this the guideline advertised the FULL catalog while telling
  // the model "route only to these" — so under a scoped session we asked for
  // models the session had excluded and then silently clamped the resulting
  // dispatches. The picker and the prompt now agree.
  const available = scopedSpecs?.length ? [...scopedSpecs] : await listAvailableModelSpecs();
  const list = available.length
    ? `The user's currently available models (route only to these) are: ${available.join(", ")}.`
    : "Use models the user has configured.";
  return [
    "For workflow, the user configures per-tier models (/workflows-models), so TAG EVERY agent with opts.tier by role so those models are actually used.",
    "opts.tier accepts 'small', 'medium', or 'big' and is enforced at runtime.",
    "Small tier: lightweight exploration/search/inventory agents.",
    "Medium tier: balanced analysis agents.",
    "Big tier: synthesis/judgment/decision agents spanning the full context.",
    "An agent with no opts.tier and no opts.model falls back to the user's medium tier; do not rely on that — tag agents explicitly so small/big are used where they fit.",
    "If the user named a specific model, use opts.model with that exact provider/id; opts.model always takes precedence over opts.tier.",
    list,
  ].join(" ");
}

/**
 * Tells the LLM which named subagent definitions (agentType) are available, so
 * it can route an agent() to a reusable role that binds tools+model+prompt.
 * Returns undefined when no definitions are registered (nothing to advertise).
 */
export function agentTypeGuideline(cwd: string = process.cwd()): string | undefined {
  let types: Array<{ name: string; description?: string }>;
  try {
    types = listAgentTypes(loadAgentRegistry(cwd));
  } catch {
    return undefined;
  }
  if (!types.length) return undefined;
  const list = types.map((t) => (t.description ? `${t.name} (${t.description})` : t.name)).join(", ");
  return `For workflow, opts.agentType routes an agent to a named definition that binds its tools, model, and role prompt. Available agentTypes: ${list}. An explicit opts.model still overrides the definition's model.`;
}

// ─── On-demand reference docs (deferred from the always-on guidelines) ───────
//
// The workflow tool's always-on promptGuidelines keep only correctness-essential
// bullets (JS-only, meta header, globals, parallel()/null rules, budget-default,
// background-default, model-routing essentials). The ADVANCED reference below is
// served on demand by `workflow_help` — a tool RESULT that lives in conversation
// history, so it appears only in the turn it is requested, never in the static
// schema. Each doc is extracted (verbatim) from the verbose guideline set, so
// there is zero information loss vs. verbose mode; the full available-model list
// is also served here (topic "models") so the always-on guidelines no longer
// inline it. modelRoutingGuideline() itself is unchanged (its unit tests hold).

/** Quality helpers: verify / judgePanel / loopUntilDry / completenessCheck. */
function workflowHelpersDoc(): string {
  return "For workflow, prefer the built-in quality helpers when they fit (each is built on agent()/parallel() and returns plain data): verify(item, {reviewers, threshold, lens}) for adversarial fact-checking; judgePanel(attempts, {judges, rubric}) to score N candidates and return the best; loopUntilDry({round, key, consecutiveEmpty}) to keep finding until rounds stop yielding new items; completenessCheck(args, results) as a final 'what's missing' critic.";
}

/** Spend control: tokenBudget, phase budget, retry, gate, graceful degrade. */
function workflowBudgetDoc(): string {
  return "For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; the defaults are unbounded. To bound spend: pass tokenBudget for a hard run-wide cap; carve a per-phase ceiling with phase('Name', {budget: N}) (that phase throws at its sub-budget without touching the run total — wrap its work in try/catch so later phases proceed); use retry(thunk, {attempts, until}) for bounded retry, and gate(thunk, validator, {attempts}) when a validator's feedback should steer the next attempt. To degrade gracefully, branch on budget.remaining() to skip optional rounds or choose a lighter tier.";
}

/** Phase tracking: phase('Exact Title') switching, declared-vs-entered semantics. */
function workflowPhasesDoc(): string {
  return "For workflow, when meta.phases declares more than one phase, call phase('Exact Title') at the start of each phase's work (or set opts.phase on each agent) so every agent groups under the correct phase; never declare a phase you don't switch into — a declared phase with no agents shows as 0/0 and any agent you forgot to move stays in the previous phase.";
}

/** Patterns: when-to-decompose, pipeline(), labels, synthesis agent, opts.schema, concurrency/retries. */
function workflowPatternsDoc(): string {
  return [
    "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
    "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
    "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
    "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
    "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
    "For workflow, use low concurrency and agentRetries for unstable provider/transport fan-out runs; retries apply only to recoverable agent failures and still require explicit null handling after exhaustion.",
  ].join("\n");
}

/**
 * Slim, always-on model-routing bullet: tier tagging + opts.model priority,
 * WITHOUT inlining the full available-model list (which is large and only
 * needed when picking an exact opts.model). The full list is served by
 * workflow_help({topic:"models"}) → modelRoutingGuideline().
 */
function modelRoutingEssentialGuideline(): string {
  return "For workflow, the user configures per-tier models, so TAG EVERY agent with opts.tier by role: 'small' for lightweight exploration/search/inventory, 'medium' for balanced analysis, 'big' for synthesis/judgment/decision. opts.tier ('small'|'medium'|'big') is enforced at runtime. If the user named a specific model, pass it verbatim as opts.model (provider/id); opts.model always overrides opts.tier. An agent with neither falls back to the user's medium tier — don't rely on that, tag explicitly. Call workflow_help({topic:\"models\"}) for the exact list of currently-available model IDs.";
}

const WORKFLOW_HELP_TOPIC_ENUM = StringEnum(["helpers", "budget", "phases", "patterns", "models"] as const, {
  description: "Reference topic: helpers | budget | phases | patterns | models.",
});

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script, with no Markdown fences.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
        "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
        "Mutually exclusive with `name`: provide exactly one of `script` (inline) or `name` (an installed pack).",
      ].join(" "),
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: [
        "Run an installed workflow pack by name (or path), resolved under .pi/workflows/ or bun-apps/<pkg>/workflows/.",
        "The pack's manifest.json provides default args (shallow-merged under `args`) and identity; its entry script supplies export const meta.",
        "Mutually exclusive with `script`: provide exactly one of `name` (a pack) or `script` (inline).",
      ].join(" "),
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the workflow in the background. Default: true — the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when it finishes. Set to false only when you need the result inline in this same turn (the call will block until the workflow completes).",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Number({
      description: "Maximum number of agents allowed in this run. Default: 1000.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      description:
        "Maximum concurrent agents for this run. Clamped to the runtime maximum. Use when provider/transport stability matters.",
    }),
  ),
  agentRetries: Type.Optional(
    Type.Number({
      description:
        "Retry attempts for recoverable agent failures such as timeout, connection failure, or empty assistant output. Default 0 unless configured.",
    }),
  ),
  agentTimeoutMs: Type.Optional(
    Type.Number({
      description:
        "Timeout per agent in milliseconds. Omit for no hard timeout by default. Set only when the user asks to bound time.",
    }),
  ),
  tokenBudget: Type.Optional(
    Type.Number({
      description:
        "Hard total-token budget for the whole run. Once spent reaches it, further agent() calls fail and the run stops. Omit for no limit. Set it when the user asks to cap spend.",
    }),
  ),
});

export type WorkflowToolInput = {
  /** Inline workflow script. Exactly one of `script` / `name` is required. */
  script?: string;
  /** Installed workflow-pack name or path. Exactly one of `script` / `name` is required. */
  name?: string;
  args?: unknown;
  background?: boolean;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  tokenBudget?: number;
};

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
  /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default max concurrent agents when no tool-level concurrency is passed. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /**
   * When true, inject the full set of workflow guidelines (22 bullets, ~7k chars).
   * Default false: only the essential subset is injected (~13 bullets, ~3.5k chars)
   * to save context-window tokens.
   * Controlled via workflowSettings.verboseWorkflowGuidelines.
   */
  verboseWorkflowGuidelines?: boolean;
  /**
   * Extension-registered tool definitions inherited from the parent session.
   * Passed through to child WorkflowAgent sessions so workflow subagents can
   * call the same extension tools the parent session has.
   */
  extensionTools?: ToolDefinition[];
  /**
   * Shared in-flight registry (decision 03 = b2). Threaded into the manager so
   * every workflow run registers into the SAME registry the subagent/subagents
   * tools + the unified context box + /subagents read. The extension obtains the
   * process singleton via getSubagentInFlightRegistry() and passes it here.
   */
  inFlight?: SubagentInFlightRegistry;
}

/**
 * The default workflow-authoring guideline set, injected on workflow-intent
 * turns (the ~12-bullet set). Covers correctness essentials (JS-only, globals,
 * parallel()/null rules, budget safety, background-default, model-routing
 * essentials). The advanced reference (quality helpers, phase tracking,
 * synthesis/pipeline patterns, retry/concurrency tuning, the full
 * available-model list) is served on demand by workflow_help({topic}), not
 * inlined — see workflowHelpersDoc() etc. below.
 *
 * NOTE: these guidelines are NO LONGER a static `promptGuidelines` on the
 * workflow tool. They are injected per-turn by the extension's
 * `before_agent_start` handler (see buildWorkflowGuidelinesForTurn below) —
 * full on workflow-intent turns, a one-line pointer otherwise. This keeps the
 * workflow tool discoverable (always-active + promptSnippet) without paying
 * the always-on guideline tax on non-workflow turns.
 */
export function buildSimplifiedGuidelines(): string[] {
  return [
    "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
    "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
    "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
    "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
    "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, and budget. Every workflow must call agent() at least once.",
    "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
    "For workflow, failed agent(), parallel(), or pipeline() branches return null — always filter nulls before synthesizing conclusions.",
    "For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; the defaults are unbounded.",
    "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    "For workflow, runs are background by default: the tool returns immediately with a run ID, and the result is delivered back into the conversation when it finishes. Pass background: false only when you must use the result inline in this same turn.",
    modelRoutingEssentialGuideline(),
    agentTypeGuideline(),
    'For workflow, advanced reference is NOT inlined here — call workflow_help({topic}) on demand: "helpers" (verify/judgePanel/loopUntilDry/completenessCheck), "budget" (tokenBudget/phase budget/retry/gate), "phases" (phase() tracking), "patterns" (pipeline()/opts.schema/synthesis), "models" (full available-model list).',
  ].filter((g): g is string => typeof g === "string" && g.length > 0);
}

/**
 * The verbose workflow-authoring guideline set (~22 bullets), used when the
 * user opts into verboseWorkflowGuidelines. Inlines the advanced reference
 * (quality helpers, phase tracking, budget bounding, pipeline patterns) that
 * the simplified set defers to workflow_help. Extracted verbatim from the old
 * static promptGuidelines so verbose-mode behavior is byte-identical.
 */
export async function buildVerboseGuidelines(scopedModels?: readonly string[]): Promise<string[]> {
  return [
    "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
    "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
    "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
    "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
    "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
    "For workflow, prefer the built-in quality helpers when they fit (each is built on agent()/parallel() and returns plain data): verify(item, {reviewers, threshold, lens}) for adversarial fact-checking; judgePanel(attempts, {judges, rubric}) to score N candidates and return the best; loopUntilDry({round, key, consecutiveEmpty}) to keep finding until rounds stop yielding new items; completenessCheck(args, results) as a final 'what's missing' critic.",
    "For workflow, when meta.phases declares more than one phase, call phase('Exact Title') at the start of each phase's work (or set opts.phase on each agent) so every agent groups under the correct phase; never declare a phase you don't switch into — a declared phase with no agents shows as 0/0 and any agent you forgot to move stays in the previous phase.",
    "For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; the defaults are unbounded.",
    "For workflow, to bound spend: pass tokenBudget for a hard run-wide cap; carve a per-phase ceiling with phase('Name', {budget: N}) (that phase throws at its sub-budget without touching the run total — wrap its work in try/catch so later phases proceed); use retry(thunk, {attempts, until}) for bounded retry, and gate(thunk, validator, {attempts}) when a validator's feedback should steer the next attempt. To degrade gracefully, branch on budget.remaining() to skip optional rounds or choose a lighter tier. For a HARD mid-run cap on a single agent, pass tokenBudget/spendBudget on that agent() call — it aborts that agent mid-run (distinct from the run-wide soft Budget above).",
    "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
    "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
    "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
    "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
    "For workflow, use low concurrency and agentRetries for unstable provider/transport fan-out runs; retries apply only to recoverable agent failures and still require explicit null handling after exhaustion.",
    "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
    "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
    "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
    await modelRoutingGuideline(scopedModels),
    agentTypeGuideline(),
    "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    "For workflow, runs are background by default: the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when the run finishes. Pass background: false only when you must use the result inline in this same turn (it will block).",
    "For workflow, you may call `await workflow('saved-name', argsObject)` to run a saved workflow inline and use its result; nesting is one level deep only, and the global 16-concurrent / 1000-total caps hold across the nesting.",
  ].filter((g): g is string => typeof g === "string" && g.length > 0);
}

/**
 * The slim one-line pointer injected on NON-workflow turns. Tells the model the
 * workflow tool exists and where full authoring guidance loads from, without
 * paying the full guideline block's token cost. The model can still
 * spontaneously start a workflow (tool stays always-active) and self-correct
 * via workflow_help.
 */
export function buildWorkflowPointerGuideline(): string {
  return [
    "For workflow, the workflow tool is available for deterministic multi-agent orchestration (fan-out/pipeline/parallel subagents).",
    "Full authoring guidance loads on demand via workflow_help({topic}) — call it before authoring a script, or it loads automatically when you start a workflow.",
  ].join(" ");
}

/**
 * Conservative keep-when-unsure intent detector. Returns true when the current
 * turn looks like a workflow turn (full guidelines injected), false when it is
 * clearly a plain/direct action (only the pointer is injected).
 *
 * Signals (any one → full):
 *   - effort mode armed (high|ultra): standing workflow context.
 *   - workflow vocabulary in the prompt: explicit ask OR decomposable-work
 *     verbs (fan-out, orchestrate, multi-agent, subagent, pipeline of agents,
 *     research/survey/audit/investigate/analyze/review the codebase/repo/...).
 *
 * Ambiguous prompts that match none of these still get the pointer, NOT full —
 * because the pointer itself advertises the tool + workflow_help, so a
 * workflow the model decides to start mid-turn still self-corrects. This is
 * the intended safety: near-zero false-NEGATIVE cost (authoring never breaks)
 * while saving the guideline tax on the common file/read/edit/test turns.
 */
const WORKFLOW_INTENT_RE =
  /\b(workflows?|fan[- ]?out|orchestrat\w*|multi[- ]?agent|sub[- ]?agents?|parallel\s+agents|pipeline\s+of\s+agents|run\s+a\s+workflow)\b|\b(research|survey|audit|investigate|review|analyze|analyse)\s+(the|this|all|every|our)\s+\w+/i;

export function shouldInjectFullWorkflowGuidelines(prompt: string, effortArmed: boolean): boolean {
  if (effortArmed) return true;
  if (!prompt) return false;
  return WORKFLOW_INTENT_RE.test(prompt);
}

export interface WorkflowGuidelinesForTurnOptions {
  /** True → inject the full authoring block; false → inject the pointer. */
  full: boolean;
  /** When full, use the verbose ~22-bullet set instead of the default ~12. */
  verbose?: boolean;
  /**
   * The session's model scope (`provider/id` specs from --models /
   * enabledModels). When non-empty, the model-routing bullet advertises ONLY
   * these instead of the full catalog — otherwise the prompt tells the model to
   * "route only to" models the session has excluded, and the resulting
   * dispatches get silently clamped. Empty/undefined = full catalog.
   */
  scopedModels?: readonly string[];
}

/**
 * Single source of truth for what the before_agent_start handler appends to the
 * system prompt each turn. Returns one block string (full set joined by
 * newlines, or the pointer). The extension handler simply does
 * `{ systemPrompt: base + "\n\n" + block }`.
 */
export async function buildWorkflowGuidelinesForTurn(options: WorkflowGuidelinesForTurnOptions): Promise<string> {
  if (options.full) {
    return (options.verbose ? await buildVerboseGuidelines(options.scopedModels) : buildSimplifiedGuidelines()).join(
      "\n",
    );
  }
  return buildWorkflowPointerGuideline();
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  const storage = options.storage ?? createWorkflowStorage(options.cwd ?? process.cwd());
  const cwd = options.cwd ?? process.cwd();
  // Read settings from disk ONLY when constructing the fallback manager. When
  // the extension supplies options.manager (the normal path), skip the read.
  // The `?? null` / `?? 0` mirror WorkflowManager's own constructor defaults so
  // behavior is identical when fallbackDefaults is present.
  const fallbackDefaults = options.manager ? undefined : resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: fallbackDefaults?.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: fallbackDefaults?.agentTimeoutMs ?? null,
      defaultAgentRetries: fallbackDefaults?.agentRetries ?? 0,
      extensionTools: options.extensionTools,
    });
  // Thread the shared in-flight registry (decision 03 = b2) into the manager so
  // every workflow run — background AND foreground, tool AND /workflows command
  // AND resume — registers into the SAME singleton the subagent/subagents tools,
  // the unified context box, and /subagents read. The manager is the shallowest
  // seam that observes run start + completion at per-workflow granularity; called
  // once at tool construction (before any run), idempotent for a passed-in manager.
  if (options.inFlight) manager.setInFlight(options.inFlight);

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "Provide exactly one of: `script` (raw JavaScript starting with export const meta = { name, description, phases? }, calling agent() at least once) OR `name` (an installed workflow pack under .pi/workflows/ or bun-apps/<pkg>/workflows/, resolved via its manifest.json).",
    ].join(" "),
    // Owner-declared gating — migrated from tool-gate's hardcoded GATES (was the
    // {names:["workflow","workflow_help","subagent","workflow_control"]} combined
    // gate; tickets 10 + 11 rolled out TOGETHER as one atomic unit because they
    // SHARE that single combined gate). Per the semantics-preserving rule, the
    // SAME gating (keywords only, no `requires`) is mirrored IDENTICALLY on all
    // 4 tools so they activate together and reconstructOwnerDeclaredGates
    // collapses them back into one 4-name gate (names[0] === "workflow") —
    // preserving the original co-fire behavior. Mirrors the original GATES entry
    // verbatim (keywords were unambiguous workflow/orchestration intents that
    // never false-fired the way image/video nouns do, so no requires is needed).
    gating: { gate: "workflow" }, // reference form (ticket 01) — family in GATE_DEFS["workflow"] (workflow ext)
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }.",
    // Guidelines are NO LONGER static here — they are injected per-turn by the
    // extension's before_agent_start handler (buildWorkflowGuidelinesForTurn):
    // full authoring block on workflow-intent turns, a one-line pointer
    // otherwise. The tool stays always-active for discoverability; see
    // extensions/workflow.ts. Keeping the tool's schema slim saves ~722 tok
    // (the full guideline block) on every non-workflow turn.
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Exactly one of `script` (inline JS) or `name` (installed pack) is allowed.
      // A pack is resolved to its entry script text here; manifest default args are
      // shallow-merged under `params.args` (caller wins). manifest.model is NOT
      // applied on this path — the session's mainModel governs (per-run model
      // would need an ExecOptions.mainModel hook; see workflow-pack plan, OOS).
      let script: string;
      let mergedArgs = params.args;
      // T7: pack-local context (identity + state root + dirs + io) resolved once at
      // the tool layer and spread into both execution paths below. Undefined for
      // inline scripts → legacy cwd-scoped persistence (decision 13).
      let packCtx: ReturnType<typeof resolvePackRunContext> | undefined;
      if (params.name) {
        const resolved = resolveWorkflowPack(params.name, { cwd });
        script = resolved.script;
        if (resolved.manifest) mergedArgs = mergeArgs(resolved.manifest.args, params.args);
        if (resolved.packDir) {
          packCtx = resolvePackRunContext({
            name: resolved.manifest?.name ?? params.name,
            packDir: resolved.packDir,
            manifest: resolved.manifest,
            repoRoot: findRepoRoot(resolved.packDir, (p) => existsSync(p)) ?? cwd,
          });
        }
      } else {
        if (typeof params.script !== "string") {
          throw new Error("workflow requires exactly one of `script` (inline JS) or `name` (a pack)");
        }
        script = normalizeWorkflowScript(params.script);
      }
      // The 5 ExecOptions fields the manager routes to pack-scoped persistence,
      // intermediate mirror, and outputs append (decisions 05/11/12). Empty for
      // inline scripts so they stay byte-identical to the legacy cwd store.
      const packExec = packCtx
        ? {
            packId: packCtx.packId,
            stateRoot: packCtx.stateRoot,
            intermediateDir: packCtx.intermediateDir,
            outputsDir: packCtx.outputsDir,
            io: packCtx.io,
          }
        : {};
      const parsed = parseWorkflowScript(script);

      // D9-8: statically reject scripts that never call agent() BEFORE forking
      // into background vs. inline. The inline path's runtime `agentCount === 0`
      // check below only fires after runSync — the background path returns a
      // runId immediately and never sees that guard, so a no-agent script would
      // get a false-positive "started" receipt the caller trusts. This static
      // pre-flight closes that gap on both paths. See scriptInvokesAgent() for
      // the heuristic (it scans for `agent(` token usage; not a security
      // boundary, just a fail-fast authoring guard).
      if (!scriptInvokesAgent(script)) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      // checkpoint() reaches the human only on a UI-bearing foreground run; a
      // background run is detached, so checkpoint() falls back to its headless
      // default. Map a checkpoint to ctx.ui.confirm (a yes/no gate) when available.
      const uiCtx = ctx as
        | { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
        | undefined;
      const uiConfirm = uiCtx?.hasUI ? uiCtx.ui?.confirm : undefined;
      const confirm = uiConfirm
        ? (promptText: string) => uiConfirm.call(uiCtx?.ui, "Workflow checkpoint", promptText)
        : undefined;

      // Task 4 — Path B label: the model governing this run is the host session's
      // mainModel (= pi default by construction), NOT manifest.model. ExtensionContext
      // exposes it as `ctx.model: Model<any> | undefined` (see pi-coding-agent
      // core/extensions/types.d.ts). We forward its id when observable so callers
      // can see which model a background run inherits; the label `modelSource` is
      // always emitted so Path B is distinguishable from Path A (cli `workflow run`).
      // NB: this is a LABEL only — manifest.model stays OUT of the manager options
      // (per-run model would need an ExecOptions.mainModel hook; see #630, OOS).
      const sessionModelId = (ctx as { model?: { id?: string } } | undefined)?.model?.id;
      const modelLabel = sessionModelId ? { model: sessionModelId } : {};

      // Background execution is the default: return immediately so the turn ends
      // and the user isn't blocked. The result is delivered back into the
      // conversation when the run finishes (see installResultDelivery). Only an
      // explicit `background: false` blocks for the result inline.
      if (params.background ?? true) {
        const { runId } = manager.startInBackground(script, mergedArgs, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          ...packExec,
        });
        return {
          content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
          details: { runId, background: true, modelSource: "session", ...modelLabel },
        };
      }

      // Synchronous execution (blocking) — but routed through the manager so the
      // run shows up live in the /workflows navigator and the task panel while it
      // runs, then stays in history afterwards. We still block on the result and
      // return it inline, so the model gets the full output in the same turn.
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
        key: "workflow",
        streamToolUpdates: true,
        maxAgents: 4,
        showResultPreviews: false,
      });

      let result: WorkflowRunResult;
      try {
        result = await manager.runSync(script, mergedArgs, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          ...packExec,
          confirm,
          externalSignal: signal,
          onProgress(live) {
            snapshot = recomputeWorkflowSnapshot(live);
            display.update(snapshot);
          },
        });
      } catch (error) {
        if (signal?.aborted || (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      // Format token usage (include cost when the provider reports it)
      const tokenInfo = result.tokenUsage
        ? `\n\nToken usage: ${result.tokenUsage.total.toLocaleString()} tokens${
            result.tokenUsage.cost ? ` ($${fmtCost(result.tokenUsage.cost)})` : ""
          }`
        : "";

      const formattedResult =
        result.result !== undefined ? `\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : "";

      return {
        content: [
          {
            type: "text",
            text: `Workflow **${result.meta.name}** completed with **${result.agentCount}** agent(s).${tokenInfo}\n\n## Result${formattedResult}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          tokenUsage: result.tokenUsage,
          runId: result.runId,
          modelSource: "session",
          ...modelLabel,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
      }
      // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
      // The `content` field is for the LLM (where markdown is preserved), but the TUI
      // renderer (Text component) shows text literally — so we strip markdown here.
      const text = result.content?.[0];
      const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
      const clean = raw
        .replace(/\*\*/g, "")
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .replace(/^##+\s*/gm, "")
        .trim();
      return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

/**
 * On-demand reference companion to the `workflow` tool (~100 tok schema).
 * Serves the advanced docs that are NOT inlined in the always-on guidelines:
 * quality helpers, spend control, phase() tracking, pipeline()/opts.schema/
 * synthesis patterns, and the full available-model list. Output is a tool
 * RESULT (conversation history), so it appears only when requested. Register
 * it alongside createWorkflowTool() at the same call site.
 */
export function createWorkflowHelpTool(options: { getScopedModels?: () => readonly string[] | undefined } = {}) {
  return defineTool({
    name: "workflow_help",
    label: "Workflow Reference",
    description:
      "On-demand reference for the `workflow` tool. Call when you need the advanced docs NOT inlined " +
      "in the workflow guidelines: quality helpers (verify/judgePanel/loopUntilDry/completenessCheck), " +
      "spend control (tokenBudget/phase budget/retry/gate), phase() tracking, pipeline()/opts.schema/" +
      "synthesis patterns, or the full available-model list. Omit `topic` for a menu.",
    // Owner-declared gating — mirrored IDENTICALLY from `workflow` (same combined
    // gate signature). See `workflow`'s gating comment: tickets 10 + 11 are one
    // atomic rollout over the single combined workflow/subagent gate, so all 4
    // tools share the SAME keywords-only gating and collapse back into one
    // 4-name gate (names[0] === "workflow") — when the gate fires, all 4 names
    // activate together (co-fire preserved). See `workflow`'s gating comment.
    gating: { gate: "workflow" }, // reference form (ticket 01) — family in GATE_DEFS["workflow"] (workflow ext)
    promptSnippet: "On-demand advanced reference for the workflow tool (helpers/budget/phases/patterns/models).",
    parameters: Type.Object({
      topic: Type.Optional(WORKFLOW_HELP_TOPIC_ENUM),
    }),
    async execute(_id, params) {
      let text: string;
      switch (params.topic) {
        case "helpers":
          text = workflowHelpersDoc();
          break;
        case "budget":
          text = workflowBudgetDoc();
          break;
        case "phases":
          text = workflowPhasesDoc();
          break;
        case "patterns":
          text = workflowPatternsDoc();
          break;
        case "models":
          // Scoped, for the same reason the always-on guideline is: the
          // "route only to these" list must not name a model the session
          // has excluded.
          text = await modelRoutingGuideline(options.getScopedModels?.());
          break;
        default:
          text =
            "workflow_help topics:\n" +
            "  • helpers — quality helpers (verify/judgePanel/loopUntilDry/completenessCheck)\n" +
            "  • budget — spend control (tokenBudget, phase budget, retry, gate, degrade)\n" +
            "  • phases — phase() tracking + declared-vs-entered semantics\n" +
            "  • patterns — pipeline()/opts.schema/synthesis agent/concurrency/when-to-decompose\n" +
            "  • models — the full list of currently-available model IDs (for opts.model)\n" +
            'Pass topic:"<name>" for that reference.';
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { ok: true, topic: params.topic ?? null },
      };
    },
  });
}

function resolveWorkflowToolDefaults(
  options: WorkflowToolOptions,
  cwd: string,
): { agentTimeoutMs: number | null; concurrency?: number; agentRetries: number } {
  const settings = loadWorkflowSettings({ cwd });
  return {
    agentTimeoutMs:
      options.defaultAgentTimeoutMs !== undefined
        ? options.defaultAgentTimeoutMs
        : (settings.defaultAgentTimeoutMs ?? null),
    concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
    agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
  };
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object")
    throw new Error("workflow requires an object argument with a `script` string or a `name`");
  const value = args as Record<string, unknown>;
  const hasScript = typeof value.script === "string" && value.script.trim() !== "";
  const hasName = typeof value.name === "string" && value.name.trim() !== "";
  if (hasScript && hasName) {
    throw new Error("workflow accepts exactly one of `script` or `name` — both were provided");
  }
  if (!hasScript && !hasName) {
    throw new Error("workflow requires exactly one of `script` (inline JS) or `name` (a pack) — neither was provided");
  }
  // Normalize only the inline-script path; the pack (`name`) path is resolved in execute.
  return hasScript
    ? { ...value, script: normalizeWorkflowScript(value.script as string) }
    : (value as WorkflowToolInput);
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) {
    const inner = fence[1];
    if (inner !== undefined) text = inner.trim();
  }
  return text;
}

/**
 * Static pre-flight check (D9-8): does the workflow script text call anything
 * that spawns agents at least once?
 *
 * This is a FAIL-FAST AUTHORING GUARD, not a security boundary. It exists so
 * that a no-agent workflow cannot reach the background path — which returns a
 * runId immediately without ever evaluating the runtime `agentCount === 0`
 * check on the inline path. The heuristic scans the raw script text for a call
 * to `agent(` OR to the stdlib quality helpers (`verify(`, `judgePanel(`,
 * `loopUntilDry(`, `completenessCheck(`) OR to a nested `workflow(` — the
 * helpers spawn agents inside the engine, so a legitimate helper-only script
 * never mentions the `agent(` token itself.
 *
 * False positives (the token appears in a string or comment) are acceptable:
 * such a script would also have invoked `agent(` for real in almost every
 * practical case, and the worst case is "we let a script through that the
 * runtime `agentCount === 0` check on the inline path then catches." False
 * negatives (the script calls agent via dynamic indirection like `const f =
 * agent; f(...)`) are also acceptable — those scripts still get the runtime
 * `agentCount` check on the inline path, and on the background path they
 * degrade to the pre-existing behavior (start, then no-op), which is no worse
 * than today.
 */
function scriptInvokesAgent(script: string): boolean {
  // Strip the `export const meta = {...}` literal so a `agent` substring
  // appearing inside meta (e.g. a description) does not trigger a false
  // positive. We only need to inspect the body the workflow will execute.
  const body = script.replace(/^[\s\S]*?\bexport\s+const\s+meta\s*=[\s\S]*?\};/, "");
  // Match a call to `agent(` — or to any stdlib helper that spawns agents
  // internally (verify/judgePanel/loopUntilDry/completenessCheck), or to a
  // nested `workflow('name')`, none of which mention the `agent(` token in the
  // script text but all of which run real subagents at runtime. The `\s*\(`
  // ensures we don't match the bare words in prose.
  return /\b(?:agent|verify|judgePanel|loopUntilDry|completenessCheck|workflow)\s*\(/.test(body);
}
