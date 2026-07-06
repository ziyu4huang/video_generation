/**
 * zai.ts — Z.ai web search as a native web_search provider.
 *
 * Mirrors exa.ts's MCP-over-plain-fetch pattern (NO @modelcontextprotocol/sdk
 * dependency): POST JSON-RPC 2.0 to Z.ai's HTTP MCP endpoint with a Bearer
 * token, parse the SSE `data:` reply. The search tool name is DISCOVERED at
 * first use via tools/list (Z.ai exposes its tools dynamically, like all MCP
 * servers), so this never hard-codes a tool name that could drift.
 *
 * Quota exhaustion (HTTP 429/402, or a quota/credit/rate-limit/餘額/額度
 * message) throws ZaiQuotaError so the auto provider chain falls through to
 * the next provider (exa → brave → …) — honoring "use Z.ai first, fall back
 * only when the Z.ai quota runs out".
 *
 * Env:
 *   ZAI_API_KEY        (required)  Bearer token. isZaiAvailable() is false without it.
 *   ZAI_MCP_BASE_URL   (optional)  Default https://api.z.ai/api/mcp
 */
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";

const ZAI_MCP_BASE_URL = process.env.ZAI_MCP_BASE_URL ?? "https://api.z.ai/api/mcp";
const ZAI_SEARCH_URL = `${ZAI_MCP_BASE_URL}/web_search_prime/mcp`;
const REQUEST_TIMEOUT_MS = 60000;

export type ZaiSearchResult = SearchResponse | null;

export interface ZaiSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

/** Tagged error: Z.ai quota exhausted → the auto chain should fall through. */
export class ZaiQuotaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZaiQuotaError";
	}
}

interface ZaiRpcResult {
	result?: {
		tools?: Array<{ name?: string; description?: string }>;
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code?: number; message?: string };
}

/** True if a failure looks like a quota / rate-limit / out-of-credit signal. */
function looksLikeQuotaExhausted(status: number | undefined, message: string): boolean {
	if (status === 429 || status === 402) return true;
	const m = message.toLowerCase();
	return (
		m.includes("quota") ||
		m.includes("rate limit") ||
		m.includes("rate-limit") ||
		m.includes("credit") ||
		m.includes("insufficient") ||
		m.includes("exceeded") ||
		m.includes("余额") || // CJK: balance
		m.includes("额度") || // CJK: quota
		m.includes("次数") // CJK: usage count
	);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function getApiKey(): string | null {
	const raw = process.env.ZAI_API_KEY;
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export function isZaiAvailable(): boolean {
	return !!getApiKey();
}

/**
 * Low-level JSON-RPC call to the Z.ai MCP endpoint. Returns the parsed
 * JSON-RPC envelope (result or error). Throws ZaiQuotaError on quota signals,
 * Error on HTTP/network/protocol failure.
 */
async function zaiRpc(
	method: "tools/list" | "tools/call",
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ZaiRpcResult> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error("ZaiSearch unavailable: ZAI_API_KEY not set");

	const response = await fetch(ZAI_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const msg = `Z.ai MCP HTTP ${response.status}: ${text.slice(0, 300)}`;
		if (looksLikeQuotaExhausted(response.status, msg)) throw new ZaiQuotaError(msg);
		throw new Error(msg);
	}

	// Reply may be SSE (`data: {...}` lines) or plain JSON — accept either.
	const body = await response.text();
	let parsed: ZaiRpcResult | null = null;
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ZaiRpcResult;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch { /* keep scanning SSE lines */ }
	}
	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ZaiRpcResult;
			if (candidate?.result || candidate?.error) parsed = candidate;
		} catch { /* fall through to empty-response error */ }
	}
	if (!parsed) throw new Error("Z.ai MCP returned an empty/unparseable response");

	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		const msg = parsed.error.message || "Unknown Z.ai MCP error";
		if (looksLikeQuotaExhausted(undefined, msg)) throw new ZaiQuotaError(`Z.ai MCP error${code}: ${msg}`);
		throw new Error(`Z.ai MCP error${code}: ${msg}`);
	}
	if (parsed.result?.isError) {
		const msg = parsed.result.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text?.trim()
			|| "Z.ai tool returned an error";
		if (looksLikeQuotaExhausted(undefined, msg)) throw new ZaiQuotaError(msg);
		throw new Error(msg);
	}
	return parsed;
}

