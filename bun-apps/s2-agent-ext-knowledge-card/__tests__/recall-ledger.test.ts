/**
 * recall-ledger — ticket 09 (context-lifecycle P2): session cooldown over the
 * t08 injector. Acceptance shape under test: a card served turn 1 is
 * suppressed turns 2–3 and eligible again turn 4; a no_relevant turn records
 * NOTHING (the OpenViking ledger-poisoning fix); retrieveRecords stays pure
 * (identical calls across turns — the ledger never leaks into the library).
 */
import { describe, expect, test } from "bun:test";
import { RecallLedger, DEFAULT_COOLDOWN_TURNS } from "../src/inject/recall-ledger.ts";
import {
	AUTORECALL_DEFAULTS,
	buildAutoRecallBlock,
	type AutoRecallConfig,
} from "../src/inject/auto-recall.ts";
import type { RetrievedCard } from "../src/retrieve.ts";

const ARMED: AutoRecallConfig = { ...AUTORECALL_DEFAULTS, enabled: true };

const PROMPT = "prompt about the lora and argparse training behavior";

function fakeCard(over: Partial<RetrievedCard> = {}): RetrievedCard {
	return {
		id: "workflow:test-1",
		title: "Test Card",
		type: "gotcha",
		detail: "the abstract line",
		tags: ["lora", "argparse", "misc"],
		sharedTags: 2,
		path: "Zettelkasten/knowledge-graph/test-card",
		source: "workflow:test",
		hasCallouts: false,
		calloutText: "",
		tier: "abstract",
		tiers: { abstract: "", overview: "", full: "" },
		...over,
	};
}

// ─── class unit ──────────────────────────────────────────────────────────────

describe("RecallLedger (class)", () => {
	test("default cooldown is 3 turns; 0/negative clamps to 1", () => {
		expect(DEFAULT_COOLDOWN_TURNS).toBe(3);
		expect(new RecallLedger().cooldownTurns).toBe(3);
		expect(new RecallLedger(0).cooldownTurns).toBe(1);
		expect(new RecallLedger(-2).cooldownTurns).toBe(1);
	});

	test("tick decrements, expires exactly on turn N+1, and re-arms on re-serve", () => {
		const l = new RecallLedger(3);
		l.recordServed(["a"]);
		expect(l.isCooled("a")).toBe(true);
		l.tick(); // turn 2: 3 → 2
		expect(l.isCooled("a")).toBe(true);
		l.tick(); // turn 3: 2 → 1
		expect(l.isCooled("a")).toBe(true);
		l.tick(); // turn 4: expired
		expect(l.isCooled("a")).toBe(false);
		expect(l.cooledCount()).toBe(0);
		l.recordServed(["a"]); // re-serve restarts the window
		expect(l.isCooled("a")).toBe(true);
	});

	test("recordServed is idempotent per id and unknown ids are never cooled", () => {
		const l = new RecallLedger(2);
		l.recordServed(["a", "a"]);
		expect(l.cooledCount()).toBe(1);
		expect(l.isCooled("b")).toBe(false);
		expect(l.toJSON()).toEqual({ a: 2 });
	});
});

// ─── pipeline integration (acceptance) ──────────────────────────────────────

