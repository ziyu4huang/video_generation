import { test, expect, describe } from "bun:test";
import { runWorkflowScript } from "@repo/pi-agent-ext-workflow";

/**
 * retrieval-quality-self-improve — harness-contract tests.
 *
 * The workflow runs in the engine vm with real LLM agents in production, but
 * its RANKING CONTRACT (which verdicts count toward the mean/win tally) is pure
 * logic over the structured results those agents return. These tests drive the
 * script headlessly via runWorkflowScript with a dispatching stub agent and
 * assert the three harness fixes from the F-receipt triage:
 *
 *   A1 — an empty-retrieval EXECUTION failure (blend lane surfaced 0 cards) is
 *        excluded from the mean + win tally with a logged reason, NOT scored
 *        as blendRel=0 (the contamination that produced the fake negative).
 *   A2 — query generation is gated on every query carrying a concrete
 *        lexicalMissReason + the lexical-overlap gate (workflows/lib/
 *        lexical-overlap-check.mjs) rejecting keyword-overlapping queries.
 *   A3 — a semanticLive:false verdict (blend competed without its advantage,
 *        incl. a semantic tool that ended (err)) is excluded with a reason,
 *        not scored as a ranking defeat.
 *
 * Together: every verdict is EITHER a clean ranking comparison OR a
 * logged-and-excluded execution/coverage failure. No unread signal.
 */

// Three adversarial queries with concrete lexicalMissReasons + expectedConcepts.
const QUERIES = [
	{
		id: 1,
		text: "How to tell if a user gave a specific value or I'm using the pre-set value?",
		lexicalMissReason:
			"avoids the terms argparse, sentinel, default=None, override — uses 'pre-set value' instead",
		expectedConcept: "auto-memory:argparse-sentinel-for-user-override",
	},
	{
		id: 2,
		text: "My UI isn't reflecting code changes during development — what's wrong with the refresh?",
		lexicalMissReason:
			"avoids Bun, GUI, hot-reload, dev-server — uses 'UI', 'refresh' instead",
		expectedConcept: "auto-memory:bun-gui-dev-hot-reload",
	},
	{
		id: 3,
		text: "The system wrongly flags silence as background static — how to reduce these mistakes?",
		lexicalMissReason:
			"avoids audio, noise-detection, false-positive — uses 'silence', 'background static' instead",
		expectedConcept: "auto-memory:audio-noise-detection-false-positive",
	},
];

/**
 * Dispatching stub: returns a schema-conformant result based on options.label.
 * Query 1 (idx 0) → execution failure (blend lane surfaced 0 cards).
 * Query 2 (idx 1) → semantic stage non-live (coverage gap).
 * Query 3 (idx 2) → clean ranking comparison (judge decides).
 *
 * The overlap-check agent (A2) returns clean:true so the gate passes without
 * invoking the real lexical-overlap-check.mjs script.
 */
function makeStubAgent() {
	return {
		run: async (prompt: string, options: { label?: string } = {}) => {
			const label = options.label ?? "";
			switch (label) {
				case "resolve-root":
					return { root: "/Users/huangziyu/proj/video_generation__pi" };
				case "timestamp":
					return { timestamp: "2026-07-06T00-00-00" };
				case "gen-queries":
					return { queries: QUERIES };
				case "overlap-check":
					// A2 lexical-overlap gate: report clean so the gate passes.
					return { clean: true, overlaps: [], cardTermCount: 42 };
				case "retrieve-1":
					// A1 — execution failure: blend lane surfaced 0 cards.
					return {
						lexicalFile: "/tmp/rq-test-0-modeA.txt",
						blendFile: "/tmp/rq-test-0-modeB.txt",
						semanticLive: true,
						semanticCalled: true,
						semanticErr: false,
						fallbackLine: "",
						lexicalBytes: 4200,
						blendBytes: 1800,
						aCardRefs: 8,
						bCardRefs: 0,
						executionFailed: true,
						failureReason: "blend lane surfaced 0 cards (empty seed / no note exceeded threshold)",
					};
				case "retrieve-2":
					// A3 — semantic stage went non-live (coverage gap).
					return {
						lexicalFile: "/tmp/rq-test-1-modeA.txt",
						blendFile: "/tmp/rq-test-1-modeB.txt",
						semanticLive: false,
						semanticCalled: false,
						semanticErr: false,
						fallbackLine: "",
						lexicalBytes: 4000,
						blendBytes: 3900,
						aCardRefs: 8,
						bCardRefs: 8,
						executionFailed: false,
						failureReason: "",
					};
				case "retrieve-3":
					// Clean retrieval — both lanes surfaced cards; judge decides.
					return {
						lexicalFile: "/tmp/rq-test-2-modeA.txt",
						blendFile: "/tmp/rq-test-2-modeB.txt",
						semanticLive: true,
						semanticCalled: true,
						semanticErr: false,
						fallbackLine: "",
						lexicalBytes: 5000,
						blendBytes: 5200,
						aCardRefs: 8,
						bCardRefs: 8,
						executionFailed: false,
						failureReason: "",
					};
				case "judge-3":
					// idx 2 → lexicalIsA = true → A=modeA(lexical), B=modeB(blend). Blend wins.
					return { winner: "B", relevanceA: 0.25, relevanceB: 0.75, reason: "blend surfaced the right card" };
				case "persist-history":
					return { written: true, bytes: 1234 };
				default:
					if (label.startsWith("judge-")) {
						throw new Error(`stub: judge should not be called for excluded verdict (${label})`);
					}
					return { ok: true };
			}
		},
		// The real WorkflowAgent.run is a generic method (schema-typed return);
		// this stub always returns the same discriminated-union shape regardless
		// of TSchemaDef, so it can't structurally satisfy the generic signature —
		// cast to match `Pick<WorkflowAgent, "run">` (see RunWorkflowScriptOptions.agent).
	} as any;
}

