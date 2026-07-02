/**
 * Shared LLM config + cwd-bound services for the CLI.
 *
 * Single source of truth for provider / model / thinking level / auth /
 * settings, resolved once here and reused by every mode.
 *
 * ## Self-contained design
 *
 * The pi-obsidian extension is imported as an inline `extensionFactory` and
 * baked into the `DefaultResourceLoader` via `resourceLoaderOptions`. This
 * means the agent works **without** any `.pi/settings.json` package reference
 * or `-e <path>` flag — the Obsidian tools are always present. When the bundle
 * is produced (`bun scripts/build.ts`), the extension code is compiled into the
 * single output file, yielding a truly self-contained pi-agent.
 *
 * Resolution order for provider/model/thinking:
 *   1. explicit caller argument (from the arg parser)
 *   2. env override (PI_PROVIDER / PI_MODEL / PI_THINKING)
 *   3. user settings (~/.pi/agent/settings.json defaultProvider/defaultModel)
 *   4. hardcoded fallback below
 */
import {
	AuthStorage,
	ModelRegistry,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type AgentSessionServices,
	type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
// Inline import of the pi-obsidian extension factory. Bundled in (self-contained).
import obsidianExtension from "pi-obsidian/extensions/obsidian.ts";
// The baked provider CATALOG (lm-studio) is sourced from `pi-agent` — single
// source of truth across both CLIs. We register it explicitly here (the
// programmatic-session path) rather than via pi-agent's main()-oriented
// pre-load-providers monkey-patch, which splices process.argv and is wrong for
// this entry point. See bun-apps/pi-agent/src/pre-load-providers.ts.
import { PROVIDERS, resolveApiKey } from "pi-agent";

/** Allowed thinking levels (mirrors pi-agent-core). */
const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export function isThinkingLevel(v: string): v is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(v);
}

/** Hardcoded fallback when nothing else is configured. */
const FALLBACK = {
	provider: "zai",
	modelId: "glm-5.2",
	thinkingLevel: "medium" as ThinkingLevel,
};

export interface ResolvedLLM {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

/**
 * Display label for the active model: the registry display name when the
 * session exposes one, else `provider/modelId`. Shared by the zk-* commands
 * so their header lines stay consistent instead of each inlining the same
 * fallback expression.
 */
export function modelLabel(
	session: { model?: { name?: string } },
	llm: { provider: string; modelId: string },
): string {
	return session.model?.name ?? `${llm.provider}/${llm.modelId}`;
}

/**
 * Resolve the LLM target from caller overrides + env.
 * `overrideModel` may be a plain id, `provider/id`, or `provider/id:thinking`.
 */
export function resolveLLM(opts: {
	provider?: string;
	model?: string;
	thinking?: string;
	/** Read user defaults from a settings manager (optional). */
	userDefaults?: { provider?: string; model?: string };
}): ResolvedLLM {
	let provider =
		opts.provider ??
		process.env.PI_PROVIDER ??
		opts.userDefaults?.provider ??
		FALLBACK.provider;
	let modelId =
		process.env.PI_MODEL ?? opts.userDefaults?.model ?? FALLBACK.modelId;
	// Validate PI_THINKING like the --thinking flag and the :thinking model
	// suffix both do — without this, PI_THINKING=bogus is `as ThinkingLevel`'d
	// straight through to createAgentSessionFromServices with no error, mirroring
	// the silent-coerce footgun the numeric flags had. FALLBACK is always valid,
	// so the guard only fires on a bad env value.
	const thinkingRaw = process.env.PI_THINKING ?? FALLBACK.thinkingLevel;
	if (!isThinkingLevel(thinkingRaw)) {
		throw new Error(
			`Invalid PI_THINKING "${thinkingRaw}". Valid: ${THINKING_LEVELS.join(", ")}`,
		);
	}
	let thinking: ThinkingLevel = thinkingRaw;

	// --model supports "provider/id[:thinking]" shorthand.
	if (opts.model) {
		const raw = opts.model;
		let thinkingSuffix = "";
		const colon = raw.lastIndexOf(":");
		if (
			colon > raw.indexOf("/") /* ignore ports in baseUrl-less ids */ &&
			colon !== -1
		) {
			const maybe = raw.slice(colon + 1);
			if (isThinkingLevel(maybe)) {
				thinkingSuffix = maybe;
				modelId = raw.slice(0, colon);
			} else {
				modelId = raw;
			}
		} else {
			modelId = raw;
		}
		const slash = modelId.indexOf("/");
		if (slash >= 0) {
			provider = modelId.slice(0, slash);
			modelId = modelId.slice(slash + 1);
		}
		if (thinkingSuffix) thinking = thinkingSuffix as ThinkingLevel;
	}

	if (opts.thinking) {
		if (!isThinkingLevel(opts.thinking)) {
			throw new Error(
				`Invalid --thinking level: "${opts.thinking}". Valid: ${THINKING_LEVELS.join(", ")}`,
			);
		}
		thinking = opts.thinking;
	}

	return { provider, modelId, thinkingLevel: thinking };
}

export interface SharedServices {
	services: AgentSessionServices;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	model: any;
}

/**
 * All registered models regardless of credential state. Shared between
 * `listModels` (cli.ts) and `listRegisteredTools`: prefers `getAll()` (every
 * registered model) and falls back to `getAvailable()` (credentialed only).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function allModels(reg: any): any[] {
	return typeof reg.getAll === "function" ? reg.getAll() : reg.getAvailable();
}

/** Zero-cost policy for baked providers (local servers, no billing). */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** PI_SKIP_MODELS_JSON=1 → hermetic binary: no ~/.pi/agent/models.json read. */
function isSkipModelsJson(): boolean {
	const v = process.env.PI_SKIP_MODELS_JSON;
	return v === "1" || v === "true";
}

/**
 * Build the shared auth + model registry with pi-agent's PROVIDERS baked in.
 *
 * Resolution:
 *   1. GLOBAL ~/.pi/agent/models.json — loaded natively by ModelRegistry.create
 *      (skipped under PI_SKIP_MODELS_JSON). Honors PI_CODING_AGENT_DIR.
 *   2. BAKED — pi-agent's PROVIDERS (lm-studio today), registered explicitly so
 *      they unconditionally overwrite any same-named global entry. This is what
 *      makes the compiled binary hermetic: baked providers work with ZERO
 *      external models.json, yet users can still layer global configs for OTHER
 *      providers.
 *
 * Auth storage: real file by default (so credentials in auth.json still work
 * for non-baked providers), in-memory only under opt-out.
 */
export function buildBakedRegistry(): {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
} {
	const skip = isSkipModelsJson();
	const agentDir = getAgentDir();
	const authStorage = skip
		? AuthStorage.inMemory()
		: AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = skip
		? ModelRegistry.inMemory(authStorage)
		: ModelRegistry.create(authStorage);
	for (const [name, entry] of Object.entries(PROVIDERS)) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		modelRegistry.registerProvider(name, {
			...entry,
			apiKey: resolveApiKey(entry.apiKey),
			models: entry.models.map((m) => ({ ...m, cost: ZERO_COST })),
		} as any);
	}
	return { authStorage, modelRegistry };
}

