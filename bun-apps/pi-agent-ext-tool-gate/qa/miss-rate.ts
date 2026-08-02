/**
 * Miss-rate measurement — QA harness (wayfinder ticket 02).
 *
 * Question: is tool-gate's keyword recall good enough in practice?
 *
 * Method: parse the local TOOL_GATE_LOG_PATH JSONL (turn / miss_candidate /
 * activate events emitted by `emitToolGateLog`), segment into sessions by a
 * ts-gap heuristic (no session-ID exists in the telemetry), and compute the
 * two-lens metric settled in ticket 01:
 *   - escape-rate (headline friction): enable_tool calls vs gated-domain sessions
 *   - confirmed-miss (gate-causation): a miss_candidate turn followed (same
 *     session) by an activate whose matchedGate was dormant at that turn.
 *
 * ⚠ STATUS (audit 2026-07-25) — DIAGNOSTIC / EXPERIMENTAL, NOT a verdict:
 * this module is NOT wired into qa/run.ts (the verdict gates on savings-floor
 * ∧ L1-intended ∧ coverage only). Three known unsoundnesses mean the numbers
 * below must NOT be read as a quality verdict:
 *   1. TAUTOLOGY — the "common" lens uses promptMatchesGateIntent (substring)
 *      which ≠ the real gateFires (word-boundary); a "common" miss measures
 *      matcher divergence, not a real keyword gap, and is forced toward 0.
 *   2. SURVIVORSHIP BIAS — the worst failure (model never calls enable_tool,
 *      gives up silently) emits no activate → invisible + out of the denominator.
 *   3. NEAR-VACUOUS correlation — a confirmed-miss can blame an unrelated turn.
 * Promoting to a real verdict needs an independent "task needed a gated tool"
 * signal (e.g. the L2 live-A/B arm). Until then: exploratory only.
 *
 * Common-intent classification (ticket 04): a confirmed-miss is labelled
 * "common" if its promptHead matches the activated gate's intent — a bare
 * keyword OR the requires noun∧verb co-occurrence (so "generate a video" counts
 * for ltx even without a bare keyword). ⚠ Per STATUS caveat #1, this "common"
 * label is NOT a reliable gap signal (the matcher is tautological). Else
 * "review": neither matched → the keyword
 * may sit beyond the 80-char promptHead truncation, or the model inferred the
 * intent without a recognizable phrasing → flagged for human judgment, NOT
 * forced into the verdict (ticket 05 is HITL).
 *
 * No new instrumentation: reads only existing event fields. If the metric ever
 * needs a field the events lack, this SURFACES the gap (the review list) rather
 * than guessing — per ticket 01's "block, don't invent" hand-off.
 *
 * Run: `bun run qa:miss [--json] <log-file>`  (or set TOOL_GATE_LOG_PATH)
 */
import { CORPUS_GATES } from "./evaluate.ts";
import { readFileSync } from "node:fs";

const DEFAULT_GAP_MS = 30 * 60 * 1000; // 30 min idle → new session
const DEFAULT_PATH = process.env.TOOL_GATE_LOG_PATH ?? "";

// Per-gate intent signature (lowercased): bare keywords + requires noun∧verb.
// Built from CORPUS_GATES (the EFFECTIVE gate set = remaining hardcoded GATES +
// reconstructed owner-declared gates from migrated extensions), so a migrated
// gate like ltx (ticket 07) still resolves here — mirroring l2.ts/evaluate.ts.
const GATE_INTENT = new Map<string, { keywords: string[]; nouns: string[]; verbs: string[] }>();
for (const g of CORPUS_GATES) {
	GATE_INTENT.set(g.names[0], {
		keywords: (g.keywords ?? []).map((k) => k.toLowerCase()),
		nouns: (g.requires?.nouns ?? []).map((n) => n.toLowerCase()),
		verbs: (g.requires?.verbs ?? []).map((v) => v.toLowerCase()),
	});
}

export interface ParsedEvent {
	kind: "turn" | "activate" | "miss_candidate";
	ts: number; // epoch ms
	gatesFired?: string[];
	dormantGates?: string[];
	promptHead?: string;
	matchedGate?: string[] | null;
	activated?: string[];
}

export interface ConfirmedMiss {
	gate: string;
	ts: string;
	promptHead: string;
	/** "common" = promptHead matches the gate's keyword or noun∧verb (high-signal gap);
	 *  "review" = neither (may be 80-char truncation or model-inferred intent). */
	label: "common" | "review";
}

