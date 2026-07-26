/** /loop command parsing — pure (mirror goal/commands.ts). */
import { tokenize, parseTokenBudget } from "../goal/commands.js";
import type { LoopDirection, LoopMode } from "./loop-state.js";

export type LoopCommandResult =
	| { kind: "show" }
	| { kind: "stop" }
	| {
			kind: "start";
			target: string;
			mode: LoopMode;
			measureCmd?: string;
			direction: LoopDirection;
			maxIterations: number;
			timeLimitMs?: number;
			tokenBudget?: number;
			plateauWindow: number;
	  };

export interface LoopArgumentCompletion { value: string; label: string; description?: string; }

export const LOOP_ARGUMENT_COMPLETIONS: readonly LoopArgumentCompletion[] = [
	{ value: "start ", label: "start", description: "Start a process loop" },
	{ value: "stop", label: "stop", description: "Stop the active loop" },
	{ value: "status", label: "status", description: "Show the active loop" },
];

export function completeLoopArguments(prefix: string): LoopArgumentCompletion[] | null {
	const p = prefix.trimStart();
	if (p === "") return [...LOOP_ARGUMENT_COMPLETIONS];
	if (/\s/.test(p)) return null;
	const m = LOOP_ARGUMENT_COMPLETIONS.filter((c) => c.value.startsWith(p) || c.label.startsWith(p));
	return m.length ? [...m] : null;
}

/** Parse "2h" / "30m" / "90s" -> ms. Undefined if unparseable. */
export function parseDuration(value: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(h|m|s)$/i.exec(value.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2].toLowerCase();
	const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
	return Math.floor(n * mult);
}

/** Parse a `key=value` option token. Returns [key, value] or undefined. */
function parseOption(token: string): [string, string] | undefined {
	const eq = token.indexOf("=");
	if (eq <= 0) return undefined;
	return [token.slice(0, eq), token.slice(eq + 1)];
}

export function parseLoopCommand(args: string): LoopCommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };
	const [first, ...rest] = tokens;
	if (first === "stop") return rest.length === 0 ? { kind: "stop" } : "Usage: /loop stop";
	if (first === "status" || first === "show") return rest.length === 0 ? { kind: "show" } : "Usage: /loop status";
	if (first !== "start") return { kind: "show" }; // forgiving

	// Separate positional target (may be quoted -> one token) from key=value options.
	const positional: string[] = [];
	const options = new Map<string, string>();
	for (const t of rest) {
		const opt = parseOption(t);
		if (opt && (opt[0] === "measure" || opt[0] === "direction" || opt[0] === "max" || opt[0] === "time" || opt[0] === "tokens" || opt[0] === "plateau")) {
			options.set(opt[0], opt[1]);
		} else {
			positional.push(t);
		}
	}
	if (positional.length === 0) return "Usage: /loop start \"<target>\" [measure=<cmd>] [direction=higher|lower] [max=N] [time=<Hh|Nm>] [tokens=Nk] [plateau=N]";
	const target = positional.join(" ");

	const measureRaw = options.get("measure");
	const mode: LoopMode = measureRaw !== undefined ? "metric" : "metricless";
	const direction: LoopDirection = options.get("direction") === "lower" ? "lower" : "higher";
	const maxIterations = options.has("max") ? Math.max(0, Number.parseInt(options.get("max")!, 10) || 0) : 0;
	const timeLimitMs = options.has("time") ? parseDuration(options.get("time")!) : undefined;
	const tokenBudget = options.has("tokens") ? parseTokenBudget(options.get("tokens")!) : undefined;
	const plateauWindow = options.has("plateau") ? Math.max(1, Number.parseInt(options.get("plateau")!, 10) || 5) : 5;

	return { kind: "start", target, mode, measureCmd: measureRaw, direction, maxIterations, timeLimitMs, tokenBudget, plateauWindow };
}
