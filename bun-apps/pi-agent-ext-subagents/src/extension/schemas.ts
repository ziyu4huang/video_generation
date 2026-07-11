/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";

function keepTopLevelParameterDescriptions<T>(schema: T): T {
	return pruneNestedDescriptions(schema, []) as T;
}

function pruneNestedDescriptions(value: unknown, path: string[]): unknown {
	if (!value || typeof value !== "object") return value;

	const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if (key === "description" && !isTopLevelParameterDescription(path)) continue;
		if ("value" in descriptor) {
			const nextPath = typeof key === "string" ? [...path, key] : path;
			descriptor.value = pruneNestedDescriptions(descriptor.value, nextPath);
		}
		Object.defineProperty(result, key, descriptor);
	}
	return result;
}

function isTopLevelParameterDescription(path: string[]): boolean {
	return path.length === 2 && path[0] === "properties";
}

const SkillOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
		{ type: "string" },
	],
	description: "Skill(s): comma-separated string, string[], or boolean (false=off, true=default)",
});

const OutputOverride = Type.Unsafe({
	anyOf: [
		{ type: "string" },
		{ type: "boolean" },
	],
	description: "Output filename/path (string), or false to disable file output",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description: "'inline' (default) or 'file-only' (requires output path)",
});

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
	],
	description: "Files to read before running (array of filenames), or false to disable",
});

const JsonSchemaObject = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "JSON Schema object for strict structured output. Non-object roots are rejected.",
});

const AcceptanceOverride = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["auto", "none", "attested", "checked", "verified", "reviewed"] },
		{ type: "boolean", enum: [false] },
		{ type: "object", additionalProperties: true },
	],
	description: "Optional acceptance policy. Omitted=auto; verified needs runtime commands",
});

const TurnBudgetOverride = Type.Object({
	maxTurns: Type.Integer({ minimum: 1 }),
	graceTurns: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false, description: "Assistant-turn budget. At maxTurns child wraps up; after graceTurns aborted" });

const ToolBudgetBlock = Type.Unsafe({
	anyOf: [
		{ type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
		{ type: "string", enum: ["*"] },
	],
});

const ToolBudgetOverride = Type.Object({
	soft: Type.Optional(Type.Integer({ minimum: 1 })),
	hard: Type.Integer({ minimum: 1 }),
	block: Type.Optional(ToolBudgetBlock),
}, { additionalProperties: false, description: "Child tool-call budget. After hard limit, block tools (default: read/grep/find/ls or '*')" });

const TaskItem = Type.Object({
	agent: Type.String(), 
	task: Type.String(), 
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking for this task" })),
	model: Type.Optional(Type.String({ description: "Override model for this task (e.g. 'google/gemini-3-pro')" })),
	skill: Type.Optional(SkillOverride),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
});

const DynamicExpandSchema = Type.Object({
	from: Type.Object({
		output: Type.String({ description: "Prior named structured output to expand from." }),
		path: Type.String({ description: "JSON Pointer into the structured output, e.g. /items." }),
	}, { additionalProperties: false }),
	item: Type.Optional(Type.String({ description: "Template variable name for each item. Defaults to item." })),
	key: Type.Optional(Type.String({ description: "JSON Pointer relative to each item for stable child ids." })),
	maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Required fanout bound unless configured globally." })),
	onEmpty: Type.Optional(Type.String({ enum: ["skip", "fail"], description: "Empty input behavior. Defaults to skip." })),
}, { additionalProperties: false });

const DynamicCollectSchema = Type.Object({
	as: Type.String({ description: "Safe output name for the ordered collected result array." }),
	outputSchema: Type.Optional(JsonSchemaObject),
}, { additionalProperties: false });

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Sequential step agent name" })),
	task: Type.Optional(Type.String({
		description: "Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder, {outputs.name}=prior named output. Required for first step, defaults to '{previous}' for subsequent steps."
	})),
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label for this chain step." })),
	as: Type.Optional(Type.String({ description: "Optional safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	parallel: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "array", minItems: 1, items: { type: "object" } },
			{ type: "object" },
		],
		description: "Parallel tasks within this chain step. Each item accepts the same fields as top-level tasks[] (agent, task, count, model, skill, output, reads, etc.) plus phase/label/as/outputSchema. Use with expand/collect for dynamic fanout.",
	})),
	expand: Type.Optional(DynamicExpandSchema),
	collect: Type.Optional(DynamicCollectSchema),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task."
	})),
}, {
	description: "Chain step: use {agent, task?, ...} for sequential, {parallel: [...]} for static concurrent execution, or {expand, parallel: {...}, collect} for dynamic fanout.",
	additionalProperties: false,
});

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by assistant turns (disabled by default)" })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by total tokens (disabled by default)" })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention"] }), {
		description: "Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels to use when available. Defaults to event, async, and intercom.",
	})),
});

