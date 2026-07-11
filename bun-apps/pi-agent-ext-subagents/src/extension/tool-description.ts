import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Use { action: "list" } before execution and only run executable/non-disabled agents or chains.
• Keep execution and management separate: omit action for SINGLE/PARALLEL/CHAIN execution; use action only for list/get/models/create/update/delete/status/interrupt/stop/resume/append-step/doctor.
• Async/background runs: launch with async:true only when work can proceed independently. Do not sleep or poll status just to wait; if this turn must block, use the wait tool. Otherwise continue useful work or respond and let completion notifications arrive.
• Child-safety boundary: ordinary child subagents are not orchestrators and must not run subagents. Only explicitly configured fanout children may use the child-safe subagent tool, still bounded by depth/session limits.
• Writing/review safety: keep one writer for the same cwd/worktree. Use fresh-context read-only reviewers/validators for independent review, then have the parent synthesize and apply fixes as the sole writer unless an isolated worktree was intentionally requested.
• Artifacts/status essentials: chain outputs live under {chain_dir}; async runs expose asyncId/asyncDir with status.json, events.jsonl, output logs, and status via { action: "status", id }. Include output paths and residual risks when reporting results.`;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents or manage agent definitions.

EXECUTION (use exactly ONE mode):
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task? } - one task; omit task for self-contained agents
• CHAIN: { chain: [{agent:"agent-a"}, {parallel:[{agent:"agent-b",count:3}]}] } - sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?}, ...], concurrency?: number, worktree?: true } - concurrent execution (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (explicit value overrides every child; when omitted, each requested agent uses its own defaultContext, otherwise "fresh"; inspect agent defaults via { action: "list" })
• Optional timeout: { timeoutMs } or { maxRuntimeMs } sets a run-level max runtime for foreground and async/background runs
• If { action: "list" } shows proactive skill subagent suggestions, consider a small fresh-context fanout for broad tasks where one of those skills would materially help

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

Example: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {agent:"agent-b", task:"Plan based on {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover executable agents/chains
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "models", agent?: "name" } - show the runtime-loaded builtin subagent model mapping, optionally filtered to one builtin
• { action: "watchdog.status" | "watchdog.check" | "watchdog.recommend-model" } - inspect the opt-in subagent watchdog and its strong complementary model recommendation
• { action: "watchdog.configure", model: "recommended" | "inherit" | "provider/model[:thinking]", scope?: "session" | "user" | "project", target?: "main" | "children" | "child", agent?: "name", thinking?: "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" } - configure watchdog model selection; default scope is session, use persistent scopes only when the user asks
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, ... } }
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
• { action: "eject", agent: "reviewer", agentScope?: "user" | "project" } - copy a bundled/package agent to user/project scope as an editable custom file that shadows the original (default scope: user)
• { action: "disable", agent: "reviewer", agentScope?: "user" | "project" } - hide any agent from runtime discovery via a reversible settings override (default scope: user)
• { action: "enable", agent: "reviewer", agentScope?: "user" | "project" } - remove a disabled override and restore discovery
• { action: "reset", agent: "reviewer", agentScope?: "user" | "project" } - delete the scope's custom agent file and/or settings override, restoring the bundled default
• Use chainName for chain operations; packaged chains also use dotted runtime names

CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "status", view: "fleet" } - read-only active foreground/async fleet view with transcript commands
• { action: "status", id: "...", view: "transcript", index?: 0, lines?: 80 } - tail a run or child output/session transcript
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused
• { action: "stop", id: "..." } - stop a current-session top-level async run; stopped runs finish with state "stopped"
• { action: "resume", id: "...", message: "...", index?: 0 } - interrupt then follow up with a live async child, or revive a completed async/foreground child from its session
• { action: "steer", id: "...", message: "...", index?: 0 } - queue non-terminal guidance for a live/queued async Pi child when supported
• { action: "append-step", id: "...", chain: [{agent:"agent-c", task:"Use {previous}"}] } - append one step to the tail of a running async chain

SCHEDULE (opt-in; requires { "scheduledRuns": { "enabled": true } } in config.json):
• { action: "schedule", agent, task?, schedule: "+10m" | "2030-01-01T09:00:00Z", scheduleName? } - defer a subagent launch until a future time. Also accepts tasks[] or chain[]. Scheduled runs always launch async with fresh context; they become normal tracked async runs once they fire. Only schedule explicit delayed runs the user asked for.
• { action: "schedule-list" } - list scheduled runs for this session
• { action: "schedule-status", id: "..." } - inspect one scheduled run
• { action: "schedule-cancel", id: "..." } - cancel a scheduled run before it fires

DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, discovery, sessions, and intercom

${SUBAGENT_SAFETY_GUIDANCE}`;

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents or manage definitions. Use exactly one mode per call.

