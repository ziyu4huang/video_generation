/**
 * Miss-rate A/B for #5's newly-gated core-task tools (ask_user_question, todo).
 *
 * The go/no-go evidence leg: "is keyword-gating these two tools worth it?" The
 * savings side (≈12k tok/turn when dormant) is settled; this answers the recall
 * side — for realistic + ADVERSARIAL "the agent NEEDS this tool" prompts, does
 * each tool's keyword gate FIRE? If recall is too low, the gate starves the
 * agent of a tool it wanted (real friction); if precision drops to fix it, the
 * gate false-fires and the savings evaporate.
 *
 * METHOD — reuse the REAL gate machinery, never reimplement matching:
 *   - CORPUS_GATES   (qa/evaluate.ts) — the effective gate set built by the SAME
 *     production `buildEffectiveGates` the extension runs at session_start,
 *     driven from the owner-declared `gating` keywords in
 *       pi-agent-ext-core-task/src/ask-user/ask-user-question.ts
 *       pi-agent-ext-core-task/src/todo/todo.ts
 *     So a keyword edit in those source files is reflected here on re-run (the
 *     gates are rebuilt at import time).
 *   - gateFires      (extensions/tool-gate.ts) — the pure per-gate fire test the
 *     runtime calls every turn (word-boundary for single ASCII tokens, substring
 *     for phrases/CJK, + optional requires noun∧verb co-occurrence). Identical to
 *     what evaluateCorpus()'s MUST_FIRE/MUST_NOT_FIRE cases assert.
 *
 * Each probe is labelled FIRE (gate fires) or MISS (gate dormant → agent would
 * need the escape hatch, enable_tool, to get the tool). Controls are prompts
 * that carry a current keyword and MUST fire (a regression here means the
 * keyword set, not the probe, is the bug).
 *
 * Run: `bun run qa:miss-ab`  (or `bun run qa/miss-rate-ab.ts`)
 */
import { CORPUS_GATES } from "./evaluate.ts";
import { gateFires } from "../extensions/tool-gate.ts";

interface Probe {
	prompt: string;
	/** true = a control that carries a current keyword and MUST fire. */
	control?: boolean;
	note?: string;
}

const ASK_USER_QUESTION_PROBES: Probe[] = [
	// ── adversarial: NEED the tool, varied vocabulary → designed to miss ──
	{ prompt: "I need more information from the user before proceeding", note: "info-gather phrasing, no keyword" },
	{ prompt: "let me check with the user about their priorities", note: "requirement-gather, 'priorities' ≠ keyword" },
	{ prompt: "help me understand what they want here", note: "clarify-intent, no keyword" },
	{ prompt: "pause and get the requirements nailed down", note: "'requirements' ≠ keyword" },
	{ prompt: "poll the user for their taste", note: "'poll'/'taste' ≠ keyword" },
	{ prompt: "I should get their input on this", note: "'input' ≠ keyword" },
	{ prompt: "find out which way they want to go", note: "direction-gather, no keyword" },
	{ prompt: "what's their take on this tradeoff", note: "'take'/'tradeoff' ≠ keyword" },
	{ prompt: "loop in the user on the direction", note: "no keyword" },
	// ── controls: carry a current keyword → MUST fire ──
	{ prompt: "ask the user a clarifying question", control: true, note: "keyword ask / clarifying / question" },
	{ prompt: "which option do you prefer to pursue", control: true, note: "keyword option" },
	{ prompt: "resolve the ambiguity in scope before starting", control: true, note: "keyword ambiguity" },
];

const TODO_PROBES: Probe[] = [
	// ── adversarial: NEED the tool, varied vocabulary → designed to miss ──
	{ prompt: "let me jot down what's left to do", note: "'jot'/'do' ≠ keyword ('do' would be over-broad)" },
	{ prompt: "I'll keep a list of the remaining work", note: "'list'/'work' ≠ keyword" },
	{ prompt: "break this into chunks and work through them", note: "'chunks' ≠ keyword" },
	{ prompt: "organize the agenda for this effort", note: "'agenda' ≠ keyword" },
	{ prompt: "mark this one finished", note: "'finished' ≠ done/complete" },
	{ prompt: "knock out the outstanding items one by one", note: "'outstanding'/'items' ≠ keyword" },
	{ prompt: "capture the open work and clear it", note: "generic work words, no keyword" },
	// ── controls: carry a current keyword → MUST fire ──
	{ prompt: "update the checklist", control: true, note: "keyword checklist" },
	{ prompt: "track these steps", control: true, note: "keyword track / steps" },
	{ prompt: "add a task to the plan", control: true, note: "keyword task / plan" },
];

const TOOL_KEY: Record<"ask_user_question" | "todo", Probe[]> = {
	ask_user_question: ASK_USER_QUESTION_PROBES,
	todo: TODO_PROBES,
};

interface ToolResult {
	tool: keyof typeof TOOL_KEY;
	fired: number;
	total: number;
	controlsTotal: number;
	controlsFired: number;
	misses: { prompt: string; note?: string }[];
	controlFailures: { prompt: string; note?: string }[];
}

function findGate(id: string) {
	const g = CORPUS_GATES.find((x) => x.names[0] === id);
	if (!g) throw new Error(`probe references unknown gate '${id}' — is the tool still keyword-gated (not core:true)?`);
	return g;
}

