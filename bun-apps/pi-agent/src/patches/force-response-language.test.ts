/**
 * force-response-language — unit tests for the pure decision functions
 * (mapLanguageTag + resolveForcedBlock) and the per-turn injection mechanism
 * (wrapInstallAgentNextTurnRefresh).
 *
 * The import-time prototype wrap (AgentSession.prototype._installAgentNextTurnRefresh)
 * is intentionally NOT asserted here; it is a thin side effect. Mirrors the
 * subagent-model-floor / resolvePatchPlan split.
 */
import { describe, expect, test } from "bun:test";
import { mapLanguageTag, resolveForcedBlock, wrapInstallAgentNextTurnRefresh } from "./force-response-language.ts";

const S = (entries: Record<string, unknown>) => entries;

describe("mapLanguageTag — known tags", () => {
	test("zh-TW → Traditional Chinese label inside a forced block", () => {
		const out = mapLanguageTag("zh-TW");
		expect(out).toContain("繁體中文 (Traditional Chinese, zh-TW)");
		expect(out).toContain("priority=\"forced\"");
		expect(out?.startsWith("<response_language")).toBe(true);
	});

	test("zh-Hant alias → same Traditional Chinese label", () => {
		expect(mapLanguageTag("zh-Hant")!).toContain("繁體中文 (Traditional Chinese, zh-Hant)");
	});

	test("case-insensitive: ZH-TW == zh-tw", () => {
		expect(mapLanguageTag("ZH-TW")).toBe(mapLanguageTag("zh-tw"));
	});

	test("en → English label", () => {
		expect(mapLanguageTag("en")!).toContain("English");
	});
});

describe("mapLanguageTag — unknown / edge tags", () => {
	test("unknown tag → references the tag literally (still a forced block)", () => {
		const out = mapLanguageTag("xx-YY");
		expect(out).toContain("xx-YY");
		expect(out).toContain("priority=\"forced\"");
	});

	test("trims surrounding whitespace before mapping", () => {
		expect(mapLanguageTag("  zh-TW  ")).toBe(mapLanguageTag("zh-TW"));
	});

	test("empty string → undefined", () => {
		expect(mapLanguageTag("")).toBeUndefined();
	});

	test("whitespace-only → undefined", () => {
		expect(mapLanguageTag("   ")).toBeUndefined();
	});
});

describe("mapLanguageTag — block content invariants", () => {
	test("the block is non-negotiable + overrides role labels / model default", () => {
		const out = mapLanguageTag("zh-TW")!;
		expect(out).toContain("non-negotiable");
		expect(out.toLowerCase()).toContain("priority");
	});

	test("the block scopes itself to conversation, not written artifacts", () => {
		const out = mapLanguageTag("zh-TW")!;
		expect(out).toContain("conversation only");
	});
});

describe("resolveForcedBlock — settings → block", () => {
	test("responseLanguage set → returns the forced block", () => {
		expect(resolveForcedBlock(S({ responseLanguage: "zh-TW" }))).toBe(mapLanguageTag("zh-TW"));
	});

	test("trims the value before mapping", () => {
		expect(resolveForcedBlock(S({ responseLanguage: "  en  " }))).toBe(mapLanguageTag("en"));
	});
});

describe("resolveForcedBlock — no-op cases", () => {
	test("undefined settings → undefined", () => {
		expect(resolveForcedBlock(undefined)).toBeUndefined();
	});

	test("missing responseLanguage field → undefined", () => {
		expect(resolveForcedBlock(S({ defaultModel: "glm-5.2" }))).toBeUndefined();
	});

	test("non-string responseLanguage (number) → undefined", () => {
		expect(resolveForcedBlock(S({ responseLanguage: 123 }))).toBeUndefined();
	});

	test("blank / whitespace-only responseLanguage → undefined", () => {
		expect(resolveForcedBlock(S({ responseLanguage: "   " }))).toBeUndefined();
		expect(resolveForcedBlock(S({ responseLanguage: "" }))).toBeUndefined();
	});
});

describe("resolveForcedBlock — purity", () => {
	test("does not mutate the passed settings", () => {
		const settings = S({ responseLanguage: "zh-TW" });
		resolveForcedBlock(settings);
		expect(settings).toEqual(S({ responseLanguage: "zh-TW" }));
	});
});

