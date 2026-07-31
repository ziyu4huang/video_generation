/**
 * force-response-language — unit tests for the pure decision functions
 * (mapLanguageTag + resolveForcedBlock).
 *
 * The import-time prototype wrap (AgentSession.prototype._rebuildSystemPrompt)
 * is intentionally NOT asserted here; it is a thin side effect. Mirrors the
 * subagent-model-floor / resolvePatchPlan split.
 */
import { describe, expect, test } from "bun:test";
import { mapLanguageTag, resolveForcedBlock, wrapRebuildSystemPrompt } from "./force-response-language.ts";

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

describe("wrapRebuildSystemPrompt — the injection mechanism", () => {
	test("prepends the block ahead of the original rebuilt prompt", () => {
		const proto = { _rebuildSystemPrompt: function () { return "BASE-PROMPT"; } };
		expect(wrapRebuildSystemPrompt(proto, () => "BLOCK")).toBe(true);
		expect((proto as { _rebuildSystemPrompt: () => string })._rebuildSystemPrompt()).toBe("BLOCK\n\nBASE-PROMPT");
	});

	test("no block (undefined) → original prompt passes through unchanged", () => {
		const proto = { _rebuildSystemPrompt: function () { return "BASE-PROMPT"; } };
		wrapRebuildSystemPrompt(proto, () => undefined);
		expect((proto as { _rebuildSystemPrompt: () => string })._rebuildSystemPrompt()).toBe("BASE-PROMPT");
	});

	test("forwards the call (this + args) to the original", () => {
		let receivedThis: unknown = null;
		let receivedArgs: unknown[] = [];
		const proto = {
			_rebuildSystemPrompt: function (this: unknown, ...args: unknown[]) {
				receivedThis = this;
				receivedArgs = args;
				return "BASE";
			},
		};
		wrapRebuildSystemPrompt(proto, () => "B");
		const instance = Object.create(proto);
		(instance as { _rebuildSystemPrompt: (...a: unknown[]) => string })._rebuildSystemPrompt("x", 1);
		expect(receivedThis).toBe(instance);
		expect(receivedArgs).toEqual(["x", 1]);
	});

	test("idempotent — a second wrap on the same proto returns false and keeps the first", () => {
		const proto = { _rebuildSystemPrompt: function () { return "BASE"; } };
		expect(wrapRebuildSystemPrompt(proto, () => "FIRST")).toBe(true);
		expect(wrapRebuildSystemPrompt(proto, () => "SECOND")).toBe(false);
		expect((proto as { _rebuildSystemPrompt: () => string })._rebuildSystemPrompt()).toBe("FIRST\n\nBASE");
	});

	test("missing original method → returns false (upstream changed shape)", () => {
		expect(wrapRebuildSystemPrompt({}, () => "BLOCK")).toBe(false);
	});

	test("each prototype is wrapped independently", () => {
		const a = { _rebuildSystemPrompt: function () { return "A"; } };
		const b = { _rebuildSystemPrompt: function () { return "B"; } };
		wrapRebuildSystemPrompt(a, () => "X");
		wrapRebuildSystemPrompt(b, () => "Y");
		expect((a as { _rebuildSystemPrompt: () => string })._rebuildSystemPrompt()).toBe("X\n\nA");
		expect((b as { _rebuildSystemPrompt: () => string })._rebuildSystemPrompt()).toBe("Y\n\nB");
	});
});