export interface Session {
	index: number;
	start: string;
	end: string;
	gatedDomain: boolean; // has a gate-fired turn OR an activate
	escapes: number; // activate count
	hasEscape: boolean;
	events: ParsedEvent[];
}

export interface MissRateReport {
	file: string;
	totalEvents: number;
	sessions: number;
	gatedDomainSessions: number;
	escapeSessions: number;
	totalEscapes: number;
	/** escapeSessions / gatedDomainSessions * 100 (0 if no gated-domain sessions). */
	escapeSessionPct: number;
	confirmedMisses: ConfirmedMiss[];
	commonMisses: number;
	reviewMisses: number;
	perGate: { gate: string; confirmed: number; common: number }[];
	/** confirmed-misses flagged for human review (truncation / inferred intent). */
	review: ConfirmedMiss[];
}

/** Does `promptHead` express `gate`'s intent — a bare keyword, or the noun∧verb co-occurrence? */
export function promptMatchesGateIntent(promptHead: string | undefined, gate: string): boolean {
	const h = (promptHead ?? "").toLowerCase();
	const I = GATE_INTENT.get(gate);
	if (!I) return false;
	if (I.keywords.some((k) => h.includes(k))) return true;
	if (I.nouns.length && I.verbs.length) {
		const hasNoun = I.nouns.some((n) => h.includes(n));
		const hasVerb = I.verbs.some((v) => h.includes(v));
		if (hasNoun && hasVerb) return true;
	}
	return false;
}

/** Parse one JSONL document into sorted events. Malformed lines are skipped. */
export function parseLog(text: string): ParsedEvent[] {
	const events: ParsedEvent[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(t);
		} catch {
			continue;
		}
		if (!obj || typeof obj !== "object" || typeof obj.kind !== "string" || typeof obj.ts !== "string") continue;
		const ts = Date.parse(obj.ts as string);
		if (Number.isNaN(ts)) continue;
		events.push({
			kind: obj.kind as ParsedEvent["kind"],
			ts,
			gatesFired: obj.gatesFired as string[] | undefined,
			dormantGates: obj.dormantGates as string[] | undefined,
			promptHead: obj.promptHead as string | undefined,
			matchedGate: obj.matchedGate as string[] | null | undefined,
			activated: obj.activated as string[] | undefined,
		});
	}
	return events.sort((a, b) => a.ts - b.ts);
}

function buildSession(index: number, evs: ParsedEvent[]): Session {
	const activates = evs.filter((e) => e.kind === "activate");
	const fired = evs.some((e) => e.kind === "turn" && (e.gatesFired?.length ?? 0) > 0);
	return {
		index,
		start: new Date(evs[0].ts).toISOString(),
		end: new Date(evs[evs.length - 1].ts).toISOString(),
		gatedDomain: fired || activates.length > 0,
		escapes: activates.length,
		hasEscape: activates.length > 0,
		events: evs,
	};
}

/** Segment sorted events into sessions at any idle gap > `gapMs`. */
export function segmentSessions(events: ParsedEvent[], gapMs = DEFAULT_GAP_MS): Session[] {
	if (events.length === 0) return [];
	const sessions: Session[] = [];
	let cur: ParsedEvent[] = [events[0]];
	for (let i = 1; i < events.length; i++) {
		if (events[i].ts - events[i - 1].ts > gapMs) {
			sessions.push(buildSession(sessions.length, cur));
			cur = [];
		}
		cur.push(events[i]);
	}
	sessions.push(buildSession(sessions.length, cur));
	return sessions;
}

