/**
 * Unit tests for the thin never-throws LM Studio chat-completions client.
 * Deterministic: fetch is injected (`_fetchImpl`) so no live LM Studio is
 * required and the module stays inert at import time (no network at top level).
 *
 * Covers: success parse; retry-once-then-success (first body unparseable,
 * second parseable — exactly 2 fetch calls); unparseable after retry → null
 * (2 calls); HTTP 500 → null with NO retry (fail fast on HTTP error);
 * timeout/network reject → null; `reasoning_content` fallback when content is
 * empty/unparseable; parseFn throw contained → null.
 */
import { test, expect, describe } from "bun:test";
import { chatJson, type LmChatOptions } from "../src/llm-chat.ts";

/** Minimal OpenAI-shaped chat-completions response body. */
function chatBody(content: string, reasoningContent?: string): unknown {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					content,
					...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
				},
			},
		],
	};
}

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function http500(): Response {
	return new Response("Internal Server Error", { status: 500 });
}

/**
 * Bun's `typeof fetch` requires the `preconnect` static that plain async
 * closures lack — cast through unknown to keep mocks one-liners.
 */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function asFetch(f: FetchLike): typeof fetch {
	return f as unknown as typeof fetch;
}

/** JSON.parse-based parseFn — the shape Task 2/4 callers pass. */
const parseJson = <T,>(text: string): T => JSON.parse(text) as T;

const baseOpts: LmChatOptions = {
	apiUrl: "http://lmstudio.test",
	model: "test-model",
};

function optsWith(fetchImpl: FetchLike): LmChatOptions {
	return { ...baseOpts, _fetchImpl: asFetch(fetchImpl) };
}

describe("chatJson", () => {
	test("success: parseable 200 content → parseFn result", async () => {
		const calls: number[] = [];
		const fetchImpl: FetchLike = async (_input, init) => {
			calls.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
			return okResponse(chatBody('{"ok":1}'));
		};
		const result = await chatJson<{ ok: number }>("prompt", parseJson, optsWith(fetchImpl));
		expect(result).toEqual({ ok: 1 });
		expect(calls).toEqual([2048]); // no retry needed; first attempt budget
	});

	test("retry-then-success: first body unparseable, second parseable → result, exactly 2 calls", async () => {
		let call = 0;
		const calls: number[] = [];
		const fetchImpl: FetchLike = async (_input, init) => {
			call++;
			calls.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
			return okResponse(chatBody(call === 1 ? "not json at all" : '{"ok":2}'));
		};
		const result = await chatJson<{ ok: number }>("prompt", parseJson, optsWith(fetchImpl));
		expect(result).toEqual({ ok: 2 });
		expect(calls).toEqual([2048, 14000]); // one retry at the larger budget
	});

	test("unparseable after retry → null (2 calls)", async () => {
		let call = 0;
		const fetchImpl: FetchLike = async () => {
			call++;
			return okResponse(chatBody(`garbage ${call}`));
		};
		const result = await chatJson("prompt", parseJson, optsWith(fetchImpl));
		expect(result).toBeNull();
		expect(call).toBe(2);
	});

	test("HTTP 500 → null, no retry (fail fast on HTTP error)", async () => {
		let call = 0;
		const fetchImpl: FetchLike = async () => {
			call++;
			return http500();
		};
		const result = await chatJson("prompt", parseJson, optsWith(fetchImpl));
		expect(result).toBeNull();
		expect(call).toBe(1); // HTTP error does not trigger the parse-retry
	});

	test("network reject (fetch throws) → null", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("ECONNREFUSED");
		};
		const result = await chatJson("prompt", parseJson, optsWith(fetchImpl));
		expect(result).toBeNull();
	});

	test("timeout (AbortError) → null", async () => {
		const fetchImpl: FetchLike = (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted due to timeout");
					err.name = "AbortError";
					reject(err);
				});
			});
		const result = await chatJson("prompt", parseJson, {
			...baseOpts,
			timeoutMs: 50,
			_fetchImpl: asFetch(fetchImpl),
		});
		expect(result).toBeNull();
	});

	test("reasoning_content fallback: content empty, reasoning_content parseable → result", async () => {
		const fetchImpl: FetchLike = async () => okResponse(chatBody("", '{"ok":3}'));
		const result = await chatJson<{ ok: number }>("prompt", parseJson, optsWith(fetchImpl));
		expect(result).toEqual({ ok: 3 });
	});

	test("parseFn throwing is contained → null (never propagates)", async () => {
		const fetchImpl: FetchLike = async () => okResponse(chatBody("totally not json"));
		const throwingParse = (): unknown => {
			throw new SyntaxError("Unexpected token");
		};
		const result = await chatJson("prompt", throwingParse, optsWith(fetchImpl));
		expect(result).toBeNull();
	});

	test("retry attempt returns HTTP 500 → null (exactly 2 calls)", async () => {
		let call = 0;
		const fetchImpl: FetchLike = async () => {
			call++;
			return call === 1 ? okResponse(chatBody("not json")) : http500();
		};
		const result = await chatJson("prompt", parseJson, optsWith(fetchImpl));
		expect(result).toBeNull();
		expect(call).toBe(2); // retry fired; its HTTP error → null, no third call
	});

	test("async parseFn rejection is contained → retry → null (never propagates)", async () => {
		let call = 0;
		const fetchImpl: FetchLike = async () => {
			call++;
			return okResponse(chatBody("body"));
		};
		// Mis-typed against the sync contract: returns a rejected promise.
		const asyncThrowingParse = (): unknown =>
			Promise.reject(new SyntaxError("async parse failure")) as unknown;
		const result = await chatJson("prompt", asyncThrowingParse, optsWith(fetchImpl));
		expect(result).toBeNull();
		expect(call).toBe(2);
	});

	test("env defaults: LMSTUDIO_BASE_URL / PI_KG_LLM_MODEL flow into fetch URL and body", async () => {
		// Env is read inside chatJson (never at import time), so per-test
		// mutation is safe; restored in finally to not leak into other tests.
		const prevBase = process.env.LMSTUDIO_BASE_URL;
		const prevModel = process.env.PI_KG_LLM_MODEL;
		process.env.LMSTUDIO_BASE_URL = "http://env-lmstudio.test:9999";
		process.env.PI_KG_LLM_MODEL = "env-model";
		try {
			let seenUrl = "";
			let seenModel = "";
			const fetchImpl: FetchLike = async (input, init) => {
				seenUrl = String(input);
				seenModel = (JSON.parse(String(init?.body)) as { model: string }).model;
				return okResponse(chatBody('{"ok":1}'));
			};
			const result = await chatJson<{ ok: number }>("prompt", parseJson, {
				_fetchImpl: asFetch(fetchImpl),
			});
			expect(result).toEqual({ ok: 1 });
			expect(seenUrl).toBe("http://env-lmstudio.test:9999/v1/chat/completions");
			expect(seenModel).toBe("env-model");
		} finally {
			if (prevBase === undefined) delete process.env.LMSTUDIO_BASE_URL;
			else process.env.LMSTUDIO_BASE_URL = prevBase;
			if (prevModel === undefined) delete process.env.PI_KG_LLM_MODEL;
			else process.env.PI_KG_LLM_MODEL = prevModel;
		}
	});
});
