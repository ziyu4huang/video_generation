/**
 * bench/core — pure bench-agent primitives: config matrix, metrics extraction
 * from session messages, report rendering. NO session/LLM side effects here
 * (the command module owns those) so everything in this file is unit-testable.
 */
export interface BenchConfig { id: string; model: string; thinking: string }

export const DEFAULT_CONFIGS: BenchConfig[] = [
	{ id: "5.3-high", model: "zai/glm-5.3", thinking: "high" },
	{ id: "5.3-medium", model: "zai/glm-5.3", thinking: "medium" },
	{ id: "5.3-low", model: "zai/glm-5.3", thinking: "low" },
	{ id: "5.3-highspeed", model: "zai/glm-5.3-highspeed", thinking: "high" },
	{ id: "5.3-flash", model: "zai/glm-5.3-flash", thinking: "medium" },
];

export interface MetricsMessage {
	role: string;
	content?: { type: string; text?: string }[];
	usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
	/** Present on real AgentMessages but NOT trustworthy as a duration source:
	 *  pi-ai stamps AssistantMessage.timestamp at STREAM CREATION (before the
	 *  fetch), so timestamp deltas measure call-initiation gap, not generation.
	 *  Per-turn durations must be measured from message_end event ARRIVALS
	 *  (wall clock at the listener) and passed in as turnDurationsMs. */
	timestamp?: number;
	/** The SDK's StreamFn encodes request/model failures (429, 5xx, bad request)
	 *  as a RESOLVED final assistant message with stopReason "error" +
	 *  errorMessage — never as a promise rejection. So a failed call still
	 *  yields ok:true from prompt(); these two fields are how callers detect it. */
	stopReason?: string;
	errorMessage?: string;
}

export interface RunMetrics {
	wallMs: number; turns: number;
	inputTokens: number; outputTokens: number; reasoningTokens: number;
	cacheReadTokens: number; cacheWriteTokens: number;
	medianTurnMs: number; p90TurnMs: number; tokensPerSec: number;
	reasoningRatio: number; cacheHitRatio: number;
}

export interface QualityResult { pass: boolean; detail: string }
export interface CellResult {
	configId: string; taskId: string; ok: boolean; error?: string;
	metrics: RunMetrics | null; quality: QualityResult | null;
}

// median averages the two middle values for even counts; p90 is the standard
// linearly-interpolated quantile (numpy default) — the plan's hand-computed
// fixtures pin median 9000 / p90 9800 for the 2-element case [8000, 10000].
function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function p90(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const idx = (s.length - 1) * 0.9;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}

/** Metrics from session messages + event-arrival durations.
 *
 *  Token sums, turns, reasoningRatio and cacheHitRatio come from `messages`.
 *  `turnDurationsMs` MUST come from message_end event arrivals (wall clock at
 *  the subscriber), never from message timestamps (stream-start stamped —
 *  see MetricsMessage.timestamp). Empty array → medianTurnMs/p90TurnMs/
 *  tokensPerSec are all 0; there is deliberately NO timestamp fallback. */
export function extractMetrics(
	messages: MetricsMessage[],
	wallMs: number,
	turnDurationsMs: number[],
): RunMetrics {
	let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0;
	let turns = 0;
	for (const m of messages) {
		if (m.role === "assistant" && m.usage) {
			turns += 1;
			input += m.usage.input ?? 0;
			output += m.usage.output ?? 0;
			reasoning += m.usage.reasoning ?? 0;
			cacheRead += m.usage.cacheRead ?? 0;
			cacheWrite += m.usage.cacheWrite ?? 0;
		}
	}
	const genSec = turnDurationsMs.reduce((a, b) => a + b, 0) / 1000;
	const denom = cacheRead + input + cacheWrite;
	return {
		wallMs, turns,
		inputTokens: input, outputTokens: output, reasoningTokens: reasoning,
		cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
		medianTurnMs: median(turnDurationsMs), p90TurnMs: p90(turnDurationsMs),
		tokensPerSec: genSec > 0 ? output / genSec : 0,
		reasoningRatio: output > 0 ? reasoning / output : 0,
		cacheHitRatio: denom > 0 ? cacheRead / denom : 0,
	};
}

export function finalAssistantText(messages: MetricsMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && Array.isArray(m.content)) {
			return m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
		}
	}
	return "";
}

/** Scan from the end for an assistant message carrying an API error
 *  (stopReason "error" and/or errorMessage — see MetricsMessage). Returns the
 *  errorMessage (or the bare stopReason when no message text), else null. */
export function lastApiError(messages: MetricsMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && (m.errorMessage || m.stopReason === "error")) {
			return m.errorMessage || m.stopReason || null;
		}
	}
	return null;
}

// Escape pipes for markdown table cells — checkEdit failure details join
// stderr lines with " | ", which would otherwise split the row.
function esc(s: string): string {
	return s.replaceAll("|", "\\|");
}

export function renderReport(results: CellResult[], meta: { startedAt: string; dry: boolean }): string {
	const lines: string[] = [];
	lines.push(`# bench-agent report — ${meta.startedAt}${meta.dry ? " (DRY)" : ""}`, "");
	lines.push("| config | task | wall(s) | turns | out tok | reason tok | reason% | tok/s | med turn(s) | p90(s) | cache% | quality |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const r of results) {
		const m = r.metrics;
		const row = m
			? `| ${r.configId} | ${r.taskId} | ${(m.wallMs / 1000).toFixed(1)} | ${m.turns} | ${m.outputTokens} | ${m.reasoningTokens} | ${(m.reasoningRatio * 100).toFixed(0)} | ${m.tokensPerSec.toFixed(1)} | ${(m.medianTurnMs / 1000).toFixed(1)} | ${(m.p90TurnMs / 1000).toFixed(1)} | ${(m.cacheHitRatio * 100).toFixed(0)} | ${r.ok ? (r.quality?.pass ? "PASS" : `FAIL(${esc(r.quality?.detail ?? "?")})`) : `ERROR(${esc(r.error ?? "?")})`} |`
			: `| ${r.configId} | ${r.taskId} | - | - | - | - | - | - | - | - | - | ${
					r.ok
						? r.quality
							? r.quality.pass
								? "PASS"
								: `FAIL(${esc(r.quality.detail)})`
							: "no metrics"
						: `ERROR(${esc(r.error ?? "?")})`
				} |`;
		lines.push(row);
	}
	lines.push("", "## Per-config summary", "");
	lines.push("| config | cells ok | quality pass | mean wall(s) | mean reason% |");
	lines.push("|---|---|---|---|---|");
	for (const cfg of [...new Set(results.map((r) => r.configId))]) {
		const cells = results.filter((r) => r.configId === cfg);
		const okc = cells.filter((r) => r.ok);
		const qc = cells.filter((r) => r.quality?.pass);
		const meanWall = okc.length ? okc.reduce((a, r) => a + (r.metrics?.wallMs ?? 0), 0) / okc.length / 1000 : 0;
		const meanReason = okc.length ? (okc.reduce((a, r) => a + (r.metrics?.reasoningRatio ?? 0), 0) / okc.length) * 100 : 0;
		lines.push(`| ${cfg} | ${okc.length}/${cells.length} | ${qc.length}/${cells.length} | ${meanWall.toFixed(1)} | ${meanReason.toFixed(0)} |`);
	}
	return lines.join("\n");
}