EXECUTE:
• Before execution, call { action: "list" }; run only executable/non-disabled configured agents/chains.
• SINGLE {agent, task?}; PARALLEL {tasks:[{agent,task,count?,output?,reads?,progress?}], concurrency?, worktree?}; CHAIN {chain:[{agent,task?},{parallel:[...]}]}.
• context can be "fresh" or "fork"; omitted uses each agent defaultContext, otherwise fresh. timeoutMs/maxRuntimeMs apply to foreground and async/background runs.
• Chain templates may use {task}, {previous}, {chain_dir}, and named outputs. Parallel worktree isolation requires a clean git repo.
• If list shows proactive skill subagent suggestions, use a small fresh-context fanout only when the task is broad enough.

MANAGE / CONTROL:
• Use action without execution fields: list, get, models, create, update, delete, eject, disable, enable, reset, doctor, watchdog.status, watchdog.check, watchdog.recommend-model, watchdog.configure.
• Async control actions: status, interrupt, stop, resume, steer, append-step. Use stop with an id for current-session top-level async runs. Use status view:"fleet" for active-run overview, view:"transcript" to tail child output, and steer for non-terminal live guidance. Use id/runId prefixes carefully; use index for a specific child.
• Opt-in schedule actions: schedule, schedule-list, schedule-status, schedule-cancel. Schedule only explicit delayed runs the user asked for.

ASYNC / WAIT:
• async:true detaches background work. Do not sleep or poll just to wait; use the wait tool only when this turn must block. Otherwise continue useful work or respond and let completion notifications arrive.
• Status and artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, session files, and { action:"status", id:"..." }.

SAFETY:
• Ordinary child subagents are not orchestrators and must not run subagents. Only explicit fanout children may use child-safe subagent, still bounded by depth/session limits.
• Keep one writer per cwd/worktree. Use fresh read-only review/validation fanout, then synthesize and apply fixes from the parent unless isolated worktrees were intentionally requested.`;

/**
 * Terse always-on routing surface (the new default). Keeps the mode/action
 * VALUE lists the model needs to route, the core safety constraints, and a
 * pointer to the subagent_help tool for the full reference. Single-sourced
 * against FULL_SUBAGENT_TOOL_DESCRIPTION via buildSubagentHelpText() so the
 * two surfaces cannot drift.
 */
export const MINIMAL_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents or manage definitions. Use exactly one mode per call. Call subagent_help (no args) for the full reference (modes, template variables, examples, per-field semantics, safety).

EXECUTE (omit action): call { action: "list" } first; run only executable/non-disabled agents.
• SINGLE {agent, task?}  • PARALLEL {tasks:[{agent,task,count?,output?,reads?,progress?}], concurrency?, worktree?}  • CHAIN {chain:[{agent,task?},{parallel:[...]}]}

MANAGE (action): list · get · models · create · update · delete · eject · disable · enable · reset · doctor · watchdog.status · watchdog.check · watchdog.recommend-model · watchdog.configure

CONTROL (action): status (view:"fleet"|"transcript", index?, lines?) · interrupt · stop · resume · steer · append-step. Target runs by id/dir (+index for a specific child).

SCHEDULE (action, opt-in; requires scheduledRuns.enabled): schedule · schedule-list · schedule-status · schedule-cancel

async:true detaches to background; use the wait tool to block only when this turn must not end (do not sleep/poll). Status/artifacts live under asyncId/asyncDir (status.json, events.jsonl, output logs).

SAFETY: ordinary child subagents must not run subagents; keep one writer per cwd/worktree (use fresh read-only reviewers, then the parent applies fixes).`;