describe("retrieval-quality-self-improve — harness contract", () => {
	test("A1+A3: execution-failed and non-live verdicts excluded from mean/win; clean verdict ranked", async () => {
		const receipt = await runWorkflowScript({
			name: "retrieval-quality-self-improve",
			args: { queryCount: 3 },
			agent: makeStubAgent(),
			persistLogs: false,
		});

		const result = receipt.result as Record<string, unknown>;
		expect(result).toBeTruthy();
		expect(result.queryCount).toBe(3);
		expect(result.rankedCount).toBe(1);
		expect(result.excludedCount).toBe(2);
		expect(result.blendWins).toBe(1);
		expect(result.lexicalWins).toBe(0);
		// Mean over the RANKED set only — blend 0.75 vs lexical 0.25.
		expect(result.meanBlendRelevance).toBeCloseTo(0.75, 5);
		expect(result.meanLexicalRelevance).toBeCloseTo(0.25, 5);
		expect(result.blendBetterOverall).toBe(true);

		const exclusions = result.exclusions as Array<{ id: number; reason: string }>;
		expect(exclusions).toHaveLength(2);
		expect(exclusions.some((e) => e.reason.startsWith("execution_failed:"))).toBe(true);
		expect(exclusions.some((e) => e.reason.startsWith("non_live:"))).toBe(true);

		const verdicts = result.verdicts as Array<Record<string, unknown>>;
		expect(verdicts).toHaveLength(3);
		const byId = new Map(verdicts.map((v) => [v.id as number, v]));
		expect(byId.get(1)!.execution_failed).toBe(true);
		expect(byId.get(1)!.excluded).toBe(true);
		expect(byId.get(2)!.excluded).toBe(true);
		expect(byId.get(3)!.excluded).toBe(false);
		// Excluded verdicts have null relevance (not the contaminated 0).
		expect(byId.get(1)!.blendRelevance).toBeNull();
		expect(byId.get(2)!.blendRelevance).toBeNull();
	}, 30_000);

	test("A3: semantic tool that ended (err) is treated as non-live and excluded", async () => {
		// Variant: query 2's semantic stage RAN but ended (err) — the prior
		// semanticLive grep missed this, classifying it as live-with-no-content
		// (the empty-retrieval root cause). The stub enforces semanticLive=false
		// for this case; the harness must exclude it regardless.
		const stub = makeStubAgent();
		const orig = stub.run;
		stub.run = async (prompt: string, options: { label?: string }) => {
			if (options.label === "retrieve-2") {
				return {
					lexicalFile: "/tmp/rq-t-1-modeA.txt", blendFile: "/tmp/rq-t-1-modeB.txt",
					semanticLive: false, semanticCalled: true, semanticErr: true,
					fallbackLine: "[tool done] obsidian_semantic_search (err)",
					lexicalBytes: 4000, blendBytes: 3900, aCardRefs: 8, bCardRefs: 8,
					executionFailed: false, failureReason: "",
				};
			}
			return orig.call(stub, prompt, options);
		};
		const receipt = await runWorkflowScript({
			name: "retrieval-quality-self-improve",
			args: { queryCount: 3 },
			agent: stub,
			persistLogs: false,
		});
		const result = receipt.result as Record<string, unknown>;
		expect(result.excludedCount).toBe(2);
		const exclusions = result.exclusions as Array<{ reason: string }>;
		expect(exclusions.some((e) => e.reason.startsWith("non_live:") && e.reason.includes("(err)"))).toBe(true);
	}, 30_000);
});