/** Compute the full miss-rate report from parsed events. */
export function computeMissRate(events: ParsedEvent[], gapMs = DEFAULT_GAP_MS): MissRateReport {
	const sessions = segmentSessions(events, gapMs);
	const gatedDomainSessions = sessions.filter((s) => s.gatedDomain);
	const escapeSessions = gatedDomainSessions.filter((s) => s.hasEscape).length;
	const totalEscapes = gatedDomainSessions.reduce((s, x) => s + x.escapes, 0);

	const confirmed: ConfirmedMiss[] = [];
	for (const s of sessions) {
		// For each successful activate, find the NEAREST preceding miss_candidate
		// (same session) whose dormant set overlaps the activated gates.
		for (let i = 0; i < s.events.length; i++) {
			const e = s.events[i];
			if (e.kind !== "activate" || !e.matchedGate || e.matchedGate.length === 0) continue;
			for (let j = i - 1; j >= 0; j--) {
				const m = s.events[j];
				if (m.kind !== "miss_candidate") continue;
				const dormant = new Set(m.dormantGates ?? []);
				const hit = e.matchedGate.filter((g) => dormant.has(g));
				if (hit.length === 0) continue;
				for (const gate of hit) {
					confirmed.push({
						gate,
						ts: new Date(e.ts).toISOString(),
						promptHead: m.promptHead ?? "",
						label: promptMatchesGateIntent(m.promptHead, gate) ? "common" : "review",
					});
				}
				break; // nearest preceding miss_candidate with an overlap
			}
		}
	}

	const perGateMap = new Map<string, { confirmed: number; common: number }>();
	for (const c of confirmed) {
		const entry = perGateMap.get(c.gate) ?? { confirmed: 0, common: 0 };
		entry.confirmed++;
		if (c.label === "common") entry.common++;
		perGateMap.set(c.gate, entry);
	}

	return {
		file: "",
		totalEvents: events.length,
		sessions: sessions.length,
		gatedDomainSessions: gatedDomainSessions.length,
		escapeSessions,
		totalEscapes,
		escapeSessionPct: gatedDomainSessions.length
			? Number(((escapeSessions / gatedDomainSessions.length) * 100).toFixed(1))
			: 0,
		confirmedMisses: confirmed,
		commonMisses: confirmed.filter((c) => c.label === "common").length,
		reviewMisses: confirmed.filter((c) => c.label === "review").length,
		perGate: [...perGateMap.entries()]
			.map(([gate, v]) => ({ gate, ...v }))
			.sort((a, b) => b.confirmed - a.confirmed),
		review: confirmed.filter((c) => c.label === "review"),
	};
}

/** Human-readable report. */
export function formatMissRate(r: MissRateReport): string[] {
	const lines: string[] = [
		`file:            ${r.file || "(stdin)"}`,
		`events:          ${r.totalEvents}`,
		`sessions:        ${r.sessions}  (gated-domain: ${r.gatedDomainSessions})`,
		``,
		`escape-rate (headline friction):`,
		`  ${r.escapeSessions}/${r.gatedDomainSessions} gated-domain sessions forced the escape hatch (${r.escapeSessionPct}%) — ${r.totalEscapes} total enable_tool calls.`,
		``,
		`confirmed-miss (gate-causation — DIAGNOSTIC, not in the qa verdict):`,
		`  ${r.confirmedMisses.length} confirmed  (common: ${r.commonMisses}, review: ${r.reviewMisses})`,
		`  diagnostic signal (NOT a verdict — see module STATUS; "common" is tautological): zero COMMON → ${r.commonMisses === 0 ? "✅ none (so far)" : `❌ ${r.commonMisses} common (tautological — investigate before acting)`}`,
	];
	if (r.perGate.length) {
		lines.push(``, `per gate:`);
		for (const g of r.perGate) lines.push(`  ${g.gate}: ${g.confirmed} confirmed (${g.common} common)`);
	}
	if (r.commonMisses > 0) {
		lines.push(``, `❌ common confirmed-misses (real keyword/co-occurrence gaps):`);
		for (const c of r.confirmedMisses.filter((x) => x.label === "common")) lines.push(`  [${c.gate}] ${c.ts}  "${c.promptHead}"`);
	}
	if (r.review.length) {
		lines.push(``, `⚠ review (no recognizable intent in 80ch — may be truncation; human calls these at ticket 05):`);
		for (const c of r.review) lines.push(`  [${c.gate}] ${c.ts}  "${c.promptHead}"`);
	}
	return lines;
}

async function main() {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const file = args.find((a) => !a.startsWith("-")) ?? DEFAULT_PATH;
	if (!file) {
		console.error("usage: bun run qa:miss [--json] <log-file>  (or set TOOL_GATE_LOG_PATH)");
		process.exit(1);
	}
	const events = parseLog(readFileSync(file, "utf8"));
	const report = computeMissRate(events);
	report.file = file;
	if (json) console.log(JSON.stringify(report, null, 2));
	else console.log(formatMissRate(report).join("\n"));
}

if (import.meta.main) void main();
