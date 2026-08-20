/**
 * Owner-declaration test for ext-task's three core tools.
 *
 * Each of `ask_user_question`, `todo`, `goal_complete` must carry an
 * owner-declared `gating: { core: true }` so tool-gate treats them as
 * always-active authoritatively (not merely via its hardcoded CORE_TOOLS
 * fallback). The test invokes each REAL registrar with a stub `pi` whose
 * `registerTool` captures the def, then asserts `def.gating?.core === true`.
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

type RegisteredTool = { name: string; gating?: { core?: boolean } };

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

describe("ext-task core tools declare gating:{core:true}", () => {
  test("ask_user_question is owner-declared core", () => {
    const { pi, registered } = makeStubPi();
    registerAskUserQuestionTool(pi);
    const t = registered.find((x) => x.name === "ask_user_question");
    expect(t, "ask_user_question tool was registered").toBeDefined();
    expect(t?.gating?.core).toBe(true);
  });

  test("todo is owner-declared core", () => {
    const { pi, registered } = makeStubPi();
    registerTodoTool(pi);
    const t = registered.find((x) => x.name === "todo");
    expect(t, "todo tool was registered").toBeDefined();
    expect(t?.gating?.core).toBe(true);
  });

  test("goal_complete is owner-declared core", () => {
    const { pi, registered } = makeStubPi();
    goalDefault(pi);
    const t = registered.find((x) => x.name === "goal_complete");
    expect(t, "goal_complete tool was registered").toBeDefined();
    expect(t?.gating?.core).toBe(true);
  });
});
