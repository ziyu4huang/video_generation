/**
 * pi-agent-ext-core-task — the task-execution cockpit: /goal + todo + ask_user_question + shared composite status widget.
 *
 * Merged from pi-agent-ext-core-task (pi-core-task.ts) and
 * pi-agent-ext-ask-user (pi-ask-user.ts) into a single extension entry.
 *
 * goal + todo are kept together because they share:
 *   • CoreTaskStatusWidget — a single above-editor widget key ("pi-core-task")
 *     that renders goal (top) + todo (bottom) in fixed order. Splitting them
 *     across two extensions would reintroduce the widget-key flicker bug the
 *     composite widget was built to fix (the SDK orders widgets by Map
 *     insertion order with no index API).
 *   • Six session lifecycle hooks (replay-from-branch, overlay reset/dispose,
 *     tool-execution-end refresh, agent-start hide-completed).
 *
 * ask_user_question is a self-contained modal dialog tool with no shared code
 * against goal/todo — merged here purely for entry-point consolidation.
 *
 * Plan A coordination seam: publishes `isGoalActive` on globalThis so peer
 * extensions (the plan coordinator) can read it WITHOUT a hard dep. The peer
 * reads `globalThis.__piGoalActive?.() ?? false`. This is a runtime globalThis
 * contract — load order only affects the brief startup window, handled by the
 * `?? false` fallback.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import goal, { isGoalActive } from "../src/goal/goal.js";
import { GoalOverlay } from "../src/goal/overlay.js";
import { registerTodoTool, registerTodosCommand } from "../src/todo/todo";
import { TodoOverlay } from "../src/todo/overlay";
import { replayFromBranch } from "../src/todo/state/replay";
import { replaceState } from "../src/todo/state/store";
import { TOOL_NAME } from "../src/todo/tool/types";
import { getSharedStatusWidget } from "../src/shared/status-widget.js";
import registerAskUser from "../src/ask-user";
import { getPlanPhases, getPlanSummary, isPlanIncomplete, refreshPlan, shouldRefreshAfterTool } from "../src/plan/coordinator.js";
import { seedTodoFromPlan } from "../src/plan/todo-seed.js";

/** Swallow the expected "stale after session replacement" error on compact/tree. */
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
	// ── Plan A coordination seam ─────────────────────────────────────────
	// globalThis is process-singleton → the function always reads goal/goal's
	// activeGoal. Peer (the plan coordinator) reads globalThis.__piGoalActive?.().
	(globalThis as Record<string, unknown>).__piGoalActive = isGoalActive;

	// ── Plan coordination seams (ticket 09, tracer-bullet 2) ────────────
	// Publish __piPlan* so wayfind's existing readers light up (chain.ts:58
	// syncChainState closes [NN-slug] tickets; coordination.ts reads incomplete/
	// summary). Graceful no-op pre-refresh: empty phases, not-incomplete, "".
	// Mirror the __piGoalActive pattern (direct globalThis assignment).
	let latestCwd: string | undefined;
	const g = globalThis as Record<string, unknown>;
	g.__piPlanPhases = (cwd: string) => getPlanPhases(cwd);
	g.__piPlanIncomplete = (cwd: string) => isPlanIncomplete(cwd);
	g.__piPlanSummary = (cwd: string) => getPlanSummary(cwd);

	// ── Ask-user tool (self-contained modal dialog) ──────────────────────
	registerAskUser(pi);

	// ── Todo tool + /todos command ────────────────────────────────────────
	registerTodoTool(pi);
	registerTodosCommand(pi);

	// ── Goal + Todo overlays → ONE composite above-editor widget ─────────────
	// A single widget key makes stacking deterministic; goal renders on top,
	// todo below. The overlays are thin render() state-holders; all setWidget
	// lifecycle lives in CoreTaskStatusWidget.
	const statusWidget = getSharedStatusWidget();
	const goalOverlay = new GoalOverlay();
	const todoOverlay = new TodoOverlay();
	goal(pi, goalOverlay);
	goalOverlay.setRefresh(() => statusWidget.update());
	todoOverlay.setRefresh(() => statusWidget.update());
	statusWidget.addSection({ id: "goal", order: 0, render: (t, w) => goalOverlay.render(t, w) });
	statusWidget.addSection({ id: "todo", order: 1, render: (t, w) => todoOverlay.render(t, w), inspect: () => todoOverlay.inspect() });

	pi.on("session_start", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		latestCwd = ctx.cwd;
		refreshPlan(ctx.cwd); // parse + cache the active effort's plan
		seedTodoFromPlan(ctx.cwd); // plan-master: seed the todo from the plan when empty (no-op if replay populated it)
		if (ctx.hasUI) {
			statusWidget.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			statusWidget.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		try {
			replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay.resetCompletedDisplayState();
		statusWidget.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay.resetCompletedDisplayState();
		statusWidget.update();
	});

	pi.on("session_shutdown", async () => {
		goalOverlay.dispose();
		todoOverlay.dispose();
		statusWidget.dispose();
	});

	pi.on("tool_execution_end", async (event) => {
		if (latestCwd && shouldRefreshAfterTool(event.toolName)) refreshPlan(latestCwd); // TB5a: re-parse only after a mutating tool (write/edit/bash)
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay.hideCompletedTasksFromPreviousTurn();
	});
};

export default extension;
