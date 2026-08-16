/**
 * zai-mcp — Z.ai MCP servers as pi tools.
 *
 * The extension acts as an MCP client (using @modelcontextprotocol/sdk). On
 * session_start it lazily connects to each enabled Z.ai HTTP MCP server,
 * discovers its tools via client.listTools(), and re-registers every tool as a
 * pi tool (prefixed with `zai_` to avoid collisions). When the LLM calls a
 * tool, the call is forwarded to the MCP server via client.callTool() and the
 * MCP content[] response is mapped back to pi's AgentToolResult.
 *
 * Phase 1 servers (HTTP):
 *   - web-search-prime  →  https://api.z.ai/api/mcp/web_search_prime/mcp
 *   - web-reader        →  https://api.z.ai/api/mcp/web_reader/mcp
 *
 * Env:
 *   ZAI_API_KEY           (required)  Bearer token for all servers.
 *   ZAI_MCP_BASE_URL      (optional)  Default https://api.z.ai/api/mcp
 *   WEB_SEARCH_ENABLED    (optional)  "0" skips web-search-prime
 *   WEB_READER_ENABLED    (optional)  "0" skips web-reader
 *
 * Missing API key or connection failure degrades gracefully: the affected
 * server is skipped and the session is not broken.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";

// @modelcontextprotocol/sdk is loaded dynamically so a missing bun install gives
// a friendly error instead of a module-not-found crash at load time.

// Capture extension dir at module init. import.meta.dir may be undefined in some
// extension-loading contexts; fall back to import.meta.url (standard ESM).
const _EXT_DIR: string | undefined = (() => {
	try {
		const metaDir = (import.meta as any).dir;
		if (typeof metaDir === "string" && metaDir) return metaDir;
		if (typeof import.meta.url === "string") return dirname(fileURLToPath(import.meta.url));
	} catch {}
	return undefined;
})();

// ---------------------------------------------------------------------------
// Dependency detection helpers
// ---------------------------------------------------------------------------

function findMonorepoRoot(from: string | undefined): string {
	if (!from) return "(repo root)";
	let dir = from;
	while (dir !== dirname(dir)) {
		try {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
				if (pkg.workspaces) return dir;
			}
		} catch {}
		dir = dirname(dir);
	}
	return "(repo root)";
}

/** Extract bare package name from an import specifier (strips subpaths). */
function pkgBaseName(spec: string): string {
	if (spec.startsWith("@")) {
		const parts = spec.split("/");
		return `${parts[0]}/${parts[1]}`;
	}
	return spec.split("/")[0];
}