/**
 * Lazy-loaded per-parameter reference, served by the subagent_help tool. Holds
 * the verbose semantics that the minimal/compact inline descriptions defer.
 * Composed after FULL_SUBAGENT_TOOL_DESCRIPTION by buildSubagentHelpText().
 */
export const FULL_SUBAGENT_PARAM_REFERENCE = `PARAMETER REFERENCE (subagent tool)

Execution:
• agent — Agent name (SINGLE mode) or management target (get/update/delete/eject/disable/enable/reset).
• task — Task prompt (SINGLE mode; optional for self-contained agents).
• tasks — PARALLEL mode array: [{agent, task, count?, output?, outputMode?, reads?, progress?, model?, skill?, toolBudget?, acceptance?}].
• chain — CHAIN mode: sequential steps; each result becomes {previous}. append-step may reference {chain_dir}/{outputs.name}.
• concurrency — Top-level PARALLEL max concurrent tasks (default: config.parallel.concurrency or 4).
• worktree — Create isolated git worktrees for parallel tasks; requires clean git state.
• context — "fresh" (default behavior) or "fork" (inherit parent context). Explicit value overrides every child; omitted uses each agent's defaultContext.
• chainDir — Persistent chain artifact directory; defaults to user-scoped temp storage.

Solo-agent overrides (SINGLE/PARALLEL-item/CHAIN-step):
• model — Override model, e.g. "anthropic/claude-sonnet-4" or "provider/id[:thinking]".
• skill — Skill(s) to make available: string (comma-separated), string[], or boolean (false disables, true uses default).
• output — Output file/path (string), or false to disable. Relative paths resolve against cwd.
• outputMode — "inline" (return saved output, default) or "file-only" (concise file ref; requires output path).
• reads — Files to read before running (string[]), or false to disable.
• progress — Enable progress.md tracking for the task/step.
• acceptance — Acceptance policy: "auto"|"none"|"attested"|"checked"|"verified"|"reviewed", false, or an object. Omitted = auto-inferred; verified requires configured runtime commands.

Budgets:
• timeoutMs — Run-level max runtime in ms for foreground AND async/background runs.
• turnBudget — {maxTurns, graceTurns?}: at maxTurns the child wraps up; after graceTurns extra turns it is aborted with partial output.
• toolBudget — {soft?, hard, block?}: soft nudges; after hard, block tools (default read/grep/find/ls, or "*" for all) are blocked so the child finalizes.

Management/config:
• action — Management/control action only; MUST be omitted for execution mode (single, parallel, or chain).
• config — Agent/chain config for create/update: object or JSON string; presence of steps creates a chain.
• chainName — Chain name for get/update/delete management actions.
• agentScope — Agent discovery scope: "user", "project", or "both" (default both; project wins on name collisions).
• scope — watchdog.configure scope: "session" (default, avoids persistent writes), "user", or "project".
• target — watchdog.configure target: "main" (default), "children", or "child" (use with agent for per-agent overrides).
• thinking — watchdog.configure thinking level: off|minimal|low|medium|high|xhigh, "inherit", or false.

Control / async:
• id — Run id or prefix for status/interrupt/stop/resume/steer/append-step.
• dir — Async run directory for status/stop/resume/steer.
• index — Zero-based child index for actions targeting a specific child or transcript.
• view — status view: "fleet" (active-run overview) or "transcript" (tail output via id/dir + optional index).
• lines — Max transcript lines for status+transcript (default 80).
• message — Follow-up message for resume, or non-terminal guidance for steer.
• async — Run in background (default false, or per config asyncByDefault).
• control — {enabled?, needsAttentionAfterMs?, activeNoticeAfterMs?, activeNoticeAfterTurns?, activeNoticeAfterTokens?, failedToolAttemptsBeforeAttention?, notifyOn?, notifyChannels?}: opt-in attention tracking thresholds/channels.

Schedule:
• schedule — One-shot schedule for action="schedule": "+10m" or a future ISO timestamp; runs launch async with fresh context.
• scheduleName — Optional display name for a scheduled run.

Misc:
• clarify — Show TUI to preview/edit before execution; clarify:true keeps the run foreground.
• artifacts — Write debug artifacts (default true).
• includeProgress — Include full progress in result (default false).
• share — Upload session to GitHub Gist for sharing (default false).
• sessionDir — Directory for session logs (default temp; enables sessions even if share=false).
• cwd — Working directory for the run.`;