describe("pipeline + ledger (ticket 09 acceptance)", () => {
	test("serve → suppressed ×2 → eligible again (default cooldown 3)", async () => {
		const ledger = new RecallLedger();
		const retrieve = async () => ({ count: 2, cards: [fakeCard(), fakeCard({ id: "t2", title: "Second" })] });
		const turn = async () => {
			ledger.tick();
			return buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		};
		const t1 = await turn();
		expect(t1.trace.kept).toBe(2);
		expect(t1.block).toContain("Test Card");
		expect(t1.block).not.toContain("# cooled:"); // no footer when nothing cooled
		const t2 = await turn();
		expect(t2.block).toBe(""); // both cards cooled
		expect(t2.trace.cooled).toBe(2);
		expect(t2.trace.gated).toBe(false); // all-cooled is NOT a gate miss
		const t3 = await turn();
		expect(t3.block).toBe("");
		expect(t3.trace.cooled).toBe(2);
		const t4 = await turn();
		expect(t4.trace.kept).toBe(2); // window expired, full block again
		expect(t4.trace.cooled).toBe(0);
		expect(t4.block).not.toContain("# cooled:");
	});

	test("cooled top card demotes the runner-up instead of blanking the turn", async () => {
		const ledger = new RecallLedger();
		// Turn 1 serves only card 1; turn 2's retrieval surfaces BOTH cards —
		// card 1 is now cooled, so the runner-up serves as top instead.
		let turn = 1;
		const retrieve = async () =>
			turn++ === 1
				? { count: 1, cards: [fakeCard()] }
				: { count: 2, cards: [fakeCard(), fakeCard({ id: "t2", title: "Second", sharedTags: 2 })] };
		ledger.tick();
		const t1 = await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		expect(t1.block).toContain("Test Card");
		ledger.tick();
		const t2 = await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		expect(t2.block).not.toContain("Test Card");
		expect(t2.block).toContain("Second");
		expect(t2.block).toContain("# cooled: 1");
	});

	test("no_relevant turn records NOTHING — never-served cards stay eligible", async () => {
		const ledger = new RecallLedger();
		let weak = true;
		const retrieve = async () => ({
			count: 1,
			cards: [fakeCard({ sharedTags: weak ? 1 : 2 })], // turn 1: floor miss; turn 2: healthy
		});
		ledger.tick();
		const t1 = await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		expect(t1.trace.gated).toBe(true);
		expect(ledger.cooledCount()).toBe(0); // the poisoning fix, verbatim
		weak = false;
		ledger.tick();
		const t2 = await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		expect(t2.trace.kept).toBe(1);
		expect(t2.block).toContain("Test Card");
	});

	test("budget-dropped cards are NOT recorded — they were never served", async () => {
		const ledger = new RecallLedger();
		// Card 1's line is far over the per-entry cap (2 × 350/2 = 350 tok);
		// card 2 fits. Card 1 must stay eligible for the next turn.
		const retrieve = async () => ({
			count: 2,
			cards: [fakeCard({ detail: "x".repeat(4 * 400) }), fakeCard({ id: "t2", title: "Second" })],
		});
		ledger.tick();
		const t1 = await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		expect(t1.block).not.toContain("Test Card");
		expect(ledger.toJSON()).toEqual({ t2: 3 }); // only the served card
		ledger.tick();
		const t2 = await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		expect(t2.trace.cooled).toBe(1);
		// Card 1 was eligible again — but its line still overflows, so it is
		// dropped by the budget, not by the ledger.
		expect(t2.block).not.toContain("Test Card");
		expect(t2.trace.kept).toBe(0); // card 2 is cooled, card 1 budget-dropped
	});

	test("library purity: the ledger never mutates retrieve call shape", async () => {
		const ledger = new RecallLedger();
		const seen: unknown[] = [];
		const retrieve = async (opts: unknown) => {
			seen.push(JSON.parse(JSON.stringify(opts)));
			return { count: 1, cards: [fakeCard()] };
		};
		ledger.tick();
		await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		ledger.tick();
		await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl", ledger }, ARMED);
		// retrieveRecords sees IDENTICAL options on both turns (no session
		// state leaks into the library — keeps library calls deterministic).
		expect(seen.length).toBe(2);
		expect(seen[0]).toEqual(seen[1]);
	});

	test("no ledger dep = t08 behavior unchanged (no footer)", async () => {
		const retrieve = async () => ({ count: 1, cards: [fakeCard()] });
		const r = await buildAutoRecallBlock(PROMPT, { vaultPath: "/v", retrieve, sessionFile: "/s.jsonl" }, ARMED);
		expect(r.block).not.toContain("# cooled:");
		expect(r.trace.cooled).toBe(0);
	});
});