function missingDeps(deps: string[], from: string | undefined): string[] {
	if (!from) return [];
	return deps.filter((dep) => {
		const pkgName = pkgBaseName(dep);
		// Walk up checking node_modules/<pkgName>/package.json — works with Bun symlinked virtual store.
		let dir = from;
		while (true) {
			if (existsSync(join(dir, "node_modules", pkgName, "package.json"))) return false;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return true;
	});
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal view of an MCP tool as returned by listTools(). */
interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Minimal view of the content items inside a callTool() result. */
interface McpContentItem {
	type: string;
	text?: string;
	// image / resource / embedded variants carry other fields; we stringify them.
	[key: string]: unknown;
}

interface ManagedClient {
	client: any; // Client from @modelcontextprotocol/sdk, loaded dynamically
	/** Close the underlying transport. Best-effort; never throws. */
	close(): Promise<void>;
	serverName: string;
}

interface ServerSpec {
	/** Logical name (used in tool prefix and env flag). */
	name: string;
	/** Full endpoint URL. */
	url: string;
	/** Env var that disables this server when set to "0". */
	enabledEnv: string;
}

// ---------------------------------------------------------------------------
// Server registry
// ---------------------------------------------------------------------------

const BASE_URL = process.env.ZAI_MCP_BASE_URL ?? "https://api.z.ai/api/mcp";

/** Phase 1 HTTP servers. Phase 2 (zread) appends here; phase 3 adds stdio. */
const HTTP_SERVERS: ServerSpec[] = [
	{ name: "web_search", url: `${BASE_URL}/web_search_prime/mcp`, enabledEnv: "WEB_SEARCH_ENABLED" },
	{ name: "web_reader", url: `${BASE_URL}/web_reader/mcp`, enabledEnv: "WEB_READER_ENABLED" },
];

// ---------------------------------------------------------------------------
// JSON Schema → typebox converter
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool inputSchema (JSON Schema) into a typebox schema.
 *
 * Deliberately permissive: unknown / unsupported types fall back to
 * Type.Any() so registration never fails on exotic schemas and the LLM can
 * still pass values through to the MCP server.
 */
function jsonSchemaToTypebox(schema: unknown): TSchema {
	if (!schema || typeof schema !== "object") return Type.Any();

	const s = schema as Record<string, unknown>;
	const type = s["type"];

	// enum → union of properly-typed literals (string, number, boolean)
	if (Array.isArray(s["enum"])) {
		const literals = (s["enum"] as unknown[])
			.filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
			.map((v) => Type.Literal(v as string | number | boolean));
		if (literals.length === 0) return Type.Any();
		return (literals.length === 1 ? literals[0] : Type.Union(literals)) as TSchema;
	}

	switch (type) {
		case "string":
			return Type.String();
		case "number":
		case "integer":
			return Type.Number();
		case "boolean":
			return Type.Boolean();
		case "array": {
			const items = jsonSchemaToTypebox(s["items"]);
			return Type.Array(items) as TSchema;
		}
		case "object": {
			const props = (s["properties"] ?? {}) as Record<string, unknown>;
			const required = new Set(Array.isArray(s["required"]) ? (s["required"] as string[]) : []);
			const objProps: Record<string, TSchema> = {};
			for (const [key, sub] of Object.entries(props)) {
				const converted = jsonSchemaToTypebox(sub);
				objProps[key] = required.has(key) ? converted : Type.Optional(converted);
			}
			return Type.Object(objProps) as TSchema;
		}
		default:
			// Missing type (or "null"/"anyOf"/"oneOf" etc.) — accept anything.
			return Type.Any();
	}
}

// ---------------------------------------------------------------------------
// MCP HTTP client
// ---------------------------------------------------------------------------

/**
 * Connect to an HTTP MCP server and return the client plus its tools.
 * Uses StreamableHTTPClientTransport with a Bearer Authorization header.
 *
 * Throws on any failure (caller decides whether to skip or surface).
 */
async function connectHttpMcp(
	serverName: string,
	url: string,
	apiKey: string,
): Promise<{ managed: ManagedClient; tools: McpTool[] }> {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { StreamableHTTPClientTransport } = await import(
		"@modelcontextprotocol/sdk/client/streamableHttp.js"
	);

	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json, text/event-stream",
			},
		},
	});

	const client = new Client(
		{ name: `pi-zai-mcp`, version: "0.1.0" },
		{ capabilities: {} },
	);

	await client.connect(transport);

	// Guard: close transport if listTools() throws so we don't leak an open connection.
	let rawTools: McpTool[];
	try {
		const result = await client.listTools();
		rawTools = result.tools as McpTool[];
	} catch (err) {
		try { await transport.close(); } catch {}
		throw err;
	}

	const managed: ManagedClient = {
		client,
		serverName,
		close: async () => {
			// Close at the Client layer first (clears SDK request-id maps / listeners),
			// then close the underlying transport.
			try { if (typeof client.close === "function") await client.close(); } catch {}
			try { await transport.close(); } catch {}
		},
	};

	return { managed, tools: rawTools };
}

// ---------------------------------------------------------------------------
// MCP content[] → pi AgentToolResult
// ---------------------------------------------------------------------------

