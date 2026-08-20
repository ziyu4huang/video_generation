import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalOverlay, type GoalOverlayLike } from "./overlay.js";
import { type ActiveGoal } from "./format.js";
import { createGoal, goalState } from "./state.js";
import { persistGoal } from "./persistence.js";
import { completeGoalArguments, parseCommand, parseListCommand } from "./commands.js";
import { addListItems, removeListItem, promoteNext, goalToListItem, clearList } from "./list.js";
import { buildGoalSystemPrompt } from "./prompts.js";
import type { StatusContext } from "./context.js";
import { currentTokenTotal } from "./internals.js";
import { clearActiveGoal, setAndPersistGoal, updateStatus } from "./status.js";
import { goalCompleteTool } from "./goal-complete-tool.js";
import { registerGoalHooks } from "./hooks.js";
import { clearGoal, editGoal, pauseGoal, resumeGoal, showGoal, startGoal, toggleGoalAudit } from "./lifecycle.js";
import { sendGoalPrompt } from "./prompting.js";



// Re-export formatters + types for tests and downstream consumers.
export { formatStatus, formatGoalMetric, formatDuration, formatTokenCount, type ActiveGoal } from "./format.js";
// Re-export overflow helpers so the public import path via goal.js is preserved.
export { findFinalAssistantMessage, isContradictoryCompletionSummary, isRetryableGoalInterruption } from "./overflow.js";
// Re-export /goal command-parsing helpers so the public import path via goal.js
// is preserved (goal.test.ts imports these from ../goal.js).
export { parseCommand, parseTokenBudget, validateObjective, completeGoalArguments } from "./commands.js";
// Re-export the goal-mode system-prompt builder so the public import path via
// goal.js is preserved (goal.test.ts imports buildGoalSystemPrompt from ../goal.js).
export { buildGoalSystemPrompt } from "./prompts.js";
export { __setAuditRunnerForTest } from "./goal-complete-tool.js";
// The spec-1a split moved these out of this file. Re-exported one-hop (each line
// names the module that DEFINES the symbol) so `from "../goal.js"` keeps working
// for every test and consumer — the same facade contract overflow.ts's header
// records for the earlier extraction.
export type { StatusContext } from "./context.js";
export { planningGateBlocking, planProgressLineFromPeer } from "./internals.js";

// ─── Status context ───────────────────────────────────────────────────────────
// Moved to ./context.ts and re-exported above: every module carved out of this
// file takes it as a parameter, so leaving it here made the split cyclic.

// ─── Module state ─────────────────────────────────────────────────────────────
// ALL session-scoped runtime state lives in the `goalState` container
// (./state.js) so it can be reset from tests via `__resetGoalState()`.
// `goalState.extensionApi` and `goalState.latestCtx` are typed `unknown` there
// to keep state.ts free of @earendil-works/* import statements; they are
// narrowed with localized casts at each read site.
//
// Two module-level `let`s used to sit here and are gone:
//   - `piRef`, captured from goal()'s `pi` arg, was assigned on the same line as
//     `goalState.extensionApi` from the same value. Its only purpose was dodging
//     the `as ExtensionAPI` cast, which is not worth a second source of truth
//     for "the current ExtensionAPI".
//   - `goalOverlay` moved to `goalState.overlay`: the spec-1a split gives
//     lifecycle, timers and the hook handlers each their own module, and all of
//     them update the overlay.


// ─── Coordination seam (Plan A: goal ⇄ /loop mutual-exclusion) ──

/**
 * Whether a /goal is currently in the "active" (driving) state.
 *
 * Exported so the in-package `/loop` subsystem can query it (via the
 * `globalThis.__piGoalActive` reader) for goal⇄loop mutual exclusion, and so
 * power-tool's `inspect_tui` can surface it (display-only). No plan
 * coordinator or wayfind reads it. Returns FALSE for paused / budget_limited
 * / complete / no-goal.
 */