/**
 * Build cwd-bound services with the pi-obsidian extension baked in.
 *
 * @param extraExtensionFactories  additional inline extension factories
 *                                  (obsidian is always included)
 * @param appendSystemPrompt        text appended to the system prompt
 */
export async function getSharedServices(
	opts: {
		cwd?: string;
		extraExtensionFactories?: unknown[];
		appendSystemPrompt?: string[];
	} = {},
): Promise<SharedServices> {
	const cwd = opts.cwd ?? process.cwd();
	const extensionFactories = [
		obsidianExtension as unknown as (pi: unknown) => void,
		...(opts.extraExtensionFactories ?? []),
	];

	// Build a registry with the baked provider catalog (pi-agent's PROVIDERS)
	// layered over the global ~/.pi/agent/models.json. PI_SKIP_MODELS_JSON=1
	// yields a hermetic in-memory registry (baked providers only). The same
	// authStorage is injected so the registry and services agree on credential
	// resolution.
	const { authStorage, modelRegistry } = buildBakedRegistry();

	const services = await createAgentSessionServices({
		cwd,
		agentDir: getAgentDir(),
		authStorage,
		modelRegistry,
		resourceLoaderOptions: {
			extensionFactories: extensionFactories as any,
			...(opts.appendSystemPrompt?.length
				? { appendSystemPrompt: opts.appendSystemPrompt }
				: {}),
		},
	});
	return { services, model: undefined };
}

/**
 * Resolve a model object from the registry.
 * Tries exact `find(provider, id)` first, then falls back to a
 * case-insensitive substring match across all models (so `sonnet`,
 * `gpt-4o-mini`, `gemma-4-26b` all work like the pi TUI).
 */
export function resolveModel(
	services: AgentSessionServices,
	provider: string,
	modelId: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
	const reg = services.modelRegistry;
	const exact = reg.find(provider, modelId);
	if (exact) return exact;

	const all = reg.getAll();
	const needle = modelId.toLowerCase();
	// 1. match provider + id substring
	let hit = all.find(
		(m) =>
			m.provider.toLowerCase() === provider.toLowerCase() &&
			(m.id.toLowerCase().includes(needle) ||
				(m.name ?? "").toLowerCase().includes(needle)),
	);
	// 2. match id/name across any provider
	if (!hit) {
		hit = all.find(
			(m) =>
				m.id.toLowerCase().includes(needle) ||
				(m.name ?? "").toLowerCase().includes(needle),
		);
	}
	if (!hit) {
		const available = reg.getAvailable();
		throw new Error(
			`Model "${provider}/${modelId}" not found. ` +
				`Check --model / PI_MODEL or ~/.pi/agent/models.json.\n` +
				`Available (${available.length}): ` +
				available
					.slice(0, 12)
					.map((m) => `${m.provider}/${m.id}`)
					.join(", ") +
				(available.length > 12 ? " …" : ""),
		);
	}
	return hit;
}

