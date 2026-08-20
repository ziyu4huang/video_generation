/**
 * prompting.ts — every message this extension sends back into the session.
 *
 * Extracted from goal.ts (spec 1a). One module because they share one exit
 * point: `sendPrompt`, which is the only place that decides between an
 * immediate `sendUserMessage` and a `followUp` delivery, and the only place a
 * send failure turns into a notify.
 *
 * Sits above internals.ts and below status.ts: the heartbeat timer re-fires
 * `sendContinuationPrompt`, and `sendContinuationPrompt` reaches DOWN into
 * internals for the pending-message check and the marker. Reversing either edge
 * re-creates the cycle the split exists to avoid.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "./format.js";
import { goalState } from "./state.js";
import type { StatusContext } from "./context.js";
import {
	buildContinuePrompt,
	buildGoalPrompt,
	buildObjectiveUpdatedPrompt,
	buildResumePrompt,
} from "./prompts.js";
import { LENGTH_CONTINUE_MAX, LENGTH_CONTINUE_TEXT } from "./length-continue.js";
import {
	continuationMarker,
	formatError,
	hasPendingMessages,
	planProgressLineFromPeer,
} from "./internals.js";

// ─── Prompt sending ───────────────────────────────────────────────────────────

export async function sendGoalPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildGoalPrompt(goal));
}

export async function sendObjectiveUpdatedPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildObjectiveUpdatedPrompt(goal));
}

export async function sendResumePrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildResumePrompt(goal));
}

/**
 * length-continue (GLA faithful baseline): re-trigger the agent after a
 * truncated response. The text is constant (LENGTH_CONTINUE_TEXT); `consecutive`
 * drives the fire-path notify + the ledger. Wrapped in try/catch so a stale API
 * handle never crashes the agent_end handler (GLA's goStaleTerminal intent).
 */
export function sendLengthContinue(pi: ExtensionAPI, ctx: StatusContext, consecutive: number): void {
	try {
		pi.sendUserMessage(LENGTH_CONTINUE_TEXT, { deliverAs: "followUp" });
		pi.appendEntry?.("length_continue_sent", { consecutive });
		ctx.ui.notify(`Response hit the output-token cap — auto-continuing (${consecutive}/${LENGTH_CONTINUE_MAX})`, "warning");
	} catch (err) {
		pi.appendEntry?.("length_continue_send_failed", { consecutive, error: err instanceof Error ? err.message : String(err) });
	}
}

export async function sendContinuationPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	if (goalState.continuationPending?.goalId === goal.id) return false;
	if (hasPendingMessages(ctx)) return false;

	const marker = continuationMarker(goal);
	const prompt = buildContinuePrompt(goal, marker, planProgressLineFromPeer());
	goalState.continuationPending = { goalId: goal.id, iteration: goal.iteration, marker, prompt };
	const sent = await sendPrompt(pi, ctx, prompt);
	if (!sent && goalState.continuationPending?.marker === marker) goalState.continuationPending = undefined;
	return sent;
}

export async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string) {
	try {
		const sent = ctx.isIdle?.()
			? (pi.sendUserMessage(prompt) as void | Promise<void>)
			: (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
		return true;
	} catch (error) {
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}