export function isGoalActive(): boolean {
	return goalState.activeGoal?.status === "active";
}


// ─── Public entry point ───────────────────────────────────────────────────────

export default function goal(pi: ExtensionAPI, overlay: GoalOverlayLike = new GoalOverlay()) {
	goalState.extensionApi = pi;
	goalState.overlay = overlay;
	pi.registerTool(goalCompleteTool);

	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		getArgumentCompletions: completeGoalArguments,
		handler: async (args: string, ctx: StatusContext) => {
			const result = parseCommand(args);
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}

			switch (result.kind) {
				case "show":
					showGoal(ctx);
					return;
				case "pause":
					pauseGoal(ctx);
					return;
				case "resume":
					await resumeGoal(pi, ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					await editGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
				case "audit":
					toggleGoalAudit(ctx);
					return;
				case "review":
					if (result.mode) {
						goalState.reviewerMode = result.mode;
						goalState.reviewerEnabled = result.mode !== "off";
					}
					ctx.ui.notify(`Reviewer mode set to ${goalState.reviewerMode} for this session.`, "info");
					return;
				case "start": {
					// A bare `/goal "x"` is a fresh single-goal intent — the queue must
					// NOT persist across it. Reset BEFORE startGoal (NOT inside it: /list
					// add calls startGoal DIRECTLY from the /list handler with a pre-set
					// tail, which a reset inside startGoal would wipe).
					goalState.list = [];
					goalState.headAdvances = 0;
					await startGoal(result.objective ?? "", result.tokenBudget, pi, ctx, {
						auditEnabled: result.audit,
						auditorModel: result.auditorModel,
					});
					return;
				}
			}
		},
	});

	pi.registerCommand("list", {
		description: "Manage the goal queue: /list [add \"obj\"… | next | remove <n> | clear]",
		handler: async (args: string, ctx: StatusContext) => {
			// parseListCommand expects the full "list …" token (its contract, see
			// commands.test.ts); the slash-command dispatcher passes only the
			// remainder after `/list `, so reconstruct it here. A bare `/list`
			// (empty args) becomes `list ` → { kind: "show" }.
			const cmd = parseListCommand(`list ${args}`);
			if (!cmd) return;

			const api = goalState.extensionApi as ExtensionAPI;
			const active = goalState.activeGoal;

			switch (cmd.kind) {
				case "show": {
					// Render head (index 1 = active) + indexed tail. ctx.ui has no print()
					// method, so notify carries the multi-line block (matches the
					// notify-based harness in goal.test.ts).
					const lines: string[] = active
						? [`1. ${active.text}  (active)`]
						: ["(no active goal)"];
					for (const [i, item] of goalState.list.entries())
						lines.push(`${i + 2}. ${item.text}${item.parked ? "  ⚠parked" : ""}`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "add": {
					if (cmd.texts.length === 0) {
						ctx.ui.notify("Nothing to add.", "info");
						return;
					}
					if (!active || active.status === "complete") {
						// No active goal (or the head is already complete): the first item
						// becomes the head (started), the rest fill the tail. APPEND to the
						// existing tail — a reachable state has a complete head + a non-empty
						// pending tail (pre-Task-6), and rebuilding from [] would silently
						// discard those items. Set the tail BEFORE startGoal so its
						// persistGoal snapshots head + tail together.
						goalState.list = addListItems(goalState.list, cmd.texts.slice(1));
						// Fresh queue head → position resets (headAdvances only ever
						// increments in production; without this it would inflate across
						// drained queues, mis-stating the widget position).
						goalState.headAdvances = 0;
						await startGoal(cmd.texts[0], undefined, pi, ctx);
					} else {
						goalState.list = addListItems(goalState.list, cmd.texts);
						setAndPersistGoal(active, ctx);
						ctx.ui.notify(
							`Added ${cmd.texts.length} goal(s) to the queue (${goalState.list.length} queued).`,
							"info",
						);
					}
					return;
				}

				case "next": {
					if (!active) {
						ctx.ui.notify("No active goal to advance from.", "info");
						return;
					}
					if (active.status === "complete") {
						ctx.ui.notify("Active goal already complete.", "info");
						return;
					}
					// Nothing to advance to when the tail is empty. This check MUST run
					// before parking the head: promoteNext([...tail, parkedHead]) always
					// yields the parked head as `item`, so a bare `if (!item)` guard
					// would be dead code and re-promote the head onto itself.
					if (goalState.list.length === 0) {
						ctx.ui.notify("Queue empty — nothing to advance to.", "info");
						return;
					}
					// Park the current head at the tail, then promote the next tail
					// item. Do NOT call startGoal here — it would trigger the
					// "Replace goal?" confirm; createGoal starts the head cleanly.
					// The empty-tail guard above guarantees the spread is non-empty, so
					// promoteNext always yields a defined item — the old `if (!item)`
					// was unreachable dead code and is removed.
					const { item, rest } = promoteNext([...goalState.list, goalToListItem(active)]);
					goalState.list = rest;
					// promoteNext returns an undefined item ONLY for empty input; the
					// empty-tail guard above proves it is defined here.
					const promoted = item!;
					goalState.activeGoal = createGoal(
						promoted.text,
						promoted.tokenBudget,
						currentTokenTotal(ctx),
						promoted.audit,
						"list",
					);
					goalState.headAdvances += 1;
					setAndPersistGoal(goalState.activeGoal, ctx);
					ctx.ui.notify(`Advanced to: ${promoted.text}`, "info");
					await sendGoalPrompt(pi, ctx, goalState.activeGoal);
					return;
				}

				case "remove": {
					// /list show numbers head=1, tail=2,3,…; removeListItem is 1-based
					// on the tail. Translate the user-facing DISPLAY index → tail index;
					// display index 1 is the active head (not removable here).
					const tailIndex = cmd.index - 1;
					if (cmd.index < 1) { ctx.ui.notify("Usage: /list remove <n>", "warning"); return; }   // M1: bare/invalid
					if (tailIndex < 1) { ctx.ui.notify("Index 1 is the active head; use /list next or /goal clear.", "warning"); return; }
					const before = goalState.list.length;
					goalState.list = removeListItem(goalState.list, tailIndex);
					if (goalState.list.length === before) { ctx.ui.notify(`No item at index ${cmd.index}.`, "warning"); return; }
					// persistGoal requires an ActiveGoal; with no active head there is
					// nothing to snapshot the tail alongside — a no-op persist is
					// correct there.
					if (active) persistGoal(api, active);
					updateStatus(ctx, goalState.activeGoal);
					ctx.ui.notify(`Removed item ${cmd.index}.`, "info");
					return;
				}

				case "clear": {
					goalState.list = clearList();
					goalState.headAdvances = 0;
					if (active) persistGoal(api, active);
					updateStatus(ctx, goalState.activeGoal);
					ctx.ui.notify("Queue cleared (active goal untouched).", "info");
					return;
				}
			}
		},
	});

	registerGoalHooks(pi);
}

// ─── What used to live below this line ────────────────────────────────────────
// The spec-1a split moved it all out, each piece re-exported above where it was
// part of this module's public surface:
//   ./goal-complete-tool.ts  the goal_complete tool + the audit test seam
//   ./hooks.ts               the nine pi.on(...) lifecycle handlers
//   ./lifecycle.ts           start / pause / resume / clear / edit / show
//   ./status.ts              overlay updates, the two timers, clearActiveGoal
//   ./prompting.ts           every sendUserMessage path
//   ./internals.ts           the leaf helpers all of the above share
//   ./context.ts             StatusContext
// Argument parsing (./commands.ts) and persistence (./persistence.ts) had
// already been extracted before this split.