/** Flatten an MCP callTool content[] into pi's content array, preferring text. */
function toAgentToolResult(
	items: McpContentItem[] | undefined,
	serverName: string,
	toolName: string,
): AgentToolResult<{ server: string; tool: string; raw: unknown }> {
	const textParts: string[] = [];

	if (Array.isArray(items)) {
		for (const item of items) {
			if (typeof item.text === "string") {
				textParts.push(item.text);
			} else {
				// Non-text content (image/resource/embedded): stringify for visibility.
				try {
					textParts.push(JSON.stringify(item));
				} catch {
					textParts.push(`[${item.type}]`);
				}
			}
		}
	}

	return {
		content: [
			{
				type: "text",
				text: textParts.length ? textParts.join("\n\n") : `(empty response from ${serverName}/${toolName})`,
			},
		],
		details: { server: serverName, tool: toolName, raw: items },
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Owner-declared gating for EVERY zai-mcp tool — migrated from tool-gate's
 * hardcoded GATES entry (ticket 12; was the
 * {names:["zai_web_search_web_search_prime","zai_web_reader_webReader"]} gate).
 *
 * zai-mcp is unlike the other rolled-out extensions: its tool NAMES are
 * discovered dynamically at session_start from each MCP server's listTools(),
 * so there is no static tool literal to attach gating to. Instead the gate is
 * attached here, in registerServerTools — the single site every zai tool is
 * built — and applied IDENTICALLY to every dynamically-registered tool. The
 * keywords mirror the former GATES entry; the noun∧verb `requires` path
 * mirrors flux2/ltx so keyword-free paraphrases (search online / find news /
 * 網路搜尋) also reach the gate (gate-recall adversarial floor 0.9). Precision:
 * the noun `web` is intentionally omitted so the generic bare phrase "search
 * the web for this" still routes to core web_search, not redundant zai-mcp
 * (bare "search"/"web" alone must not fire zai — only noun∧verb co-occurrence
 * or the branded "zai search"/"z.ai" keywords do).
 *
 * buildEffectiveGates splits each name into its own single-name gate; identical
 * predicates → intent-mode co-fire is preserved (every zai tool activates
 * together when any keyword fires). The enable_tool NAME-mode sibling
 * co-activation gap (name-mode activates only the named sibling, not the whole
 * former group) is the same cross-cutting consequence noted across all
 * multi-name rollouts — tracked in the migration map, NOT fixed here.
 */
const ZAI_GATING = {
	keywords: [
		"zai search", "zai reader", "zai web", "zai_mcp",
		"z.ai", "z.ai search", "z.ai reader",
	],
	requires: {
		nouns: ["online", "internet", "page", "site", "news", "網路", "網頁", "線上"],
		verbs: ["search", "find", "搜尋", "查", "找"],
	},
};

// Register the family in the shared registry at module load (ticket 01).
GATE_DEFS["zai"] = {
	id: "zai",
	...ZAI_GATING,
	description: "Z.ai MCP web search / reader tools",
};

/** Register every MCP tool from a connected server as a pi tool. */
export function registerServerTools(
	pi: ExtensionAPI,
	managed: ManagedClient,
	tools: McpTool[],
): void {
	for (const tool of tools) {
		const piName = `zai_${managed.serverName}_${tool.name}`;
		const description = tool.description?.trim() || `MCP tool ${tool.name} from Z.ai ${managed.serverName} server.`;

		pi.registerTool({
			name: piName,
			label: `Z.ai ${managed.serverName} / ${tool.name}`,
			description,
			gating: { gate: "zai" }, // reference form (ticket 01) — family in GATE_DEFS["zai"]
			parameters: jsonSchemaToTypebox(tool.inputSchema),
			async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
				let result;
				try {
					result = await managed.client.callTool(
						{ name: tool.name, arguments: params as Record<string, unknown> },
						undefined,
						{ signal },
					);
				} catch (err) {
					return {
						content: [{ type: "text", text: `MCP call failed (${managed.serverName}/${tool.name}): ${errMessage(err)}` }],
						details: { server: managed.serverName, tool: tool.name, error: errMessage(err) },
						isError: true,
					} as AgentToolResult<unknown>;
				}
				const content = (result?.content ?? []) as McpContentItem[];
				const toolResult = toAgentToolResult(content, managed.serverName, tool.name);
				// Propagate MCP application-level error flag so the LLM sees tool failure.
				if (result?.isError) return { ...toolResult, isError: true };
				return toolResult;
			},
		});
	}
}

// ---------------------------------------------------------------------------
// Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime
// `gating` object). Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts.
// Plain object: no `satisfies` / type import, so this extension never depends
// on tool-gate (avoids a circular dep); shape is enforced by tool-gate's
// drift-guard test.
//   - controls[]  carry a current keyword → MUST fire.
//   - adversarial[] are keyword-free "I need this tool" phrasings that fire via
//     the noun∧verb `requires` path on the runtime gating. recallFloor 0.9 =
//     the calibrated target now that the zai gate carries a requires path (was
//     0 when the gate was keywords-only and paraphrased intent could not fire).
//     The noun `web` is omitted from requires (so the exact generic phrase
//     "search the web for this" routes to core web_search, not zai-mcp); the two
//     former adversarial probes that depended on `web`/the unbindable phrasal
//     verb "look up" were rephrased to clearer real-intent phrasings the
//     narrowed requires covers ("search the internet for this" /
//     "find this online") — same Z.ai web-search/reader intent.
// ---------------------------------------------------------------------------
export const __GATE_PROBES__ = {
	gate: "zai_web_search_web_search_prime",
	recallFloor: 0.9,
	adversarial: ["search the internet for this", "find this online", "網路搜尋一下"],
	controls: ["use z.ai search", "zai web search for news", "用 z.ai reader 讀這頁"],
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// Per-session client list — each extension invocation gets its own array so
	// concurrent sessions (RPC mode) cannot close each other's MCP connections.
	let sessionClients: ManagedClient[] = [];

	pi.on("session_start", async (event, ctx) => {
		// DEBUG VERIFICATION MODE — ZAI_MCP_DEBUG_BANNER forces the startup
		// banner with NO MCP connection, NO API key, fired immediately, and
		// mirrored to stderr so the trigger + rendered message are observable
		// in any mode (incl. headless print/RPC where setWidget is a no-op).
		//   ZAI_MCP_DEBUG_BANNER=1      → success banner (synthetic tools)
		//   ZAI_MCP_DEBUG_BANNER=empty  → no-tools banner
		// Returns early so the real connection path is skipped entirely.
		const debugBanner = process.env.ZAI_MCP_DEBUG_BANNER;
		if (debugBanner !== undefined && debugBanner !== "") {
			const theme = ctx.ui.theme;
			const noTools = debugBanner === "empty";
			const syntheticTools = noTools
				? []
				: ["zai_web_search_web_search_prime", "zai_web_reader_webReader"];
			const syntheticServers = noTools ? 0 : 2;
			if (syntheticTools.length > 0) {
				scheduleReadyBanner(
					ctx,
					[
						theme.fg("accent", `🛰 zai-mcp ready — ${syntheticTools.length} tool(s) · ${syntheticServers} server(s)`),
						theme.fg("dim", syntheticTools.join(" · ")),
					],
					{ immediate: true, log: true },
				);
			} else {
				scheduleReadyBanner(
					ctx,
					[theme.fg("warning", "⚠ zai-mcp: no MCP tools registered (check ZAI_API_KEY / network)")],
					{ immediate: true, log: true },
				);
			}
			return;
		}

		// Dependency check: @modelcontextprotocol/sdk must be installed (bun install at repo root).
		const missing = missingDeps(["@modelcontextprotocol/sdk"], _EXT_DIR);
		if (missing.length > 0) {
			const root = findMonorepoRoot(_EXT_DIR);
			ctx.ui.notify(
				`zai-mcp: missing npm package @modelcontextprotocol/sdk.\nRun: bun install (in ${root})`,
				"error",
			);
			return;
		}

		// Reset state (handles reload/fork).
		await closeAll(sessionClients);
		sessionClients = [];
		const registeredToolNames: string[] = [];

		const apiKey = process.env.ZAI_API_KEY;
		if (!apiKey) {
			ctx.ui.notify("zai-mcp: ZAI_API_KEY not set — skipping all Z.ai MCP servers.", "warning");
			return;
		}

		for (const spec of HTTP_SERVERS) {
			if (process.env[spec.enabledEnv] === "0") continue;
			try {
				const { managed, tools } = await connectHttpMcp(spec.name, spec.url, apiKey);
				sessionClients.push(managed);
				registerServerTools(pi, managed, tools);
				for (const t of tools) registeredToolNames.push(`zai_${managed.serverName}_${t.name}`);
			} catch (err) {
				ctx.ui.notify(
					`zai-mcp: failed to connect ${spec.name} (${spec.url}): ${errMessage(err)}`,
					"error",
				);
			}
		}

		// Transient above-editor banner (like the /goal banner), delayed past the
		// hard-error notifies above so they settle first. setWidget is keyed
		// ("zai-mcp"), so this never clobbers — or is clobbered by — other
		// extensions' banners; that independence is what previously forced the
		// scary "Warning:" notify hack. In non-interactive (RPC / print) modes
		// setWidget is a silent no-op while theme is still present, so this
		// degrades gracefully with no output.
		const theme = ctx.ui.theme;
		if (registeredToolNames.length > 0) {
			scheduleReadyBanner(ctx, [
				theme.fg("accent", `🛰 zai-mcp ready — ${registeredToolNames.length} tool(s) · ${sessionClients.length} server(s)`),
				theme.fg("dim", registeredToolNames.join(" · ")),
			]);
		} else {
			scheduleReadyBanner(ctx, [
				theme.fg("warning", "⚠ zai-mcp: no MCP tools registered (check ZAI_API_KEY / network)"),
			]);
		}
	});

	pi.on("session_shutdown", async () => {
		await closeAll(sessionClients);
		sessionClients = [];
	});
}

/** Close every tracked client. Best-effort, parallel, never throws. */
async function closeAll(clients: ManagedClient[]): Promise<void> {
	await Promise.all(clients.map((c) => c.close().catch(() => {})));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Schedule a transient above-editor banner (like the /goal banner): show once
 * after a short delay, then auto-dismiss. Mirrors pi-agent-ext-obsidian's
 * scheduleVaultBanner(). Uses setWidget (keyed) instead of notify() so this
 * extension's startup line never clobbers — or is clobbered by — other
 * extensions' messages, which is what forced the old "warning" notify hack.
 *
 * Both deferred ctx.ui calls are guarded: a session switch (/resume, ctx.fork,
 * ctx.switchSession) between schedule and fire leaves ctx stale, and ctx.ui's
 * assertActive() would otherwise throw an uncaughtException that crashes pi.
 * The banner is non-essential — a replacement session renders its own on its
 * own session_start — so swallow.
 *
 * `opts.immediate` skips the 5s show delay (debug). `opts.log` mirrors the
 * rendered lines to stderr so the trigger is observable where setWidget is a
 * no-op (print/RPC). Both default off; prod calls omit `opts` entirely.
 */
export function scheduleReadyBanner(
	ctx: { ui: { setWidget(key: string, lines: string[] | undefined): void } },
	lines: string[],
	opts?: { immediate?: boolean; log?: boolean },
): void {
	// Prod: delay 5s so the banner lands after the startup notify burst (and
	// before obsidian's 10s vault banner). Debug (ZAI_MCP_DEBUG_BANNER): 0.
	const SHOW_DELAY_MS = opts?.immediate ? 0 : 5_000;
	const DISPLAY_MS = 8_000; // visible window before auto-dismiss (matches obsidian)
	if (opts?.log) {
		// Mirror the rendered lines (incl. ANSI colors from theme.fg) to stderr so
		// the trigger + exact message are visible even where setWidget is a no-op
		// (print / RPC / noOpUIContext).
		console.error(`[zai-mcp banner]\n${lines.join("\n")}`);
	}
	setTimeout(() => {
		try {
			ctx.ui.setWidget("zai-mcp", lines);
		} catch {
			return; // ctx stale after session switch — banner is non-essential
		}
		// Auto-dismiss after DISPLAY_MS. Guarded the same way: a session switch
		// between show and dismiss leaves ctx stale.
		setTimeout(() => {
			try {
				ctx.ui.setWidget("zai-mcp", undefined);
			} catch {
				/* ctx stale after session switch */
			}
		}, DISPLAY_MS);
	}, SHOW_DELAY_MS);
}

function errMessage(err: unknown): string {
	// SECURITY: never JSON.stringify the whole error — some libraries attach the
	// failed `request` (incl. Authorization header) to the error object, which
	// would leak the bearer token into notifications / tool details. Only the
	// human-readable message is safe to surface.
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	const maybe = (err as Record<string, unknown>)?.message;
	return typeof maybe === "string" ? maybe : "unknown error";
}