function evaluateTool(tool: keyof typeof TOOL_KEY): ToolResult {
	const gate = findGate(tool);
	const probes = TOOL_KEY[tool];
	let fired = 0;
	let controlsTotal = 0;
	let controlsFired = 0;
	const misses: ToolResult["misses"] = [];
	const controlFailures: ToolResult["controlFailures"] = [];
	for (const p of probes) {
		const fires = gateFires(gate, p.prompt.toLowerCase());
		if (p.control) {
			controlsTotal++;
			if (fires) controlsFired++;
			else controlFailures.push({ prompt: p.prompt, note: p.note });
		} else {
			if (fires) fired++;
			else misses.push({ prompt: p.prompt, note: p.note });
		}
	}
	// fired = adversarial probes that fired (recall); controls counted separately
	return {
		tool,
		fired,
		total: probes.filter((p) => !p.control).length,
		controlsTotal,
		controlsFired,
		misses,
		controlFailures,
	};
}

function pct(n: number, d: number): string {
	if (d === 0) return "n/a";
	return ((n / d) * 100).toFixed(1) + "%";
}

function renderTool(r: ToolResult, keywords: string[]): string[] {
	const lines: string[] = [];
	lines.push(``);
	lines.push(`▼ ${r.tool}`);
	lines.push(`  keywords: [${keywords.join(", ")}]`);
	lines.push(`  recall: ${r.fired}/${r.total} adversarial probes fired (${pct(r.fired, r.total)})`);
	lines.push(`  controls: ${r.controlsFired}/${r.controlsTotal} fired (must be 100%)`);
	for (const p of TOOL_KEY[r.tool]) {
		const gate = findGate(r.tool);
		const fires = gateFires(gate, p.prompt.toLowerCase());
		const tag = fires ? "FIRE" : "miss";
		const ctrl = p.control ? " [control]" : "";
		lines.push(`  [${tag}]${ctrl} "${p.prompt}"${p.note ? `  — ${p.note}` : ""}`);
	}
	return lines;
}

function main() {
	const ask = evaluateTool("ask_user_question");
	const todo = evaluateTool("todo");

	// Overall miss-rate over the ADVERSARIAL probes only (controls are
	// correctness checks, not misses — a control that doesn't fire is a bug,
	// counted in controlFailures, not in the miss-rate).
	const advFired = ask.fired + todo.fired;
	const advTotal = ask.total + todo.total;
	const missRatePct = pct(advTotal - advFired, advTotal);

	const askGate = findGate("ask_user_question");
	const todoGate = findGate("todo");

	const lines: string[] = [];
	lines.push("══════════════════════════════════════════════════════════════════════");
	lines.push(" Miss-rate A/B — #5 gated core-task tools (ask_user_question, todo)");
	lines.push("══════════════════════════════════════════════════════════════════════");
	lines.push(" Machinery: REAL gateFires (extensions/tool-gate.ts) + REAL effective");
	lines.push(" gate set (qa/evaluate.ts CORPUS_GATES, built by production");
	lines.push(" buildEffectiveGates from the tools' owner-declared `gating`).");
	lines.push(" No reimplementation of keyword matching.");
	lines.push(...renderTool(ask, askGate.keywords));
	lines.push(...renderTool(todo, todoGate.keywords));

	lines.push(``);
	lines.push(`──────────────────────────────────────────────────────────────────────`);
	lines.push(` SUMMARY`);
	lines.push(`──────────────────────────────────────────────────────────────────────`);
	lines.push(` ask_user_question: recall ${ask.fired}/${ask.total}  (${pct(ask.fired, ask.total)})  — ${ask.misses.length} adversarial misses`);
	lines.push(` todo:              recall ${todo.fired}/${todo.total}  (${pct(todo.fired, todo.total)})  — ${todo.misses.length} adversarial misses`);
	lines.push(` OVERALL (adversarial): fired ${advFired}/${advTotal}  →  miss-rate ${missRatePct}`);
	lines.push(` controls: ask_user_question ${ask.controlsFired}/${ask.controlsTotal}, todo ${todo.controlsFired}/${todo.controlsTotal}`);
	if (ask.controlFailures.length || todo.controlFailures.length) {
		lines.push(` ⚠ CONTROL FAILURE (keyword regression — the keyword set is the bug):`);
		for (const c of [...ask.controlFailures, ...todo.controlFailures]) lines.push(`     "${c.prompt}"`);
	}
	lines.push(``);
	lines.push(`──────────────────────────────────────────────────────────────────────`);
	lines.push(` A/B FRAMING`);
	lines.push(`──────────────────────────────────────────────────────────────────────`);
	lines.push(` with-gate (#5 as merged): miss-rate ${missRatePct} on adversarial "I need this`);
	lines.push(`   tool" prompts, but the two tools stay dormant and save ≈12k tok/turn.`);
	lines.push(` no-gate (revert to core:true): 0% miss, +≈12k tok/turn (always active).`);
	lines.push(``);
	lines.push(` Interpretation: miss-rate is the recall cost; ≈12k tok/turn is the`);
	lines.push(` precision/savings benefit. The escape hatch (enable_tool {name/intent})`);
	lines.push(` recovers any single miss deterministically — so a miss costs a tool-call,`);
	lines.push(` not a failure.`);

	console.log(lines.join("\n"));
}

if (import.meta.main) main();
