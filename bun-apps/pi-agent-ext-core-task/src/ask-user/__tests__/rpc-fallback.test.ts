/**
 * Tests for the RPC dialog-walker fallback — ctx.ui.select/input based
 * questionnaire for non-TUI hosts (VSCode, ACP, Zed).
 *
 * Ported from rpiv-ask-user-question rpc-fallback.test.ts (upstream).
 * Adapted from vitest to bun:test — inlines mock pi + ctx without rpiv-test-utils.
 * Text expectations adjusted for local response-envelope format.
 *
 * Tier: P1 — RPC interaction paths, exercised by non-TUI hosts.
 *
 * Covers: hasDialogUI, single-select, 'Type something.' sentinel walker,
 *         option previews, multi-select, dismiss (cancel), multi-question
 *         sequential walking, custom()-undefined fallback.
 */
import { test, expect, describe, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "../ask-user-question.js";
import { hasDialogUI } from "../rpc-fallback.js";
import type { QuestionParams } from "../tool/types.js";

// ─── Mock pi + ctx helpers ───────────────────────────────────────────────────

function createMockPi() {
	const tools = new Map<string, { execute?: (...args: unknown[]) => unknown }>();
	const pi = {
		registerTool: mock((def: { name: string; execute: (...args: unknown[]) => unknown }) => {
			tools.set(def.name, { execute: def.execute });
		}),
		getActiveTools: mock(() => []),
		setActiveTools: mock(() => {}),
		on: mock(() => {}),
		// External answer channel (frozen impl contract): execute subscribes via
		// pi.events.on and later calls the returned teardown — no-op stub is enough.
		events: { emit: mock(() => {}), on: mock(() => () => {}) },
	};
	return { pi: pi as unknown as ExtensionAPI, tools };
}

function registerTool() {
	const { pi, tools } = createMockPi();
	registerAskUserQuestionTool(pi as unknown as ExtensionAPI);
	return tools.get("ask_user_question")!;
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const SINGLE: QuestionParams = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

const MULTI: QuestionParams = {
	questions: [
		{
			question: "Pick colors?",
			header: "Colors",
			multiSelect: true,
			options: [
				{ label: "red", description: "r" },
				{ label: "green", description: "g" },
				{ label: "blue", description: "b" },
			],
		},
	],
};

async function run(
	tool: { execute?: (...args: unknown[]) => unknown },
	params: unknown,
	ctx: unknown,
): Promise<{ details?: unknown; content: Array<{ text?: string; type?: string }> } | undefined> {
	return (await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never)) as
		| { details?: unknown; content: Array<{ text?: string; type?: string }> }
		| undefined;
}

// ─── hasDialogUI ─────────────────────────────────────────────────────────────

describe("hasDialogUI", () => {
	test("requires both select and input to be functions", () => {
		expect(hasDialogUI({ select: async () => undefined, input: async () => "" })).toBe(true);
		expect(hasDialogUI({ select: async () => undefined })).toBe(false);
		expect(hasDialogUI({ input: async () => "" })).toBe(false);
		expect(hasDialogUI(undefined)).toBe(false);
	});
});

// ─── RPC dialog walker ───────────────────────────────────────────────────────

describe("ask_user_question.execute — RPC dialog walker (ctx.mode === 'rpc')", () => {
	test("single-select uses ctx.ui.select and returns the chosen label in the envelope", async () => {
		const tool = registerTool();
		const select = mock(async (_t: string, _options: string[]) => "2. B — b");
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: select as never, input: mock(async () => "") as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, SINGLE, ctx);
		expect(select).toHaveBeenCalledTimes(1);
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Which? → B") });
	});

	test("does NOT call ctx.ui.custom in RPC mode", async () => {
		const tool = registerTool();
		const custom = mock(async () => ({ answers: [], cancelled: true }));
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { custom: custom as never, select: mock(async (_t: string, _o: string[]) => "1. A — a") as never, input: mock(async () => "") as never } };
		await run(tool, SINGLE, ctx);
		expect(custom).not.toHaveBeenCalled();
	});

	test("appends the 'Type something.' sentinel row sourced from ROW_INTENT_META", async () => {
		const tool = registerTool();
		let offered: string[] = [];
		const select = mock(async (_t: string, options: string[]) => {
			offered = options;
			return options[0];
		});
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: select as never, input: mock(async () => "") as never, custom: mock(async () => undefined) as never } };
		await run(tool, SINGLE, ctx);
		expect(offered).toEqual(["1. A — a", "2. B — b", "3. Type something."]);
	});

	test("'Type something.' sentinel follows up with ctx.ui.input for custom text", async () => {
		const tool = registerTool();
		const select = mock(async (_t: string, options: string[]) => options[options.length - 1]!);
		const input = mock(async () => "typed it");
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: select as never, input: input as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, SINGLE, ctx);
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Which? → (custom) typed it") });
	});

	test("folds option previews into the select title and echoes the selected preview", async () => {
		const tool = registerTool();
		const withPreview: QuestionParams = {
			questions: [
				{
					question: "Which?",
					header: "Pick",
					options: [
						{ label: "A", description: "a", preview: "PREVIEW-A" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		let title = "";
		const select = mock(async (t: string, _options: string[]) => {
			title = t;
			return "1. A — a";
		});
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: select as never, input: mock(async () => "") as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, withPreview, ctx);
		expect(title).toContain("PREVIEW-A");
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Which? → A") });
	});

	test("multi-select uses ctx.ui.input and parses comma-separated indices into labels", async () => {
		const tool = registerTool();
		const input = mock(async () => "1,3"); // red, blue
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: mock(async () => "") as never, input: input as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, MULTI, ctx);
		expect(input).toHaveBeenCalledTimes(1);
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("[red, blue]") });
	});

	test("multi-select treats non-index input as a typed custom answer, not a silent drop", async () => {
		const tool = registerTool();
		const input = mock(async () => "red, something else entirely");
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: mock(async () => "") as never, input: input as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, MULTI, ctx);
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({
			text: expect.stringContaining("(custom) red, something else entirely"),
		});
	});

	test("multi-select empty input commits an empty selection (Next with nothing toggled)", async () => {
		const tool = registerTool();
		const input = mock(async () => "  ");
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: mock(async () => "") as never, input: input as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, MULTI, ctx);
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("(none selected)") });
	});

	test("dismiss (select resolves undefined) → decline envelope", async () => {
		const tool = registerTool();
		const select = mock(async () => undefined);
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: select as never, input: mock(async () => "") as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, SINGLE, ctx);
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("cancelled the questionnaire") });
	});

	test("walks multiple questions sequentially, one dialog each", async () => {
		const tool = registerTool();
		const params: QuestionParams = { questions: [...SINGLE.questions, ...MULTI.questions] };
		const select = mock(async () => "1. A — a");
		const input = mock(async () => "2"); // green
		const ctx = { hasUI: true, mode: "rpc" as const, ui: { select: select as never, input: input as never, custom: mock(async () => undefined) as never } };
		const r = await run(tool, params, ctx);
		expect(select).toHaveBeenCalledTimes(1);
		expect(input).toHaveBeenCalledTimes(1);
		const text = r?.content[0]?.text ?? "";
		expect(text).toContain("Which? → A");
		expect(text).toContain("[green]");
	});
});

describe("ask_user_question.execute — dialog walker as custom()-undefined backstop", () => {
	test("falls back to the dialog walker when ctx.mode is unset and custom() resolves undefined", async () => {
		const tool = registerTool();
		const custom = mock(async () => undefined);
		const select = mock(async () => "2. B — b");
		const ctx = { hasUI: true, ui: { custom: custom as never, select: select as never, input: mock(async () => "") as never } as never };
		const r = await run(tool, SINGLE, ctx);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(select).toHaveBeenCalledTimes(1);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Which? → B") });
	});

	test("stays on the custom() path when ctx.mode is unset and custom() renders (TUI)", async () => {
		const tool = registerTool();
		const custom = mock(async () => ({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which?", kind: "option" as const, answer: "A" }],
		}));
		const select = mock(async () => "should-not-be-called");
		const ctx = { hasUI: true, ui: { custom: custom as never, select: select as never } as never };
		const r = await run(tool, SINGLE, ctx);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(select).not.toHaveBeenCalled();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Which? → A") });
	});
});
