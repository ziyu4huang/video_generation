/**
 * auto-recall.test.ts — ticket 08 (context-lifecycle P2) unit pins:
 *   - trigger gate: short / chitchat / disabled prompts skip retrieval
 *   - score floor: a top card under the shared-tag floor injects nothing
 *   - budget: per-entry 2× rule, turn cap with tail-drop (never slices),
 *     and the 350-tok default cap actually bounds the block
 *   - child-guard: in-memory session (falsy sessionFile) never injects
 *   - render: prefix-stable block format (fixed open/hint/close)
 *   - failure degradation: retrieval error / timeout inject nothing, never throw
 * All retrieval is injected — no vault, no embedder, hermetic.
 */
import { test, expect } from "bun:test";
import {
	AUTORECALL_DEFAULTS,
	applyAutoRecallEnv,
	budgetLines,
	buildAutoRecallBlock,
	estimateTokens,
	isChildSession,
	renderCardLine,
	renderInjectionBlock,
	shouldRecall,
	weightedLength,
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

// ─── CJK-weighted length gate (ticket 16) ────────────────────────────────────

test("gate: zh questions clear the 40 gate via CJK weighting (t10's 2/10 length misses)", () => {
	// ~24 CJK + ~9 ASCII ≈ 33 raw chars (t10: gated) → weighted ≈ 57 (passes).
	const zhQuestion = "塑膠感皮膚問題的根源是出在平台、base 模型還是 lora 身上？";
	expect(shouldRecall(zhQuestion, ARMED)).toBe(true);
});

test("gate: weighting never un-gates a short zh chitchat-style prompt", () => {
	// Weighted length only RAISES effective length; the chitchat RE and short
	// prompts stay gated (weighted ≈ 6 < 40).
	expect(shouldRecall("嗯好的", ARMED)).toBe(false);
});

test("weightedLength: CJK chars weigh 2, ASCII 1", () => {
	expect(weightedLength("abcd")).toBe(4);
	expect(weightedLength("四個中文字")).toBe(10); // 5 chars, all CJK
	expect(weightedLength("a中b文")).toBe(6); // 4 chars + 2 CJK
});

// ─── env overrides (ticket 16 battery lane) ─────────────────────────────────

test("applyAutoRecallEnv: floor/minChars/timeout pin, invalid values ignored", () => {
	const pinned = applyAutoRecallEnv(
		{ KC_AUTORECALL_FLOOR: "0", KC_AUTORECALL_MINCHARS: "12", KC_AUTORECALL_TIMEOUTMS: "15000" },
		ARMED,
	);
	expect(pinned.scoreFloor).toBe(0);
	expect(pinned.minPromptChars).toBe(12);
	expect(pinned.timeoutMs).toBe(15000);
	// Battery pins must not leak into enabled or other knobs.
	expect(pinned.enabled).toBe(true);
	expect(pinned.tokenCap).toBe(ARMED.tokenCap);
	// A probe may only WIDEN the bound (t16: the child needs >3 s; it must not
	// be able to shrink the turn-loop guarantee below the default).
	const shrink = applyAutoRecallEnv({ KC_AUTORECALL_TIMEOUTMS: "10" }, ARMED);
	expect(shrink.timeoutMs).toBe(ARMED.timeoutMs);
	// A typo'd env must never crash the agent — defaults win.
	const bad = applyAutoRecallEnv({ KC_AUTORECALL_FLOOR: "yes", KC_AUTORECALL_MINCHARS: "-3", KC_AUTORECALL_TIMEOUTMS: "soon" }, ARMED);
	expect(bad.scoreFloor).toBe(ARMED.scoreFloor);
	expect(bad.minPromptChars).toBe(ARMED.minPromptChars);
	expect(bad.timeoutMs).toBe(ARMED.timeoutMs);
	const noop = applyAutoRecallEnv({}, ARMED);
	expect(noop.scoreFloor).toBe(ARMED.scoreFloor);
});

// ─── child-guard ─────────────────────────────────────────────────────────────

test("child-guard: in-memory session (falsy sessionFile) is a child; persisted is not", () => {
	expect(isChildSession("")).toBe(true);
	expect(isChildSession(undefined)).toBe(true);
	expect(isChildSession("/home/u/.pi/agent/sessions/abc.jsonl")).toBe(false);
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
	// Child session (in-memory ⇒ empty sessionFile) gates before retrieval.
	const r = await buildAutoRecallBlock(
		"a long prompt about lora training runs",
		{ vaultPath: "/v", retrieve, sessionFile: "" },
		ARMED,
	);
	expect(r.block).toBe("");
	expect(r.trace.gated).toBe(true);
	expect(calls).toBe(0);
	const r2 = await buildAutoRecallBlock("short", { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl" }, ARMED);
	expect(calls).toBe(0);
	expect(r2.trace.gated).toBe(true);
});

test("pipeline: score floor — top card under the floor injects nothing", async () => {
	const retrieve = async () => ({ count: 1, cards: [fakeCard({ sharedTags: 1 })] });
	const r = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl" }, ARMED);
	expect(r.block).toBe("");
	expect(r.trace.gated).toBe(true);
	expect(r.trace.retrieved).toBe(1);
});

test("pipeline: healthy pass renders a bounded ranked block", async () => {
	const retrieve = async () => ({
		count: 2,
		cards: [fakeCard(), fakeCard({ id: "t2", title: "Second", sharedTags: 2 })],
	});
	const r = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl" }, ARMED);
	expect(r.trace.kept).toBe(2);
	expect(r.block).toContain("[gotcha] Test Card");
	expect(r.block).toContain("[gotcha] Second");
	expect(estimateTokens(r.block)).toBeLessThanOrEqual(ARMED.tokenCap + 40); // block chrome ~20 tok
});

test("pipeline: retrieval failure / timeout injects nothing and never throws", async () => {
	const boom = async () => {
		throw new Error("embedder down");
	};
	const r = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve: boom, sessionFile: "/s.jsonl" }, ARMED);
	expect(r.block).toBe("");
	expect(r.trace.timedOut).toBe(false);

	const hang = () => new Promise<never>(() => {}); // never settles → timeout path
	const r2 = await buildAutoRecallBlock("prompt about the lora and argparse training behavior", { vaultPath: "/v", retrieve: hang, sessionFile: "/s.jsonl" }, ARMED);
	expect(r2.block).toBe("");
	expect(r2.trace.timedOut).toBe(true);
});

// ─── wiring-level pins (extension-contract companion) ────────────────────────
// The hook-level behavior (ctx guard, armed append) is pinned in
// extension-contract.test.ts; here we pin the pipeline's sessionFile plumbing.

test("pipeline: a persisted sessionFile reaches retrieval (parent path)", async () => {
	let seen = false;
	const retrieve = async () => {
		seen = true;
		return { count: 1, cards: [fakeCard()] };
	};
	const r = await buildAutoRecallBlock(
		"prompt about the lora and argparse training behavior",
		{ vaultPath: "/v", retrieve, sessionFile: "/sessions/main.jsonl" },
		ARMED,
	);
	expect(seen).toBe(true);
	expect(r.trace.kept).toBe(1);
});

