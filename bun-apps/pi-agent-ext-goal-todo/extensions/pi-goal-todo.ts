/**
 * pi-agent-ext-goal-todo — /goal + todo with a shared composite status widget.
 *
 * Extracted from pi-agent-ext-power-tool (2026-07-12, monolith-split A3).
 * goal and todo are kept TOGETHER because they share:
 *   • PowerToolStatusWidget — a single above-editor widget key ("pi-power-tool")
 *     that renders goal (top) + todo (bottom) in fixed order. Splitting them
 *     across two extensions would reintroduce the widget-key flicker bug the
 *     composite widget was built to fix (the SDK orders widgets by Map
 *     insertion order with no index API).
 *   • Six session lifecycle hooks (replay-from-branch, overlay reset/dispose,
 *     tool-execution-end refresh, agent-start hide-completed).
 *
 * Plan A coordination seam: publishes `isGoalActive` on globalThis so peer
 * extensions (the plan coordinator) can read it WITHOUT a hard dep. The peer
 * reads `globalThis.__piGoalActive?.() ?? false`. This is a runtime globalThis
 * contract — load order only affects the brief startup window, handled by the
 * `?? false` fallback. Positioned early in run-dir/manifest.json (right after
 * power-tool) to mirror the pre-extraction ordering.
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

/** Swallow the expected "stale after session replacement" error on compact/tree. */
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
	// ── Plan A coordination seam ─────────────────────────────────────────
	// globalThis is process-singleton → the function always reads goal/goal's
	// activeGoal. Peer (the plan coordinator) reads globalThis.__piGoalActive?.().
	(globalThis as Record<string, unknown>).__piGoalActive = isGoalActive;

	// ── Todo tool + /todos command ────────────────────────────────────────
	registerTodoTool(pi);
	registerTodosCommand(pi);

	// ── Goal + Todo overlays → ONE composite above-editor widget ─────────────
	// A single widget key makes stacking deterministic; goal renders on top,
	// todo below. The overlays are thin render() state-holders; all setWidget
	// lifecycle lives in PowerToolStatusWidget.
	const statusWidget = getSharedStatusWidget();
	const goalOverlay = new GoalOverlay();
	const todoOverlay = new TodoOverlay();
	goal(pi, goalOverlay);
	goalOverlay.setRefresh(() => statusWidget.update());
	todoOverlay.setRefresh(() => statusWidget.update());
	statusWidget.addSection({ id: "goal", order: 0, render: (t, w) => goalOverlay.render(t, w) });
	statusWidget.addSection({ id: "todo", order: 1, render: (t, w) => todoOverlay.render(t, w) });

	pi.on("session_start", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
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
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay.hideCompletedTasksFromPreviousTurn();
	});
};

export default extension;
