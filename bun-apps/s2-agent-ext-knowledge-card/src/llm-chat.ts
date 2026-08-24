/**
 * src/llm-chat.ts — thin never-throws LM Studio chat-completions client.
 *
 * The ONLY chat-completions HTTP client in the bun-apps tree. Contract adapted
 * from movie-director's `lmStudioJsonCall` WITHOUT any movie-director
 * dependency: temperature 0.3, stream:false, first attempt max_tokens 2048,
 * and on failure-to-parse (HTTP ok) exactly ONE retry at max_tokens 14000.
 * Consumed by LlmRelationExtractor (Phase-2 T2) and ⑥ entity-summary condense
 * (T4) via the injectable `_fetchImpl` (mirrors `semantic.ts`'s Embedder
 * pattern — tests run deterministic, no live LM Studio).
 *
 * NEVER-THROWS at the boundary: every failure mode — HTTP !ok, timeout
 * (AbortSignal.timeout), network error, unparseable after retry — returns null.
 * No exceptions escape `chatJson`. Module top level is inert: env is read
 * inside the call, never at import time.
 */
import { loadModelTierConfig, resolveModelRole, type ModelTierConfig } from "@repo/s2-agent-core-runtime";

/** Injectable options — every field defaulted; tests inject `_fetchImpl`. */
export interface LmChatOptions {
	/** Base URL; defaults to `LMSTUDIO_BASE_URL` env or `http://localhost:1234`. */
	apiUrl?: string;
	/** Model id; defaults to `PI_KG_LLM_MODEL` env > central capabilities.vision
	 *  (model-tiers.json) > local terminal default. */
	model?: string;
	/** Per-attempt timeout; default 30000ms. */
	timeoutMs?: number;
	/** Fetch override for deterministic tests. */
	_fetchImpl?: typeof fetch;
}

/** Attempt token budgets: first pass, then the single parse-failure retry. */
const MAX_TOKENS_FIRST = 2048;
const MAX_TOKENS_RETRY = 14000;

interface ChatChoiceMessage {
	content?: string;
	reasoning_content?: string;
}

interface ChatCompletionsResponse {
	choices?: { message?: ChatChoiceMessage }[];
}

/**
 * POST one chat-completions request and return the assistant message content,
 * preferring `content` and falling back to `reasoning_content` (reasoning
 * models sometimes leave `content` empty).
 */
async function postChat(
	prompt: string,
	maxTokens: number,
	opts: LmChatOptions,
	fetchImpl: typeof fetch,
): Promise<{ ok: true; text: string } | { ok: false }> {
	try {
		const res = await fetchImpl(`${opts.apiUrl ?? lmStudioBase()}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: opts.model ?? resolveKgModel(),
				messages: [{ role: "user", content: prompt }],
				max_tokens: maxTokens,
				temperature: 0.3,
				stream: false,
			}),
			signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
		});
		if (!res.ok) return { ok: false };
		const j = (await res.json()) as ChatCompletionsResponse;
		const message = j.choices?.[0]?.message;
		const text = message?.content?.trim() || message?.reasoning_content?.trim() || "";
		return { ok: true, text };
	} catch {
		return { ok: false };
	}
}

function lmStudioBase(): string {
	return process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234";
}

/**
 * Model for local chat-JSON calls. Precedence: PI_KG_LLM_MODEL env >
 * central capabilities.vision from ~/.pi/workflows/model-tiers.json (provider
 * prefix stripped — this package talks to the local LM Studio
 * OpenAI-compatible endpoint) > terminal local default. The terminal default
 * stays because chatJson's contract is ALL-failures→null; model resolution
 * must not throw.
 */
export function resolveKgModel(config: Parameters<typeof resolveModelRole>[1] = loadModelTierConfig()): string {
	const env = process.env.PI_KG_LLM_MODEL;
	if (env) return env;
	const spec = resolveModelRole({ capability: "vision" }, config);
	if (spec) {
		const slash = spec.indexOf("/");
		let id = slash === -1 ? spec : spec.slice(slash + 1);
		// Strip the pi `model:effort` suffix (e.g. "gemma-4-12b:off") — LM
		// Studio model ids never carry it. Measured 2026-08-24: the leaked
		// ":off" made LM Studio silently route the request to whatever model
		// happened to be loaded (prism-ml/bonsai-27b, 2× slower prefill),
		// which is one half of the shutdown-extract never-succeeds loop.
		const colon = id.lastIndexOf(":");
		if (colon > 0) id = id.slice(0, colon);
		return id;
	}
	return "google/gemma-4-12b";
}

/**
 * Invoke the caller's (sync-contract) parseFn without letting ANY failure
 * escape — including a mis-typed async parseFn whose promise rejects: the
 * result is funneled through `Promise.resolve(...)` and both the sync throw
 * and the async rejection land in the same catch. Sync throws are caught
 * because the call itself sits inside the try block. null is the failure
 * sentinel that drives chatJson's retry-then-null semantics.
 */
async function safeParse<T>(parseFn: (text: string) => T, text: string): Promise<T | null> {
	try {
		return await Promise.resolve(parseFn(text));
	} catch {
		return null;
	}
}

/**
 * Send `prompt` to the local LM Studio chat endpoint and parse the assistant
 * text with the caller's `parseFn`. Tolerant: leading/trailing prose and
 * fenced ```json blocks around the JSON body are the parseFn's business (it
 * may strip fences before JSON.parse). ALL failures → null, never throws.
 */
export async function chatJson<T>(
	prompt: string,
	parseFn: (text: string) => T,
	opts: LmChatOptions = {},
): Promise<T | null> {
	const fetchImpl = opts._fetchImpl ?? fetch;
	const first = await postChat(prompt, MAX_TOKENS_FIRST, opts, fetchImpl);
	if (!first.ok) return null; // HTTP error / timeout / network: fail fast, no retry
	const parsed = await safeParse(parseFn, first.text);
	if (parsed !== null) return parsed;
	// Unparseable at the small budget: ONE retry at the larger budget.
	const retry = await postChat(prompt, MAX_TOKENS_RETRY, opts, fetchImpl);
	if (!retry.ok) return null;
	return await safeParse(parseFn, retry.text);
}
