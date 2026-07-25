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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
	kind: "show" | "start" | "pause" | "resume" | "clear" | "edit";
	objective?: string;
	tokenBudget?: number;
}

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
	{ value: "clear", label: "clear", description: "Clear the current goal" },
	{ value: "edit", label: "edit", description: "Edit the current goal objective" },
	{ value: "status", label: "status", description: "Show the current goal" },
	{ value: "--tokens ", label: "--tokens", description: "Set a token budget before the goal" },
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
	if (first === "clear" || first === "stop") return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
	if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
	if (first === "edit") return parseObjective("edit", rest);
	return parseObjective("start", tokens);
}

function parseObjective(kind: "start" | "edit", tokens: string[]): CommandResult | string {
	let tokenBudget: number | undefined;
	const objectiveTokens = [...tokens];

	if (objectiveTokens[0] === "--tokens") {
		const rawBudget = objectiveTokens[1];
		if (!rawBudget) return "Usage: /goal --tokens 100k <goal_to_complete>";
		const parsedBudget = parseTokenBudget(rawBudget);
		if (parsedBudget === undefined) return `Invalid token budget: ${rawBudget}`;
		tokenBudget = parsedBudget;
		objectiveTokens.splice(0, 2);
	}

	if (objectiveTokens.length === 0) {
		return kind === "edit" ? "Usage: /goal edit <goal_to_complete>" : "Usage: /goal <goal_to_complete>";
	}

	return { kind, objective: objectiveTokens.join(" "), tokenBudget };
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