/**
 * Single-source full reference builder, served verbatim by the subagent_help
 * tool. Composes the canonical full description + the per-parameter reference
 * appendix so the lazy-loaded surface is complete and cannot drift from the
 * always-on surfaces (which are compressed subsets of the same semantics).
 */
export function buildSubagentHelpText(): string {
	return `${FULL_SUBAGENT_TOOL_DESCRIPTION}\n\n---\n\n${FULL_SUBAGENT_PARAM_REFERENCE}`;
}

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "minimal" || value === "full" || value === "compact" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined) return "minimal";
	if (isToolDescriptionMode(mode)) return mode;
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "minimal", "full", "compact", or "custom".`);
	return "full";
}

function customDescriptionPaths(options?: ToolDescriptionOptions): string[] {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	return [
		path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(cwd);
	const variables: Record<string, () => string> = {
		fullDescription: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		full: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		minimalDescription: () => MINIMAL_SUBAGENT_TOOL_DESCRIPTION,
		minimal: () => MINIMAL_SUBAGENT_TOOL_DESCRIPTION,
		compactDescription: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		compact: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		safetyGuidance: () => SUBAGENT_SAFETY_GUIDANCE,
		safety: () => SUBAGENT_SAFETY_GUIDANCE,
		agentDir: () => agentDir,
		projectConfigDir: () => projectConfigDir,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
		const replacement = variables[name];
		if (replacement) return replacement();
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: unknown placeholder ${raw} left unchanged.`);
		return raw;
	});
}

function loadCustomToolDescription(options?: ToolDescriptionOptions): string | undefined {
	for (const filePath of customDescriptionPaths(options)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warn(options, `Failed to inspect custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!stat.isFile()) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is not a file.`);
			continue;
		}
		if (stat.size > CUSTOM_TOOL_DESCRIPTION_MAX_BYTES) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is larger than ${CUSTOM_TOOL_DESCRIPTION_MAX_BYTES} bytes.`);
			continue;
		}
		try {
			const template = fs.readFileSync(filePath, "utf-8").trim();
			if (!template) {
				warn(options, `Ignoring empty custom tool description '${filePath}'.`);
				continue;
			}
			const rendered = renderCustomTemplate(template, options).trim();
			if (!rendered) {
				warn(options, `Ignoring custom tool description '${filePath}' because it rendered empty.`);
				continue;
			}
			return rendered;
		} catch (error) {
			warn(options, `Failed to read custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

function withMandatorySafetyGuidance(description: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	const mode = resolveToolDescriptionMode(config, options);
	if (mode === "minimal") return MINIMAL_SUBAGENT_TOOL_DESCRIPTION;
	if (mode === "compact") return COMPACT_SUBAGENT_TOOL_DESCRIPTION;
	if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) return withMandatorySafetyGuidance(custom);
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
	}
	return FULL_SUBAGENT_TOOL_DESCRIPTION;
}
