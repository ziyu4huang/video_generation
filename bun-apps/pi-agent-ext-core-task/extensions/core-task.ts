/// <reference types="@repo/pi-agent-ext-core-interface" />
/**
 * pi-agent-ext-core-task — the task-execution cockpit: /goal + todo + ask_user_question + shared composite status widget.
 *
 * Merged from pi-agent-ext-core-task (pi-core-task.ts) and
 * pi-agent-ext-ask-user (pi-ask-user.ts) into a single extension entry.
 *
 * goal + todo are kept together because they share:
 *   • CoreTaskStatusWidget — a single below-editor widget key ("pi-core-task")
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
 * Plan A coordination seam: publishes `isGoalActive` on globalThis so the
 * in-package `/loop` subsystem can read it WITHOUT a hard dep (goal⇄loop
 * mutual exclusion). A peer reads `globalThis.__piGoalActive?.() ?? false`
 * (power-tool's `inspect_tui` also surfaces it, display-only). No plan
 * coordinator or wayfind reads it. This is a runtime globalThis contract —
 * load order only affects the brief startup window, handled by the `?? false`
 * fallback.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getSubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";
import { createSubagentsSection } from "../src/subagents/subagents-section.js";
import goal, { isGoalActive } from "../src/goal/goal.js";
import { registerLoop, restoreLoopFromSession } from "../src/loop/loop.js";
import { LoopOverlay } from "../src/loop/overlay.js";
import { setLoopRenderSid, __resetLoopState } from "../src/loop/loop-state.js";
import { GoalOverlay } from "../src/goal/overlay.js";
import { registerTodoTool, registerTodosCommand } from "../src/todo/todo";
import { TodoOverlay } from "../src/todo/overlay";
import { __resetState, replaceState, setRenderSid } from "../src/todo/state/store";
import { EMPTY_STATE } from "../src/todo/state/state";
import { TOOL_NAME } from "../src/todo/tool/types";
import { getSharedStatusWidget } from "../src/shared/status-widget.js";
import registerAskUser from "../src/ask-user";
import { registerResponseLanguage } from "../src/response-language/response-language.js";
import { registerAskUserLanguage } from "../src/response-language/ask-user-language.js";
import { getPlanPhases, getPlanSummary, isPlanIncomplete, refreshPlan, shouldRefreshAfterTool } from "../src/plan/coordinator.js";

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
	// ── Plan A coordination seam ─────────────────────────────────────────
	// globalThis is process-singleton → the function always reads goal/goal's
	// activeGoal. The in-package /loop subsystem reads globalThis.__piGoalActive?.()
	// (goal⇄loop mutual exclusion); power-tool's inspect_tui also surfaces it
	// display-only. No plan coordinator or wayfind reads it.
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

	// ── /response-language command (relocated from pi-agent-ext-response-language) ─
	registerResponseLanguage(pi);

	// ── /ask-user-language command (independent of responseLanguage; overrides it for ask_user_question) ──
	registerAskUserLanguage(pi);

	// ── Todo tool + /todos command ────────────────────────────────────────
	registerTodoTool(pi);
	registerTodosCommand(pi);

	// ── Goal + Todo overlays → ONE composite below-editor widget ─────────────
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

	const loopOverlay = new LoopOverlay();
	registerLoop(pi, loopOverlay);
	loopOverlay.setRefresh(() => statusWidget.update());
	// Loop is mutually exclusive with goal, so it shares order 0 — only one is ever non-empty.
	statusWidget.addSection({ id: "loop", order: 0, render: (t, w) => loopOverlay.render(t, w) });

	statusWidget.addSection({ id: "todo", order: 1, render: (t, w) => todoOverlay.render(t, w), inspect: () => todoOverlay.inspect() });

	// ── Subagents section (order 4) ────────────────────────────────────────
	// Live background-run rows from the in-flight registry. Foreground runs
	// stay inline (Surface A) — this section filters to foreground:false only,
	// so a run never renders on both surfaces (plan Task 01, exclusion rule).
	const subagentsHandle = createSubagentsSection({
		getViews: () => getSubagentInFlightRegistry().views({ foreground: false }),
		requestRender: () => statusWidget.update(),
	});
	statusWidget.addSection(subagentsHandle.section);

	pi.on("session_start", async (_event, ctx) => {
		// Todos are SESSION-ONLY: never replayed from the session branch and
		// never seeded from disk plans, so each session starts empty. Permanent
		// task tracking lives in wayfind/superpowers plans & tickets — read
		// those on demand; do not auto-load them into the session todo.
		//
		// Capture the parent/display session id so ctx-less display code
		// (renderers/overlay/command — no sessionManager on ToolRenderContext)
		// reads the parent's todos via the no-arg accessors' renderSid default.
		setRenderSid((ctx as { sessionManager?: { getSessionId: () => string } }).sessionManager?.getSessionId() ?? "");
		replaceState(EMPTY_STATE);
		latestCwd = ctx.cwd;
		refreshPlan(ctx.cwd); // parse + cache the active effort's plan (for the plan coordinator; NOT for todo seeding)
		// Capture the same parent/display session id for the loop-state renderSid
		// bucket — no-arg getLoopState() in ctx-less/display sites reads this —
		// BEFORE restoring any persisted loop into that bucket. Optimization #3 / #16.
		setLoopRenderSid((ctx as { sessionManager?: { getSessionId: () => string } }).sessionManager?.getSessionId() ?? "");
		restoreLoopFromSession((ctx as { sessionManager?: unknown }).sessionManager, loopOverlay);
		if (ctx.hasUI) {
			statusWidget.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			statusWidget.update();
		}
	});

	pi.on("session_compact", async () => {
		// No replay: todos are in-memory only and survive compaction naturally.
		// Replaying the (now-summarized) branch would either drop current todos
		// or restore stale ones. See the session_start note.
		todoOverlay.resetCompletedDisplayState();
		statusWidget.update();
	});

	pi.on("session_tree", async () => {
		// No replay: todos are session-only in-memory state. Branch switches do
		// not restore per-branch todos (deliberate — see session_start note).
		todoOverlay.resetCompletedDisplayState();
		statusWidget.update();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Drop this session's todo bucket so a later session reusing the process
		// doesn't inherit stale parent todos. (Children key their own buckets;
		// their own session_shutdown — if any — cleans those.)
		__resetState((ctx as { sessionManager?: { getSessionId: () => string } }).sessionManager?.getSessionId());
		// Drop this session's loop-state bucket too (mirrors the todo cleanup above).
		__resetLoopState((ctx as { sessionManager?: { getSessionId: () => string } }).sessionManager?.getSessionId());
		goalOverlay.dispose();
		loopOverlay.dispose();
		todoOverlay.dispose();
		subagentsHandle.dispose();
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
