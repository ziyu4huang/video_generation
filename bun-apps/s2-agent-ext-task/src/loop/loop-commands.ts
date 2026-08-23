/** /loop command parsing — CC syntax: [interval] <prompt…>. */
export interface ActiveLoop {
	id: string;
	prompt: string;
	intervalMs: number;
	startedAt: number;
	nextFireAt: number;
	iteration: number;
}

export type LoopCommandResult =
	| { kind: "show" }
	| { kind: "stop" }
	| { kind: "start"; intervalMs: number; prompt: string };

export const DEFAULT_LOOP_INTERVAL_MS = 600_000; // CC default: 10m

export interface LoopArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export const LOOP_ARGUMENT_COMPLETIONS: readonly LoopArgumentCompletion[] = [
	{ value: "5m ", label: "5m", description: "Run every 5 minutes" },
	{ value: "30m ", label: "30m", description: "Run every 30 minutes" },
	{ value: "1h ", label: "1h", description: "Run every hour" },
	{ value: "stop", label: "stop", description: "Stop the active loop" },
	{ value: "status", label: "status", description: "Show the active loop" },
];

export function completeLoopArguments(prefix: string): LoopArgumentCompletion[] | null {
	const p = prefix.trimStart();
	if (/\s/.test(p)) return null;
	const m = LOOP_ARGUMENT_COMPLETIONS.filter((c) => c.value.startsWith(p) || c.label.startsWith(p));
	return m.length ? [...m] : null;
}

/** Parse "90s" / "5m" / "1h" / "1d" -> ms; seconds round UP to a whole minute (CC). */
export function parseInterval(token: string): number | undefined {
	const m = /^(\d+)(s|m|h|d)$/i.exec(token.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2].toLowerCase();
	const mult = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	const ms = n * mult;
	return unit === "s" ? Math.max(60_000, Math.ceil(ms / 60_000) * 60_000) : ms;
}

const USAGE = "Usage: /loop <interval> <prompt> (e.g. /loop 5m check the deploy) — see /loop status";

export function parseLoopCommand(args: string): LoopCommandResult | string {
	const trimmed = args.trim();
	if (trimmed === "") return { kind: "show" };
	const first = trimmed.split(/\s+/)[0];
	if (first === "stop") {
		const rest = trimmed.slice(first.length).trim();
		return rest.length === 0 ? { kind: "stop" } : "Usage: /loop stop";
	}
	if (first === "status" || first === "show") {
		const rest = trimmed.slice(first.length).trim();
		return rest.length === 0 ? { kind: "show" } : "Usage: /loop status";
	}
	// Old process-loop syntax: point at the new surface instead of silently mislooping.
	if (first === "start" || /^measure=/.test(first)) {
		return `The process-improvement loop was replaced by a recurring-prompt loop. ${USAGE}`;
	}
	const intervalMs = parseInterval(first);
	if (intervalMs !== undefined) {
		const prompt = trimmed.slice(first.length).trim();
		return prompt.length > 0 ? { kind: "start", intervalMs, prompt } : USAGE;
	}
	return { kind: "start", intervalMs: DEFAULT_LOOP_INTERVAL_MS, prompt: trimmed };
}
