/// <reference types="@repo/s2-agent-core-interface" />
/**
 * s2-agent-ext-task — the task-execution cockpit: /goal + todo + ask_user_question + shared composite status widget.
 *
 * Merged from s2-agent-ext-task (pi-core-task.ts) and
 * s2-agent-ext-ask-user (pi-ask-user.ts) into a single extension entry.
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
 * Plan A coordination seam: publishes `isGoalActive` on globalThis so a peer
 * can read it WITHOUT a hard dep (goal⇄loop mutual exclusion — the /loop
 * mechanism now lives in s2-agent-ext-ultracode, ticket 03). A peer reads
 * `globalThis.__piGoalActive?.() ?? false` (power-tool's `inspect_tui` also
 * surfaces it, display-only). No plan coordinator or wayfind reads it. This
 * is a runtime globalThis contract — load order only affects the brief
 * startup window, handled by the `?? false` fallback.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getSubagentInFlightRegistry } from "@repo/s2-agent-core-runtime";
import { createSubagentsSection } from "../src/subagents/subagents-section.js";
import goal, { isGoalActive } from "../src/goal/goal.js";
import { LoopOverlay } from "../src/loop/overlay.js";
import { GoalOverlay } from "../src/goal/overlay.js";
import { registerTodosCommand } from "../src/todo/todo";
import { TodoOverlay } from "../src/todo/overlay";
import { getSharedStatusWidget } from "../src/shared/status-widget.js";
import registerAskUser from "../src/ask-user";
import { registerResponseLanguage } from "../src/response-language/response-language.js";
import { registerAskUserLanguage } from "../src/response-language/ask-user-language.js";
import { getPlanPhases, refreshPlan, shouldRefreshAfterTool } from "../src/plan/coordinator.js";

/** ext-subagent's task tools (the ONE model-visible task family, t02/D7) — the
 *  calls that may have mutated the shared board the todo section renders. */
const TASK_TOOL_NAMES = new Set(["task_create", "task_get", "task_list", "task_update"]);

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
	// Self-gate: BUN_PI_TASK=0 disables the entire extension — it registers
	// nothing and publishes no seam. Mirrors prompt-history's
	// BUN_PI_PROMPT_HISTORY=0 so every extension in the portable base set
	// (the typed registry) shares one symmetric full-disable knob; enforced by
	// tests/extension-isolation-contract.test.ts. Safe: every cross-extension
	// consumer reads its seam defensively, so disabling degrades features,
	// never crashes.
	if (process.env.BUN_PI_TASK === "0") return;
	// ── Plan A coordination seam ─────────────────────────────────────────
	// globalThis is process-singleton → the function always reads goal/goal's
	// activeGoal. The /loop mechanism (s2-agent-ext-ultracode since ticket 03)
	// reads globalThis.__piGoalActive?.() (goal⇄loop mutual exclusion);
	// power-tool's inspect_tui also surfaces it display-only. No plan
	// coordinator or wayfind reads it.
	(globalThis as Record<string, unknown>).__piGoalActive = isGoalActive;

	// ── Plan coordination seam (ticket 09, tracer-bullet 2) ─────────────
	// Publish __piPlanPhases so wayfind's reader lights up (chain.ts:58
	// syncChainState closes [NN-slug] tickets). Graceful no-op pre-refresh:
	// empty phases. Mirror the __piGoalActive pattern (direct globalThis
	// assignment). (the plan-incomplete/summary keys were dead — no reader
	// ever landed; removed 2026-08-21, decision D1.)
	let latestCwd: string | undefined;
	const g = globalThis as Record<string, unknown>;
	g.__piPlanPhases = (cwd: string) => getPlanPhases(cwd);

	// ── Ask-user tool (self-contained modal dialog) ──────────────────────
	registerAskUser(pi);

	// ── /response-language command (relocated from s2-agent-ext-response-language) ─
	registerResponseLanguage(pi);

	// ── /ask-user-language command (independent of responseLanguage; overrides it for ask_user_question) ──
	registerAskUserLanguage(pi);

	// ── /todos command + todo widget section (TUI face of the shared board) ──
	// The `todo` mega-tool is retired (cc-parity-task-powertool t02/D7): the
	// ONE model-visible task family is ext-subagent's core-gated
	// task_create/get/list/update over core-runtime's TeamTaskStore. This
	// package only RENDERS that board.
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
	loopOverlay.setRefresh(() => statusWidget.update());
	loopOverlay.startPolling();
	// Recurring /loop runs independently of goal (CC runs /goal and /loop
	// concurrently) — order 0 shared is fine, an inactive section renders [].
	// Ticket 03 (2026-08-28): the /loop COMMAND, scheduler, and persistence
	// retired into s2-agent-ext-ultracode's WakeupRegistry — this package's
	// loop surface is this composite-widget section only, rendered from the
	// __piWakeupLoops seam (no import of ultracode: import-cycle rule).
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
		// The shared task board is SESSION-ONLY: never replayed from the session
		// branch and never seeded from disk plans, so each session starts empty
		// (ext-subagent's session_start resets the TeamTaskStore — same
		// contract the retired per-session todo buckets had). Permanent task
		// tracking lives in wayfind/superpowers plans & tickets — read those on
		// demand; do not auto-load them onto the board.
		latestCwd = ctx.cwd;
		refreshPlan(ctx.cwd); // parse + cache the active effort's plan (for the plan coordinator; NOT for todo seeding)
		// Loop restore (ticket 03) moved with the mechanism: ultracode's
		// session_start re-registers pending wakeups from the session branch.
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

	pi.on("session_shutdown", async () => {
		// The shared board's teardown lives with its owner (ext-subagent's
		// session_shutdown drops the TeamTaskStore); here only the display
		// state is disposed.
		goalOverlay.dispose();
		// The /loop mechanism lives in ultracode (ticket 03) and tears itself
		// down there; here only the display state is disposed.
		loopOverlay.dispose();
		todoOverlay.dispose();
		subagentsHandle.dispose();
		statusWidget.dispose();
	});

	pi.on("tool_execution_end", async (event) => {
		if (latestCwd && shouldRefreshAfterTool(event.toolName)) refreshPlan(latestCwd); // TB5a: re-parse only after a mutating tool (write/edit/bash)
		// Refresh the todo section after any successful task_* tool call — the
		// board may have changed. Names mirror ext-subagent's task tools (the
		// ONE model-visible task family, t02/D7); a local Set avoids a
		// cross-extension dependency for four string literals.
		if (!TASK_TOOL_NAMES.has(event.toolName) || event.isError) return;
		todoOverlay.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay.hideCompletedTasksFromPreviousTurn();
	});
};

export default extension;
