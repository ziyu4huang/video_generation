import { createHash } from "crypto";

export const REPETITION = {
	similarityThreshold: 0.8, minExactLength: 80, minSimilarLength: 60, windowRepeat: 3,
	printWindow: 12, textWindow: 3, toolWindow: 6, toolResultRepeat: 3, toollessIterations: 2,
	degenerateMinLength: 150, degenerateSentenceRepeats: 4, degenerateWordRepeats: 16,
	degeneratePhraseRepeats: 8, degenerateMaxPhraseWords: 4, hardResetAfter: 3, maxInterventions: 5,
} as const;

export function normalizeForPrint(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export function textFingerprint(text: string): string {
	return createHash("sha256").update(normalizeForPrint(text).slice(0, 4000)).digest("hex").slice(0, 16);
}
function canonical(text: string): string { return normalizeForPrint(text).replace(/\d+/g, "#"); }
function wordTrigrams(text: string): Set<string> {
	const words = canonical(text).split(" ").filter(Boolean);
	const out = new Set<string>();
	if (words.length < 3) { if (words.length) out.add(words.join(" ")); return out; }
	for (let i = 0; i + 3 <= words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	return out;
}
export function trigramSimilarity(a: string, b: string): number {
	const sa = wordTrigrams(a), sb = wordTrigrams(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	let shared = 0; for (const t of sa) if (sb.has(t)) shared++;
	return shared / (sa.size + sb.size - shared);
}
export interface DegenerateRepeat { kind: "sentence" | "word" | "phrase"; unit: string; count: number; }
function tokenRun(text: string): DegenerateRepeat | undefined {
	const tokens = normalizeForPrint(text).match(/[\p{L}\p{N}_'-]+/gu) ?? [];
	for (let width = 1; width <= REPETITION.degenerateMaxPhraseWords; width++) {
		const needed = width === 1 ? REPETITION.degenerateWordRepeats : REPETITION.degeneratePhraseRepeats;
		for (let start = 0; start + width * needed <= tokens.length; start++) {
			let run = 1;
			while (start + (run + 1) * width <= tokens.length &&
				tokens.slice(start, start + width).join("") === tokens.slice(start + run * width, start + (run + 1) * width).join("")) run++;
			if (run >= needed) return { kind: width === 1 ? "word" : "phrase", unit: tokens.slice(start, start + width).join(" "), count: run };
		}
	}
	return undefined;
}
export function findDegenerateRepeat(text: string): DegenerateRepeat | undefined {
	const canon = canonical(text);
	if (canon.length < REPETITION.degenerateMinLength) return undefined;
	const sentences = canon.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 15);
	if (sentences.length >= REPETITION.degenerateSentenceRepeats) {
		const counts = new Map<string, number>();
		for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
		let unit = "", best = 0;
		for (const [s, n] of counts) if (n > best) { unit = s; best = n; }
		if (best >= REPETITION.degenerateSentenceRepeats && best / sentences.length >= 0.5) return { kind: "sentence", unit, count: best };
	}
	return tokenRun(text);
}
export interface ToolResultPrint { tool: string; hash: string; isError: boolean; }
export interface LoopStuckInput {
	assistantText: string; recentPrints: string[]; previousText?: string;
	recentToolResults: ToolResultPrint[]; toollessStreak: number;
}
function clip(text: string, n: number): string { const f = text.replace(/\s+/g, " ").trim(); return f.length <= n ? f : `${f.slice(0, n)}…`; }
export function detectLoopStuck(input: LoopStuckInput): string | undefined {
	const { assistantText, recentPrints, previousText, recentToolResults, toollessStreak } = input;
	if (toollessStreak >= REPETITION.toollessIterations) return `no tool calls for ${toollessStreak} iterations (narration only)`;
	const degenerate = findDegenerateRepeat(assistantText);
	if (degenerate) return `response degenerated: same ${degenerate.kind} repeated ${degenerate.count}× ("${clip(degenerate.unit, 60)}")`;
	const lastTwo = recentPrints.slice(-2);
	if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1] && normalizeForPrint(assistantText).length > REPETITION.minExactLength) return "repeated the previous response exactly";
	if (previousText && normalizeForPrint(assistantText).length > REPETITION.minSimilarLength) {
		const sim = trigramSimilarity(assistantText, previousText);
		if (sim >= REPETITION.similarityThreshold) return `response ~${Math.round(sim * 100)}% similar to the previous iteration`;
	}
	const current = recentPrints[recentPrints.length - 1];
	if (current && recentPrints.filter((p) => p === current).length >= REPETITION.windowRepeat) return `same response ${REPETITION.windowRepeat}+ times in recent iterations`;
	const recentTools = recentToolResults.slice(-REPETITION.toolResultRepeat);
	if (recentTools.length === REPETITION.toolResultRepeat && recentTools.every((r) => r.tool === recentTools[0]!.tool && r.hash === recentTools[0]!.hash))
		return recentTools.every((r) => r.isError) ? `same ${recentTools[0]!.tool} error ${REPETITION.toolResultRepeat}× in a row` : `same ${recentTools[0]!.tool} result ${REPETITION.toolResultRepeat}× in a row (no new information)`;
	return undefined;
}
export function loopInterventionDirective(consecutiveStuck: number, reason: string, recentTexts: string[]): string {
	const strategies = [
		"Abandon the current angle entirely. Pick a genuinely different approach — different file, different technique — and execute it now.",
		"Switch to a part of the target you have NOT touched in recent iterations and make one concrete, inspectable change there.",
		"Write a short PROGRESS.md: current state, what was tried, what keeps failing, the next 3 concrete steps. Then execute step 1.",
		"Run the project's build/tests, pick exactly ONE failure or warning, and fix only that.",
		"Review your recent changes (git diff / git log), find one real problem in them, and fix it.",
	];
	const strategy = strategies[(consecutiveStuck - 1) % strategies.length]!;
	let escalation = "";
	if (consecutiveStuck >= REPETITION.hardResetAfter) {
		const banned = recentTexts.map((t) => clip(normalizeForPrint(t), 40)).filter(Boolean).map((t) => `"${t}"`).join(", ");
		escalation = ` HARD RESET (stuck intervention #${consecutiveStuck} in a row): forget your previous phrasing entirely.` +
			(banned ? ` Banned openings: ${banned}.` : "") +
			" Your FIRST action this turn must be a tool call that changes a file or produces new information — zero preamble text before it.";
	}
	return `⚠ STUCK — ${reason}.${escalation} ${strategy}`;
}
export function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
	const next = [...arr, item];
	return next.length > cap ? next.slice(next.length - cap) : next;
}