// ─── Tool discovery (Z.ai exposes tools dynamically via tools/list) ──────────

let cachedSearchToolName: string | null = null;

/** Test-only: clear the discovered-tool cache so tests are isolated. */
export function _resetZaiToolCacheForTest(): void {
	cachedSearchToolName = null;
}

async function resolveSearchToolName(signal?: AbortSignal): Promise<string> {
	if (cachedSearchToolName) return cachedSearchToolName;
	const res = await zaiRpc("tools/list", {}, signal);
	const tools = res.result?.tools ?? [];
	// Prefer a tool whose name contains "search"; else the first listed tool.
	const match = tools.find((t) => typeof t.name === "string" && /search/i.test(t.name)) ?? tools[0];
	if (!match?.name) throw new Error("Z.ai MCP exposed no search tool");
	cachedSearchToolName = match.name;
	return match.name;
}

// ─── Result parsing (Z.ai's text result is free-form — try several shapes) ───

interface ParsedZaiResult { title: string; url: string; snippet: string }

function parseZaiResults(text: string): { answer: string; results: ParsedZaiResult[] } {
	const trimmed = text.trim();

	// 1) JSON array of objects carrying url/title/link.
	try {
		const arr = JSON.parse(trimmed);
		if (Array.isArray(arr)) {
			const results = arr
				.map((r: Record<string, unknown>) => ({
					title: String(r?.title ?? r?.name ?? ""),
					url: String(r?.url ?? r?.link ?? ""),
					snippet: String(r?.snippet ?? r?.text ?? r?.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
				}))
				.filter((r) => r.url.length > 0);
			if (results.length > 0) return { answer: buildAnswerFromResults(results), results };
		}
	} catch { /* not JSON — try block format */ }

	// 2) Block format "Title: ..\nURL: .." (the shape Exa MCP uses).
	const blocks = trimmed.split(/(?=^Title:\s)/m).filter((b) => b.trim());
	if (blocks.length > 1) {
		const results = blocks
			.map((b) => {
				const title = b.match(/^Title:\s*(.+)/m)?.[1]?.trim() ?? "";
				const url = b.match(/^URL:\s*(\S+)/m)?.[1]?.trim() ?? "";
				const snippet = (b.match(/(?:Text|Highlights|Summary):\s*([\s\S]*?)$/m)?.[1] ?? "")
					.replace(/\s+/g, " ").trim().slice(0, 500);
				return { title, url, snippet };
			})
			.filter((r) => r.url.length > 0);
		if (results.length > 0) return { answer: buildAnswerFromResults(results), results };
	}

	// 3) Fallback: treat the whole text as a synthesized answer, no structured sources.
	return { answer: trimmed, results: [] };
}

function buildAnswerFromResults(results: ParsedZaiResult[]): string {
	return results
		.map((r, i) => `${r.snippet || r.title}\nSource: ${r.title || `Source ${i + 1}`} (${r.url})`)
		.join("\n\n");
}

// ─── Public search entry (mirrors exa.ts's searchWithExa shape) ──────────────

function buildZaiQuery(query: string, options: ZaiSearchOptions): string {
	const parts = [query];
	if (options.domainFilter?.length) {
		for (const d of options.domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (options.recencyFilter) {
		const now = new Date();
		switch (options.recencyFilter) {
			case "day": parts.push("past 24 hours"); break;
			case "week": parts.push("past week"); break;
			case "month": parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`); break;
			case "year": parts.push(String(now.getFullYear())); break;
		}
	}
	return parts.join(" ");
}

export async function searchWithZai(query: string, options: ZaiSearchOptions = {}): Promise<ZaiSearchResult> {
	const enrichedQuery = buildZaiQuery(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query: enrichedQuery });
	try {
		const toolName = await resolveSearchToolName(options.signal);
		const res = await zaiRpc(
			"tools/call",
			{
				name: toolName,
				arguments: {
					query: enrichedQuery,
					// Cover common param namings; the server reads what it knows.
					...(options.numResults ? { num: options.numResults, numResults: options.numResults } : {}),
				},
			},
			options.signal,
		);
		const text = res.result?.content?.find((c) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0)?.text ?? "";
		activityMonitor.logComplete(activityId, 200);
		if (!text.trim()) return null;
		const { answer, results } = parseZaiResults(text);
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}
