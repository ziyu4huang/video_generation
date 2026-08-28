/**
 * auto-recall.test.ts — ticket 08 (context-lifecycle P2) unit pins:
 *   - trigger gate: short / chitchat / disabled prompts skip retrieval
 *   - score floor: a top card under the shared-tag floor injects nothing
 *   - budget: per-entry 2× rule, turn cap with tail-drop (never slices),
 *     and the 350-tok default cap actually bounds the block
 *   - child-guard: S2_AGENT_SUBAGENT=1 never injects
 *   - render: prefix-stable block format (fixed open/hint/close)
 *   - failure degradation: retrieval error / timeout inject nothing, never throw
 * All retrieval is injected — no vault, no embedder, hermetic.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
	AUTORECALL_DEFAULTS,
	budgetLines,
	buildAutoRecallBlock,
	estimateTokens,
	isSubagentChild,
	renderCardLine,
	renderInjectionBlock,
	shouldRecall,
	type AutoRecallConfig,
	type BudgetResult,
} from "../src/inject/auto-recall.ts";
import type { RetrievedCard } from "../src/retrieve.ts";

const ARMED: AutoRecallConfig = { ...AUTORECALL_DEFAULTS, enabled: true, timeoutMs: 250 };

function fakeCard(over: Partial<RetrievedCard> = {}): RetrievedCard {
	return {
		id: "workflow:test-1",
		title: "Test Card",
		type: "gotcha",
		detail: "the abstract line",
		tags: ["lora", "argparse", "misc", "fourth", "fifth"],
		sharedTags: 3,
		path: "Zettelkasten/knowledge-graph/test-card",
		source: "workflow:test",
		hasCallouts: false,
		calloutText: "",
		tier: "abstract",
		tiers: { abstract: "", overview: "", full: "" },
		...over,
	};
}

// ─── gate ────────────────────────────────────────────────────────────────────

test("gate: disabled config never recalls", () => {
	expect(shouldRecall("a long enough prompt about lora training", AUTORECALL_DEFAULTS)).toBe(false);
});

test("gate: short prompt skips", () => {
	expect(shouldRecall("too short", ARMED)).toBe(false);
});

test("gate: bare chitchat skips, greeting inside a real question does not", () => {
	expect(shouldRecall("hi! thanks!!! ok", ARMED)).toBe(false);
	expect(shouldRecall("你好,謝謝,好的", ARMED)).toBe(false);
	// Length gate is what protects real questions; "hi," prefix must not gate.
	expect(shouldRecall("hi, what broke in the lora training run last night?", ARMED)).toBe(true);
});

// ─── child-guard ─────────────────────────────────────────────────────────────

test("child-guard: S2_AGENT_SUBAGENT=1 skips injection entirely", () => {
	process.env.S2_AGENT_SUBAGENT = "1";
	try {
		expect(isSubagentChild()).toBe(true);
	} finally {
		delete process.env.S2_AGENT_SUBAGENT;
	}
	expect(isSubagentChild()).toBe(false);
});

// ─── budget ──────────────────────────────────────────────────────────────────

test("budget: per-entry 2× rule drops an oversized line instead of slicing it", () => {
	const fair = "x".repeat(40); // 10 tok each
	const oversized = "y".repeat(400); // 100 tok — 10× the fair share
	const r: BudgetResult = budgetLines([fair, oversized, fair], 60);
	// perEntryCap = 2 × (60/3) = 40 tok; oversized (100 tok) is dropped whole.
	expect(r.lines).toHaveLength(2);
	expect(r.lines.every((l) => !l.includes("y"))).toBe(true);
	const dropped = r.entries.find((e) => e.reason === "per-entry-overflow");
	expect(dropped?.line).toBe(oversized);
});

test("budget: turn cap drops the overflowing entry, keeps a shorter later one", () => {
	const a = "a".repeat(80); // 20 tok
	const big = "b".repeat(120); // 30 tok
	const c = "c".repeat(40); // 10 tok
	// cap 45: a fits (20); big would hit 50 > 45 → dropped; c fits (30 ≤ 45).
	const r = budgetLines([a, big, c], 45);
	expect(r.lines).toEqual([a, c]);
	expect(r.tokensUsed).toBe(30);
	const dropped = r.entries.find((e) => e.reason === "turn-cap");
	expect(dropped?.line).toBe(big);
});

test("budget: nothing is ever mid-sliced", () => {
	const lines = [`${"a".repeat(300)}`, `${"b".repeat(10)}`];
	const r = budgetLines(lines, 30);
	for (const e of r.entries) {
		if (e.kept) expect(lines).toContain(e.line);
		else expect(e.reason).toBeDefined();
	}
});

test("budget: the 350-tok default cap bounds the rendered block", () => {
	const many = Array.from({ length: 12 }, (_, i) => `${i}${"k".repeat(100)}`); // ~26 tok each
	const r = budgetLines(many, AUTORECALL_DEFAULTS.tokenCap);
	expect(r.tokensUsed).toBeLessThanOrEqual(AUTORECALL_DEFAULTS.tokenCap);
});

// ─── render ──────────────────────────────────────────────────────────────────

test("render: card line is [type] title — top3-tags: detail", () => {
	expect(renderCardLine(fakeCard())).toBe("[gotcha] Test Card — lora,argparse,misc: the abstract line");
	expect(renderCardLine(fakeCard({ tags: [] }))).toBe("[gotcha] Test Card: the abstract line");
});

test("render: block format is prefix-stable (open, hint, bullets, close)", () => {
	const b1 = renderInjectionBlock(["one", "two"]);
	const b2 = renderInjectionBlock(["different"]);
	expect(b1.split("\n")[0]).toBe(b2.split("\n")[0]); // same <knowledge-recall> open
	expect(b1.startsWith("<knowledge-recall>\nAuto-recalled")).toBe(true);
	expect(b1.endsWith("</knowledge-recall>")).toBe(true);
	expect(b1).toContain("- one");
	expect(renderInjectionBlock([])).toBe("");
});

// ─── pipeline (injected retrieve; hermetic) ──────────────────────────────────

test("pipeline: gates before retrieval (disabled/short/child) — retrieve NOT called", async () => {
	let calls = 0;
	const retrieve = async () => {
		calls++;
		return { count: 1, cards: [fakeCard()] };
	};
	process.env.S2_AGENT_SUBAGENT = "1";
	try {
		const r = await buildAutoRecallBlock("a long prompt about lora training runs", { vaultPath: "/v", retrieve }, ARMED);
		expect(r.block).toBe("");
		expect(r.trace.gated).toBe(true);
		expect(calls).toBe(0);
	} finally {
		delete process.env.S2_AGENT_SUBAGENT;
	}
	const r2 = await buildAutoRecallBlock("short", { vaultPath: "/v", retrieve }, ARMED);
	expect(calls).toBe(0);
	expect(r2.trace.gated).toBe(true);
});

test("pipeline: score floor — top card under the floor injects nothing", async () => {
	const retrieve = async () => ({ count: 1, cards: [fakeCard({ sharedTags: 1 })] });
	const r = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve }, ARMED);
	expect(r.block).toBe("");
	expect(r.trace.gated).toBe(true);
	expect(r.trace.retrieved).toBe(1);
});

test("pipeline: healthy pass renders a bounded ranked block", async () => {
	const retrieve = async () => ({
		count: 2,
		cards: [fakeCard(), fakeCard({ id: "t2", title: "Second", sharedTags: 2 })],
	});
	const r = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve }, ARMED);
	expect(r.trace.kept).toBe(2);
	expect(r.block).toContain("[gotcha] Test Card");
	expect(r.block).toContain("[gotcha] Second");
	expect(estimateTokens(r.block)).toBeLessThanOrEqual(ARMED.tokenCap + 40); // block chrome ~20 tok
});

test("pipeline: retrieval failure / timeout injects nothing and never throws", async () => {
	const boom = async () => {
		throw new Error("embedder down");
	};
	const r = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve: boom }, ARMED);
	expect(r.block).toBe("");
	expect(r.trace.timedOut).toBe(false);

	const hang = () => new Promise<never>(() => {}); // never settles → timeout path
	const r2 = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve: hang }, ARMED);
	expect(r2.block).toBe("");
	expect(r2.trace.timedOut).toBe(true);
});

// ─── env restore discipline (mirrors the core-runtime set/restore) ──────────

test("env: guard reads live env (documents the core-runtime contract)", () => {
	const prev = process.env.S2_AGENT_SUBAGENT;
	process.env.S2_AGENT_SUBAGENT = "1";
	expect(isSubagentChild()).toBe(true);
	if (prev === undefined) delete process.env.S2_AGENT_SUBAGENT;
	else process.env.S2_AGENT_SUBAGENT = prev;
	expect(isSubagentChild()).toBe(false);
});

beforeEach(() => {
	delete process.env.S2_AGENT_SUBAGENT;
});
afterEach(() => {
	delete process.env.S2_AGENT_SUBAGENT;
});
