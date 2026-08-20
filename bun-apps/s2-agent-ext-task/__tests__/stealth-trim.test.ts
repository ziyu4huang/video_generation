/**
 * stealth-trim.test.ts — regression guard: the `todo` and `goal_complete`
 * tools must stay free of per-turn `promptSnippet`/`promptGuidelines`. Their
 * rich `description`s already route the model.
 *
 * ext-task's factory is heavy (overlays/widgets/globalThis/6 lifecycle hooks),
 * so rather than drive the full factory we capture each tool via its own
 * registration function (`registerTodoTool`, `goal()`) with Proxy mock pi +
 * overlay (swallows any extra method calls).
 */
import { test, expect } from "bun:test";
import { registerTodoTool } from "../src/todo/todo.ts";
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

function captureTodo(): Record<string, unknown> | undefined {
	return captureViaRegister((pi) => registerTodoTool(pi as never));
}

function captureGoalComplete(): Record<string, unknown> | undefined {
	// GoalOverlayLike needs setUICtx/update/showCompletion/dispose — Proxy covers all.
	const overlay = new Proxy(
		{},
		{ get: () => () => {} },
	);
	return captureViaRegister((pi) => goal(pi as never, overlay as never));
}

test("todo tool is stealth-trimmed: no promptSnippet/guidelines", () => {
	const t = captureTodo();
	expect(t).toBeDefined();
	expect(typeof t!.description).toBe("string");
	expect(String(t!.description).length).toBeGreaterThan(0);
	expect(t!.promptSnippet).toBeUndefined();
	expect(t!.promptGuidelines).toBeUndefined();
});

test("goal_complete tool is stealth-trimmed: no promptSnippet/guidelines", () => {
	const t = captureGoalComplete();
	expect(t).toBeDefined();
	expect(typeof t!.description).toBe("string");
	expect(String(t!.description).length).toBeGreaterThan(0);
	expect(t!.promptSnippet).toBeUndefined();
	expect(t!.promptGuidelines).toBeUndefined();
});
