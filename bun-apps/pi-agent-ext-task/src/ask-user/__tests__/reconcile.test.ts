/**
 * Tests for mid-session lifecycle reconciliation.
 *
 * Ported from rpiv-ask-user-question reconcile.test.ts (upstream).
 * Adapted from vitest to bun:test — inlines mock pi without rpiv-test-utils.
 *
 * Tier: P1 — lifecycle paths, needs mock pi.
 *
 * Covers: reconcileAskUserQuestionTool (strip on !hasUI, restore on hasUI,
 *         no-op when already correct, sibling-tool preservation, idempotence,
 *         RPC mode), registerAskUserQuestionReconciler, factory wiring.
 */
import { test, expect, describe, mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME } from "../ask-user-question.js";
import factory from "../index.js";
import { reconcileAskUserQuestionTool, registerAskUserQuestionReconciler } from "../reconcile.js";

// ─── Mock pi helpers ─────────────────────────────────────────────────────────

function createMockPi() {
	const active = new Set<string>();
	const events = new Map<string, Array<(...args: unknown[]) => void>>();

	const pi = {
		getActiveTools: mock(() => [...active]),
		setActiveTools: mock((tools: string[]) => {
			active.clear();
			for (const t of tools) active.add(t);
		}),
		on: mock((event: string, handler: (...args: unknown[]) => void) => {
			if (!events.has(event)) events.set(event, []);
			events.get(event)!.push(handler);
		}),
		// ExtensionAPI also needs registerTool for the factory test
		registerTool: mock(() => {}),
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		events,
		active,
	};
}

function createMockCtx(over: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		hasUI: over.hasUI ?? true,
		mode: over.mode ?? "tui",
		extensionName: "power-tool",
		currentToolName: undefined,
	} as unknown as ExtensionContext;
}

// ─── reconcileAskUserQuestionTool ────────────────────────────────────────────

describe("reconcileAskUserQuestionTool", () => {
	test("strips ask_user_question when !hasUI and the tool is active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	test("no-ops when !hasUI and the tool is already absent", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	test("restores ask_user_question when hasUI and the tool is absent", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});

	test("no-ops when hasUI and the tool is already active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual([ASK_USER_QUESTION_TOOL_NAME, "other"]);
	});

	test("does not clobber sibling tools on strip — ['ask_user_question','other'] + !hasUI → ['other']", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	test("does not clobber sibling tools on restore — ['other'] + hasUI → ['other','ask_user_question']", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});

	test("strip→restore round-trips back to present", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.getActiveTools()).toEqual(["other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});

	test("is idempotent — two stripped-mode calls make one setActiveTools and leave the set stable", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		const ctx = createMockCtx({ hasUI: false });
		reconcileAskUserQuestionTool(pi, ctx);
		reconcileAskUserQuestionTool(pi, ctx);
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	test("is idempotent — two restored-mode calls (already correct) make zero mutations and leave the set stable", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		const ctx = createMockCtx({ hasUI: true });
		reconcileAskUserQuestionTool(pi, ctx);
		reconcileAskUserQuestionTool(pi, ctx);
		expect(pi.getActiveTools()).toEqual([ASK_USER_QUESTION_TOOL_NAME, "other"]);
	});

	test("keeps ask_user_question active in RPC mode (dialog-walker fallback renders it)", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true, mode: "rpc" }));
		expect(pi.getActiveTools()).toEqual([ASK_USER_QUESTION_TOOL_NAME, "other"]);
	});

	test("restores ask_user_question in RPC mode when the tool is absent", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true, mode: "rpc" }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});

	test("restores ask_user_question in TUI mode (mode: 'interactive' + hasUI)", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true, mode: "tui" }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});
});

// ─── registerAskUserQuestionReconciler ──────────────────────────────────────

describe("registerAskUserQuestionReconciler", () => {
	test("registers exactly one before_agent_start handler", () => {
		const { pi, events } = createMockPi();
		registerAskUserQuestionReconciler(pi as unknown as ExtensionAPI);
		expect(events.get("before_agent_start")).toHaveLength(1);
	});

	test("invoking the handler with !hasUI strips the tool", () => {
		const { pi, events } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		registerAskUserQuestionReconciler(pi as unknown as ExtensionAPI);
		const handler = events.get("before_agent_start")![0];
		handler(undefined, createMockCtx({ hasUI: false }));
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	test("invoking the handler with hasUI restores the tool", () => {
		const { pi, events } = createMockPi();
		pi.setActiveTools(["other"]);
		registerAskUserQuestionReconciler(pi as unknown as ExtensionAPI);
		const handler = events.get("before_agent_start")![0];
		handler(undefined, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});
});

// ─── factory wiring (index.ts default export) ────────────────────────────────

describe("factory wiring (index.ts default export)", () => {
	test("wires both registerAskUserQuestionTool and registerAskUserQuestionReconciler", async () => {
		const { pi, events } = createMockPi();
		await factory(pi as unknown as ExtensionAPI);
		// registerAskUserQuestionTool ran (tool registered)
		expect(pi.registerTool).toHaveBeenCalled();
		// registerAskUserQuestionReconciler ran (before_agent_start handler attached)
		expect(events.get("before_agent_start")).toHaveLength(1);
	});
});
