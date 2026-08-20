/**
 * L2 task suite (wayfinder ticket 04) — curated, task-level prompts whose
 * natural solution is a gated tool. Each task is run with tool-gate ON vs OFF;
 * the reachability evaluator (qa/l2.ts) decides deterministically whether the
 * intended tool is even REACHABLE under ON (gate fires OR enable_tool intent
 * reaches it), vs OFF (always reachable).
 *
 * Tasks are deliberately mixed:
 *   - REACHABLE   keyword-obvious → gate fires under ON (live run then asks:
 *                 did the agent actually USE it?)
 *   - GAP         keyword-absent → gate does NOT fire AND intent-mode can't
 *                 reach it → a CONFIRMED capability regression (no LLM needed:
 *                 the agent can only get the tool via a proactive name-mode
 *                 enable_tool call). These are the task-breaking cases.
 *   - MISROUTE    intent reaches the WRONG gate (e.g. movie's "orchestrate…"
 *                 routes to workflow).
 *
 * `expectReachable` is the suite author's prediction; the evaluator checks it.
 */
export interface L2Task {
	id: string;
	prompt: string;
	/** Intended gate identity = GATES[].names[0]. */
	intendedGate: string;
	/** Author prediction: should the tool be reachable under ON? */
	expectReachable: boolean;
	note?: string;
}

export const L2_TASKS: L2Task[] = [
	// ── REACHABLE (gate fires on the task prompt) ──
	{ id: "flux2-t2i", prompt: "generate an image of a sunset over the ocean", intendedGate: "flux2", expectReachable: true, note: "noun image ∧ verb generate" },
	{ id: "ltx-t2v", prompt: "make a 5-second video of waves crashing", intendedGate: "ltx", expectReachable: true, note: "noun video ∧ verb make" },
	{ id: "file2md-ocr", prompt: "ocr this scanned pdf and extract the text", intendedGate: "file2md", expectReachable: true, note: "keyword ocr (+ noun pdf ∧ verb extract)" },
	{ id: "movie-make", prompt: "make a movie from these three clips", intendedGate: "movie", expectReachable: true, note: 'keyword "make a movie"' },
	{ id: "research-bili", prompt: "collect the trending bilibili AI videos from today", intendedGate: "collect_videos", expectReachable: true, note: "keyword bilibili / collect videos" },
	{ id: "workflow-fanout", prompt: "orchestrate a fan-out of parallel sub-agents to review these files", intendedGate: "run_workflow", expectReachable: true, note: "keyword orchestrate / parallel agent" },

	// ── REACHABLE after the fix (were gaps; keywords added) ──
	{ id: "krea-realtime", prompt: "turn this rough sketch into an image in real time", intendedGate: "krea2", expectReachable: true, note: "FIXED — keyword sketch/real time closes the blind gap" },
	{ id: "zai-reader", prompt: "read this webpage with Z.ai's reader endpoint", intendedGate: "zai_web_search_web_search_prime", expectReachable: true, note: "FIXED — keyword z.ai closes the blind gap" },

	// ── REACHABLE after the fix (was a misroute) ──
	{ id: "movie-film", prompt: "orchestrate these scenes into a short film", intendedGate: "movie", expectReachable: true, note: "FIXED — short film/scenes into; movie now wins over workflow" },
];
