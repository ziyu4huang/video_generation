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

/** Register every MCP tool from a connected server as a pi tool. */
function registerServerTools(
	pi: ExtensionAPI,
	managed: ManagedClient,
	tools: McpTool[],
): void {
	for (const tool of tools) {
		const piName = `zai_${managed.serverName}_${tool.name}`;
		// description with a clear prompt snippet so the LLM picks the right tool
		const description = tool.description?.trim() || `MCP tool ${tool.name} from Z.ai ${managed.serverName} server.`;
		const promptSnippet = `${piName}: ${firstLine(description)}`;

		pi.registerTool({
			name: piName,
			label: `Z.ai ${managed.serverName} / ${tool.name}`,
			description,
			promptSnippet,
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
// Lifecycle
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// Per-session client list — each extension invocation gets its own array so
	// concurrent sessions (RPC mode) cannot close each other's MCP connections.
	let sessionClients: ManagedClient[] = [];

	pi.on("session_start", async (event, ctx) => {
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

		// Startup-only notification (transient toast). Deliberately NOT using
		// setStatus() — that would pin a permanent entry in the footer status
		// bar. A notify shows the info once at load and then gets out of the way.
		//
		// Type is "warning" on purpose, NOT "info": pi's showStatus() merges
		// consecutive info notifies into one (overwriting earlier text), so
		// back-to-back extension startup messages would clobber each other.
		// showWarning() always appends a new line, so every extension's
		// startup line stays visible. Trade-off: a "Warning:" prefix +
		// warning color on what is really an info message.
		if (registeredToolNames.length > 0) {
			ctx.ui.notify(
				`zai-mcp ready — ${registeredToolNames.length} tool(s) from ${sessionClients.length} server(s):\n${formatToolList(registeredToolNames)}`,
				"warning",
			);
		} else {
			ctx.ui.notify("zai-mcp: no MCP tools registered (check ZAI_API_KEY / network).", "warning");
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

/** Format tool names into a compact, readable list for the load summary. */
function formatToolList(names: string[]): string {
	return names.map((n) => `  • ${n}`).join("\n");
}

function firstLine(s: string): string {
	const line = s.split(/\r?\n/)[0] ?? "";
	return line.length > 120 ? line.slice(0, 117) + "..." : line;
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
