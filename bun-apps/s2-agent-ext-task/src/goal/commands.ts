/**
 * /goal command parsing — pure helpers extracted from goal.ts.
 *
 * This module owns the string-in → CommandResult-out layer for the `/goal`
 * slash command: argument-completion, tokenization, token-budget parsing,
 * objective validation, and command routing. It is a pure module with ZERO
 * `@earendil-works/*` imports — exercised directly under plain Bun
 * (see __tests__/commands.test.ts) and re-exported through goal.js for the
 * legacy public import path used by goal.test.ts.
 *
 * Ported from @narumitw/pi-goal v0.11.0 (the parsing surface is unchanged).
 */

/** Reviewer mode — matches reviewer.ts ReviewerMode. Re-exported here
 * so commands.ts can type CommandResult.mode without importing reviewer.ts
 * (keeping commands.ts pi-import-free). */
export type ReviewerMode = "off" | "on" | "auto" | "aggressive";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
	kind: "show" | "start" | "pause" | "resume" | "clear" | "edit" | "audit" | "review";
	objective?: string;
	tokenBudget?: number;
	/** Opt-in: run the completion auditor against this goal. */
	audit?: boolean;
	/** Opt-in: auditor model as opaque `"provider/id"` (resolved by goal.ts). */
	auditorModel?: string;
	/** For kind: "review" — reviewer mode (off|on|auto|aggressive). */
	mode?: ReviewerMode;
}

export type ListCommandResult =
	| { kind: "show" }
	| { kind: "add"; texts: string[] }
	| { kind: "next" }
	| { kind: "remove"; index: number }
	| { kind: "clear" };

export interface GoalArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_OBJECTIVE_LENGTH = 4_000;

export const GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "pause", label: "pause", description: "Pause the active goal" },
	{ value: "resume", label: "resume", description: "Resume a paused or budget-limited goal" },
	{ value: "clear", label: "clear", description: "Clear the current goal (stop|off|reset|none|cancel also work)" },
	{ value: "edit", label: "edit", description: "Edit the current goal objective" },
	{ value: "status", label: "status", description: "Show the current goal" },
	{ value: "--tokens ", label: "--tokens", description: "Set a token budget before the goal" },
	{ value: "review ", label: "review", description: "Set the post-completion Reviewer mode (on|off|auto|aggressive)" },
];

export const EDIT_TOKEN_COMPLETION: GoalArgumentCompletion = {
	value: "edit --tokens ",
	label: "--tokens",
	description: "Set a token budget before the updated goal",
};

// ─── Argument completions & parsing ───────────────────────────────────────────

export function completeGoalArguments(argumentPrefix: string): GoalArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (prefix === "") return [...GOAL_ARGUMENT_COMPLETIONS];

	const editOptionPrefix = /^edit\s+(\S*)$/.exec(prefix)?.[1];
	if (editOptionPrefix !== undefined) {
		return editOptionPrefix === "" || "--tokens".startsWith(editOptionPrefix)
			? [EDIT_TOKEN_COMPLETION]
			: null;
	}

	if (/\s/.test(prefix)) return null;

	const matches = GOAL_ARGUMENT_COMPLETIONS.filter(
		(item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
	);
	return matches.length > 0 ? [...matches] : null;
}

export function parseCommand(args: string): CommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };

	const [first, ...rest] = tokens;
	if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "Usage: /goal pause";
	if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "Usage: /goal resume";
	// CC /goal surface parity (ticket 04): clear aliases stop/off/reset/none/cancel.
	const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
	if (CLEAR_ALIASES.has(first)) return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
	if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
	if (first === "audit") return rest.length === 0 ? { kind: "audit" } : "Usage: /goal audit";
	if (first === "review") {
		const arg = rest[0]?.toLowerCase();
		if (arg === "on") return { kind: "review", mode: "on" };
		if (arg === "off") return { kind: "review", mode: "off" };
		if (arg === "auto") return { kind: "review", mode: "auto" };
		if (arg === "aggressive") return { kind: "review", mode: "aggressive" };
		return "Usage: /goal review on|off|auto|aggressive";
	}
	if (first === "edit") return parseObjective("edit", rest);
	return parseObjective("start", tokens);
}

function parseObjective(kind: "start" | "edit", tokens: string[]): CommandResult | string {
	let tokenBudget: number | undefined;
	let audit: boolean | undefined;
	let auditorModel: string | undefined;
	const remaining = [...tokens];

	// Parse leading flags in any order before the objective text. Unknown
	// `--foo` tokens fall through and become part of the objective (preserving
	// the original "first non-flag token starts the objective" behavior).
	while (remaining.length > 0 && remaining[0].startsWith("--")) {
		const flag = remaining[0];
		if (flag === "--audit") {
			audit = true;
			remaining.splice(0, 1);
			continue;
		}
		if (flag === "--model") {
			const rawModel = remaining[1];
			if (!rawModel) return "Usage: /goal --model provider/id <goal_to_complete>";
			// Opaque `"provider/id"` — no validation/parsing here (Task 5 resolves it).
			auditorModel = rawModel;
			remaining.splice(0, 2);
			continue;
		}
		if (flag === "--tokens") {
			const rawBudget = remaining[1];
			if (!rawBudget) return "Usage: /goal --tokens 100k <goal_to_complete>";
			const parsedBudget = parseTokenBudget(rawBudget);
			if (parsedBudget === undefined) return `Invalid token budget: ${rawBudget}`;
			tokenBudget = parsedBudget;
			remaining.splice(0, 2);
			continue;
		}
		break;
	}

	if (remaining.length === 0) {
		return kind === "edit" ? "Usage: /goal edit <goal_to_complete>" : "Usage: /goal <goal_to_complete>";
	}

	return { kind, objective: remaining.join(" "), tokenBudget, audit, auditorModel };
}

export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;

	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parseTokenBudget(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

export function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "Usage: /goal <goal_to_complete>";
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
	}
	return undefined;
}

/** Parse a `/list …` command. Returns null if input is not a list command. */
export function parseListCommand(input: string): ListCommandResult | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("list")) return null;
	const rest = trimmed.slice(4).trim(); // after "list"
	if (rest === "") return { kind: "show" };
	const sub = rest.split(/\s+/)[0]?.toLowerCase();
	const argText = rest.slice(sub!.length).trim();
	if (sub === "add") {
		const texts = tokenize(argText);
		return { kind: "add", texts };
	}
	if (sub === "next") return { kind: "next" };
	if (sub === "clear") return { kind: "clear" };
	if (sub === "remove") {
		const index = Number.parseInt(argText, 10);
		return { kind: "remove", index: Number.isFinite(index) ? index : -1 };
	}
	// Unknown /list subcommand → treat as show (forgiving).
	return { kind: "show" };
}
