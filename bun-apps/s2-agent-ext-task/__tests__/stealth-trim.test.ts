/**
 * stealth-trim.test.ts — regression guard: the `goal_complete` tool must stay
 * free of per-turn `promptSnippet`/`promptGuidelines`. Its rich `description`
 * already routes the model.
 *
 * ext-task's factory is heavy (overlays/widgets/globalThis/6 lifecycle hooks),
 * so rather than drive the full factory we capture the tool via its own
 * registration function (`goal()`) with a Proxy mock pi + overlay (swallows
 * any extra method calls).
 *
 * The `todo` tool was retired (cc-parity-task-powertool t02/D7); the
 * stealth-trim pin for the surviving task family (task_create/get/list/update,
 * ext-subagent) lives in s2-agent-ext-subagent/tests/task-tools.test.ts.
 */
import { test, expect } from "bun:test";
import goal from "../src/goal/goal.ts";

/** Run `fn` with a Proxy mock pi that captures the single registered tool. */
function captureViaRegister(fn: (pi: unknown) => void): Record<string, unknown> | undefined {
	let captured: Record<string, unknown> | undefined;
	const pi = new Proxy(
		{
			registerTool: (t: Record<string, unknown>) => {
				captured = t;
			},
		},
		{
			get(target, prop) {
				return prop in target ? Reflect.get(target, prop) : () => {};
			},
		},
	);
	fn(pi);
	return captured;
}

function captureGoalComplete(): Record<string, unknown> | undefined {
	// GoalOverlayLike needs setUICtx/update/showCompletion/dispose — Proxy covers all.
	const overlay = new Proxy(
		{},
		{ get: () => () => {} },
	);
	return captureViaRegister((pi) => goal(pi as never, overlay as never));
}

test("goal_complete tool is stealth-trimmed: no promptSnippet/guidelines", () => {
	const t = captureGoalComplete();
	expect(t).toBeDefined();
	expect(typeof t!.description).toBe("string");
	expect(String(t!.description).length).toBeGreaterThan(0);
	expect(t!.promptSnippet).toBeUndefined();
	expect(t!.promptGuidelines).toBeUndefined();
});