export interface CreateSharedSessionOptions {
	cwd?: string;
	tools?: string[];
	excludeTools?: string[];
	appendSystemPrompt?: string[];
	extraExtensionFactories?: unknown[];
	/** Custom session manager (defaults to in-memory). */
	sessionManager?: Parameters<
		typeof createAgentSessionFromServices
	>[0]["sessionManager"];
}

/** Resolve tool allowlist: explicit > PI_TOOLS env > undefined. */
function resolveTools(explicit?: string[]): string[] | undefined {
	if (explicit && explicit.length > 0) return explicit;
	const envTools = process.env.PI_TOOLS;
	if (envTools)
		return envTools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	return undefined;
}

/**
 * Fail-fast on unknown tool names. Without this, pi-core silently filters
 * unknown names out of the active set (agent-session.js: "Unknown tool names
 * are ignored"), so a typo in `--tools` (or `PI_TOOLS`) drops the curated
 * default wholesale and the agent starts with zero usable tools — no error.
 *
 * Detection uses the active set the session already built: pi-core keeps only
 * registered names, so any requested name that is neither active NOR in the
 * exclude list is unknown (typo'd or unregistered). No extra session needed.
 * Mirrors the fail-fast behavior of numeric flags like --depth / --top-k.
 */
export function validateToolNames(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	session: any,
	requested: string[] | undefined,
	excludeTools: string[] | undefined,
): void {
	if (!requested || requested.length === 0) return;
	if (typeof session.getActiveToolNames !== "function") return; // cannot validate
	const active = new Set<string>(session.getActiveToolNames() as string[]);
	const excluded = new Set(excludeTools ?? []);
	// A requested name absent from the active set AND not explicitly excluded
	// is unknown (pi-core silently dropped it).
	const unknown = requested.filter((t) => !active.has(t) && !excluded.has(t));
	if (unknown.length === 0) return;

	throw new Error(
		`Unknown tool name(s) in --tools / PI_TOOLS:\n` +
			unknown.map((u) => `  ${u}`).join("\n") +
			`\nRun \`bun-pi-agent-cli --list-tools\` to see all valid tool names.`,
	);
}

/**
 * Create an AgentSession on shared services with pi-obsidian baked in.
 * `llm` is resolved by the caller via resolveLLM(); the model object is
 * looked up against the registry here.
 */
export async function createSharedSession(
	llm: ResolvedLLM,
	opts: CreateSharedSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const { services } = await getSharedServices({
		cwd: opts.cwd,
		extraExtensionFactories: opts.extraExtensionFactories,
		appendSystemPrompt: opts.appendSystemPrompt,
	});
	const model = resolveModel(services, llm.provider, llm.modelId);
	const requestedTools = resolveTools(opts.tools);
	const result = await createAgentSessionFromServices({
		services,
		sessionManager:
			opts.sessionManager ?? SessionManager.inMemory(process.cwd()),
		model,
		thinkingLevel: llm.thinkingLevel,
		tools: requestedTools,
		excludeTools: opts.excludeTools,
	});
	// Fail fast on typo'd tool names instead of silently starting with zero tools.
	validateToolNames(result.session, requestedTools, opts.excludeTools);
	// Publish the resolved model so extension-spawned subagents inherit it.
	// pi-obsidian's runSubagent defaults to OB_PARENT_MODEL when no per-call
	// model override is given, so a `--model` selection stays active for every
	// child (obsidian_distill / obsidian_garden / zk_* subagents) instead of
	// silently reverting to the pi default.
	const thinkingSuffix =
		llm.thinkingLevel && llm.thinkingLevel !== "off"
			? `:${llm.thinkingLevel}`
			: "";
	process.env.OB_PARENT_MODEL = `${llm.provider}/${llm.modelId}${thinkingSuffix}`;
	return result;
}

/**
 * Enumerate all registered tools (for `--list-tools` / discovery). Builds a
 * throwaway session so extensions run and register their tools, then returns
 * the ToolInfo[] from the session. Tolerant of model resolution: falls back to
 * the first registered model if the default isn't in the registry (tool
 * listing must not require a working model).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listRegisteredTools(): Promise<any[]> {
	const { services } = await getSharedServices();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let model: any;
	try {
		model = resolveModel(services, FALLBACK.provider, FALLBACK.modelId);
	} catch {
		const all = allModels(services.modelRegistry);
		model = all?.[0];
		if (!model)
			throw new Error(
				"No model registered — cannot build a session to list tools.",
			);
	}
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(process.cwd()),
		model,
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return typeof session.getAllTools === "function"
		? (session.getAllTools() as any[])
		: [];
}