const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (SINGLE mode) or management target (get/update/delete)" })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode; optional for self-contained agents)" })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({
		description: "Management/control action only. Must be omitted for execution mode (single, parallel, or chain)."
	})),
	id: Type.Optional(Type.String({
		description: "Run id/prefix for status/interrupt/stop/resume/steer/append-step."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run directory for status/stop/resume/steer."
	})),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Child index (0-based) for targeting a specific child or transcript." })),
	view: Type.Optional(Type.String({
		enum: ["fleet", "transcript"],
		description: "Status view: 'fleet' (overview) or 'transcript' (tail output).",
	})),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max transcript lines (default 80)." })),
	message: Type.Optional(Type.String({ description: "Follow-up (resume) or guidance (steer). Use index for a specific child." })),
	scope: Type.Optional(Type.String({ enum: ["session", "user", "project"], description: "Default: session." })),
	target: Type.Optional(Type.String({ enum: ["main", "children", "child"], description: "Default: main; 'child' for per-agent." })),
	thinking: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean", enum: [false] }], description: "watchdog thinking: off/minimal/low/medium/high/xhigh/inherit/false." })),
	schedule: Type.Optional(Type.String({ description: "One-shot schedule (needs scheduledRuns.enabled). Use '+10m' or ISO timestamp." })),
	scheduleName: Type.Optional(Type.String({ description: "Display name for schedule." })),
	// Chain identifier for management (can't reuse 'chain' — that's the execution array)
	chainName: Type.Optional(Type.String({
		description: "Chain name for management (get/update/delete)"
	})),
	// Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "Agent/chain config for create/update (object or JSON string; steps→chain)."
	})),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL: [{agent, task, count?, output?, reads?, progress?}, ...]" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "PARALLEL max concurrent tasks (default 4)." })),
	worktree: Type.Optional(Type.Boolean({
		description: "Isolated git worktrees per parallel task (needs clean git)."
	})),
	chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN: sequential steps; each becomes {previous}." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork"],
		description: "'fresh' or 'fork'; overrides every child; if omitted, each agent uses its defaultContext.",
	})),
	chainDir: Type.Optional(Type.String({ description: "Chain artifact directory (default: user-scoped temp)." })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: false)" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in ms for foreground and async/background runs." })),
	turnBudget: Type.Optional(TurnBudgetOverride),
	toolBudget: Type.Optional(ToolBudgetOverride),
	agentScope: Type.Optional(Type.String({ description: "Discovery scope: 'user'|'project'|'both' (default: both; project wins on collisions)" })),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Share to GitHub Gist (default: false)" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Session log directory (default: temp; works even if share=false)" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Preview/edit TUI before execution (keeps run foreground)." })),
	control: Type.Optional(ControlOverrides),
	// Solo agent overrides
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean" },
		],
		description: "Output file (string) or false to disable (relative to cwd).",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override (e.g. 'anthropic/claude-sonnet-4')" })),
	acceptance: Type.Optional(AcceptanceOverride),
});

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);

const WaitParamsSchema = Type.Object({
	id: Type.Optional(Type.String({
		description: "Run id or prefix to wait for one specific run. Omit to wait across every active async run started in this session.",
	})),
	all: Type.Optional(Type.Boolean({
		description: "Wait for ALL active runs to finish. Default false: return as soon as the first run finishes, so a fleet manager can spawn a replacement and wait again. Ignored when id targets a single run.",
	})),
	timeoutMs: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Give up waiting after this many milliseconds (the runs keep going regardless). Defaults to 1800000 (30 minutes).",
	})),
});

export const WaitParams = keepTopLevelParameterDescriptions(WaitParamsSchema);