/** Stub prototype whose _installAgentNextTurnRefresh assigns agent.prepareNextTurnWithContext = prep. */
function makeRefreshProto(prep: (...args: unknown[]) => unknown): object {
	return {
		_installAgentNextTurnRefresh(this: { agent: { prepareNextTurnWithContext?: unknown } }) {
			this.agent.prepareNextTurnWithContext = prep;
		},
	};
}

/** A session instance: { agent: {} } on the proto chain. */
function makeSession(proto: object): { agent: Record<string, unknown>; _installAgentNextTurnRefresh: () => void } {
	const instance = Object.create(proto) as { agent: Record<string, unknown>; _installAgentNextTurnRefresh: () => void };
	instance.agent = {};
	return instance;
}

describe("wrapInstallAgentNextTurnRefresh — the per-turn injection mechanism", () => {
	test("prepends the block to context.systemPrompt each turn", async () => {
		const proto = makeRefreshProto(async () => ({ context: { systemPrompt: "BASE-PROMPT", tools: [] } }));
		expect(wrapInstallAgentNextTurnRefresh(proto, () => "BLOCK")).toBe(true);
		const session = makeSession(proto);
		session._installAgentNextTurnRefresh();
		const snap = (await (session.agent.prepareNextTurnWithContext as (...a: unknown[]) => Promise<unknown>)({})) as {
			context: { systemPrompt: string };
		};
		expect(snap.context.systemPrompt).toBe("BLOCK\n\nBASE-PROMPT");
	});

	test("no block (undefined) → context.systemPrompt passes through unchanged", async () => {
		const proto = makeRefreshProto(async () => ({ context: { systemPrompt: "BASE", tools: [] } }));
		wrapInstallAgentNextTurnRefresh(proto, () => undefined);
		const session = makeSession(proto);
		session._installAgentNextTurnRefresh();
		const snap = (await (session.agent.prepareNextTurnWithContext as (...a: unknown[]) => Promise<unknown>)({})) as {
			context: { systemPrompt: string };
		};
		expect(snap.context.systemPrompt).toBe("BASE");
	});

	test("forwards turn + signal to the original prepareNextTurnWithContext", async () => {
		let receivedTurn: unknown;
		let receivedSignal: unknown;
		const proto = makeRefreshProto(async (turn, signal) => {
			receivedTurn = turn;
			receivedSignal = signal;
			return { context: { systemPrompt: "BASE" } };
		});
		wrapInstallAgentNextTurnRefresh(proto, () => "B");
		const session = makeSession(proto);
		session._installAgentNextTurnRefresh();
		const turn = { x: 1 };
		const signal = Symbol("s");
		await (session.agent.prepareNextTurnWithContext as (...a: unknown[]) => Promise<unknown>)(turn, signal);
		expect(receivedTurn).toBe(turn);
		expect(receivedSignal).toBe(signal);
	});

	test("idempotent per-agent — re-running _installAgentNextTurnRefresh doesn't double-wrap", async () => {
		const proto = makeRefreshProto(async () => ({ context: { systemPrompt: "BASE" } }));
		wrapInstallAgentNextTurnRefresh(proto, () => "B");
		const session = makeSession(proto);
		session._installAgentNextTurnRefresh();
		session._installAgentNextTurnRefresh(); // agent already wrapped
		const snap = (await (session.agent.prepareNextTurnWithContext as (...a: unknown[]) => Promise<unknown>)({})) as {
			context: { systemPrompt: string };
		};
		expect(snap.context.systemPrompt).toBe("B\n\nBASE");
	});

	test("idempotent per-proto — a second wrap on the same proto returns false", () => {
		const proto = makeRefreshProto(async () => ({ context: { systemPrompt: "BASE" } }));
		expect(wrapInstallAgentNextTurnRefresh(proto, () => "FIRST")).toBe(true);
		expect(wrapInstallAgentNextTurnRefresh(proto, () => "SECOND")).toBe(false);
	});

	test("missing _installAgentNextTurnRefresh → returns false (upstream changed shape)", () => {
		expect(wrapInstallAgentNextTurnRefresh({}, () => "BLOCK")).toBe(false);
	});

	test("missing this.agent → original runs, no throw, no post-wrap", () => {
		const proto = { _installAgentNextTurnRefresh() {} };
		wrapInstallAgentNextTurnRefresh(proto, () => "B");
		const session = Object.create(proto) as { agent?: unknown; _installAgentNextTurnRefresh: () => void };
		expect(() => session._installAgentNextTurnRefresh()).not.toThrow();
	});
});
