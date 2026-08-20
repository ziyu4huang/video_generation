/**
 * Overflow / interruption-classification helpers — extracted from goal.ts
 * (Phase 1, Task 1 of the goal.ts modularization).
 *
 * This is a PURE module: it has ZERO @earendil-works/* imports and is unit-
 * tested directly under plain Bun (see __tests__/overflow.test.ts). The
 * re-export seam in goal.ts keeps the historical public import path
 * (`from "./goal.js"`) intact for goal.test.ts and downstream consumers.
 *
 * Origin: these helpers were inlined into goal.ts (ported from
 * @earendil-works/pi-ai v0.80.2) to avoid a Bun-isolated-linker dependency on
 * @earendil-works/pi-ai.
 *
 * Bun conventions (no node: prefix; process is global) apply.
 */

// ─── Local types (replaces @earendil-works/pi-ai types) ───────────────────────

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface AssistantMessageContent {
	type: string;
	text?: string;
	[_: string]: unknown;
}

// ─── Goal-specific types ──────────────────────────────────────────────────────

export type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AssistantMessageLike {
	role: "assistant";
	stopReason?: AgentStopReason;
	errorMessage?: string;
	content?: AssistantMessageContent[];
	api?: string;
	provider?: string;
	model?: string;
	usage?: Usage;
	timestamp?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRADICTORY_COMPLETION_PATTERNS = [
	/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
	/\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
	/\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;
const NON_RETRYABLE_GOAL_ERROR_RE =
	/usage[_\s-]*limit|chatgpt usage limit|multi-auth rotation failed|credentials tried|unauthori[sz]ed|invalid api key/i;
const RETRYABLE_GOAL_ERROR_RE =
	/websocket closed|sse response headers timed out|headers timed out|context[_\s-]*length[_\s-]*exceeded|input exceeds the context window|provider returned error/i;

// ─── Inlined isContextOverflow (from @earendil-works/pi-ai v0.80.2) ────────────
// Inlined to avoid a Bun-isolated-linker dependency on @earendil-works/pi-ai.
// See: https://github.com/earendil-works/pi-ai/src/utils/overflow.ts

const OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i,
	/rate limit/i,
	/too many requests/i,
];

export function isContextOverflow(message: { stopReason?: string; errorMessage?: string; usage?: Usage }, contextWindow?: number): boolean {
	if (message.stopReason === "error" && message.errorMessage) {
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}
	if (contextWindow && message.stopReason === "stop" && message.usage) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}
	if (contextWindow && message.stopReason === "length" && message.usage && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}
	return false;
}

export function isContradictoryCompletionSummary(summary: string) {
	return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}

export function isRetryableGoalInterruption(assistant: AssistantMessageLike) {
	if (assistant.stopReason !== "error") return false;
	if (!assistant.errorMessage) return false;
	if (NON_RETRYABLE_GOAL_ERROR_RE.test(assistant.errorMessage)) return false;
	return isGoalContextOverflow(assistant) || RETRYABLE_GOAL_ERROR_RE.test(assistant.errorMessage);
}

export function isGoalContextOverflow(assistant: AssistantMessageLike) {
	return isContextOverflow(assistant);
}

export function findFinalAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role !== "assistant") continue;
		const assistant: AssistantMessageLike = {
			role: "assistant",
			stopReason: isAgentStopReason(candidate.stopReason) ? candidate.stopReason : undefined,
			errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
		};
		if (Array.isArray(candidate.content)) assistant.content = candidate.content as AssistantMessageContent[];
		if (typeof candidate.api === "string") assistant.api = candidate.api;
		if (typeof candidate.provider === "string") assistant.provider = candidate.provider;
		if (typeof candidate.model === "string") assistant.model = candidate.model;
		if (typeof candidate.timestamp === "number") assistant.timestamp = candidate.timestamp;
		const usage = normalizeUsage(candidate.usage);
		if (usage) assistant.usage = usage;
		return assistant;
	}
	return undefined;
}

function isAgentStopReason(value: unknown): value is AgentStopReason {
	return ["stop", "length", "toolUse", "error", "aborted"].includes(String(value));
}

function normalizeUsage(value: unknown): Usage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Partial<Usage>;
	if (typeof usage.input !== "number" || typeof usage.output !== "number") return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? usage.input + usage.output + (usage.cacheRead ?? 0),
		cost: {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		},
	};
}
