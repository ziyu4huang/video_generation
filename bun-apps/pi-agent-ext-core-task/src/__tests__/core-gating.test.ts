/**
 * Owner-declaration test for core-task's three tools.
 *
 * After ticket #5 (slim core-task always-on footprint):
 *   - `goal_complete` MUST carry `gating: { core: true }` (always-active; 99 tok,
 *     negligible, stays core).
 *   - `ask_user_question` and `todo` are now KEYWORD-GATED (moved out of
 *     `core:true` to slim the per-turn always-on schema — the two heaviest
 *     core-task tools, ~604 / ~448 tok, which also compound to every spawned
 *     child via the threaded active set). They carry a non-empty `keywords`
 *     gate (NOT core) and are recovered via `enable_tool` on a miss.
 *
 * The test invokes each REAL registrar with a stub `pi` whose `registerTool`
 * captures the def, then asserts the gating shape above.
 *
 * Registrars (resolved by grepping the source):
 *   - ask_user_question → registerAskUserQuestionTool (src/ask-user/ask-user-question.ts)
 *   - todo              → registerTodoTool             (src/todo/todo.ts)
 *   - goal_complete     → default export `goal`        (src/goal/goal.ts;
 *                        registers the `goalCompleteTool` defineTool literal)
 */
import { describe, expect, test } from "bun:test";
import { registerAskUserQuestionTool } from "../ask-user/ask-user-question.ts";
import { registerTodoTool } from "../todo/todo.ts";
import goalDefault from "../goal/goal.ts";

type RegisteredTool = { name: string; gating?: { core?: boolean; keywords?: string[] } };

/** Stub pi: `registerTool` captures every def; everything else is a no-op. */
function makeStubPi(): { pi: any; registered: RegisteredTool[] } {
	const registered: RegisteredTool[] = [];
	const pi = {
		registerTool: (t: RegisteredTool) => {
			registered.push(t);
		},
		registerCommand: () => {},
		on: () => () => {},
		appendEntry: () => {},
		setActiveTools: () => {},
		getActiveTools: () => [],
		sendUserMessage: () => {},
		events: { emit: () => {} },
	};
	return { pi, registered };
}

describe("core-task tools: goal_complete core; ask_user_question + todo keyword-gated (#5)", () => {
	test("ask_user_question is keyword-gated (not core)", () => {
		const { pi, registered } = makeStubPi();
		registerAskUserQuestionTool(pi);
		const t = registered.find((x) => x.name === "ask_user_question");
		expect(t, "ask_user_question tool was registered").toBeDefined();
		expect(t?.gating?.core, "ask_user_question is no longer core (#5)").not.toBe(true);
		expect(t?.gating?.keywords?.length, "ask_user_question carries a non-empty keyword gate").toBeGreaterThan(0);
	});

	test("todo is keyword-gated (not core)", () => {
		const { pi, registered } = makeStubPi();
		registerTodoTool(pi);
		const t = registered.find((x) => x.name === "todo");
		expect(t, "todo tool was registered").toBeDefined();
		expect(t?.gating?.core, "todo is no longer core (#5)").not.toBe(true);
		expect(t?.gating?.keywords?.length, "todo carries a non-empty keyword gate").toBeGreaterThan(0);
	});

	test("goal_complete is owner-declared core", () => {
		const { pi, registered } = makeStubPi();
		goalDefault(pi);
		const t = registered.find((x) => x.name === "goal_complete");
		expect(t, "goal_complete tool was registered").toBeDefined();
		expect(t?.gating?.core).toBe(true);
	});
});
