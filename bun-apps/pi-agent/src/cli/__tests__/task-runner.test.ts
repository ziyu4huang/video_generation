/**
 * task-runner.ts — runPrettyTask + runJsonTask.
 *
 * The runners expose the (otherwise private) verbosity formatters: summarizeArgs
 * (priority keys), summarizeResult (string/array/{text|content|message|error}
 * shapes), trunc, and the level-0/1/2 [tool]/[tool done] line shapes. We drive
 * them with a fake TaskSession that emits a scripted event sequence and capture
 * stdout/stderr. No network.
 *
 *   bun test src/cli/__tests__/task-runner.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runPrettyTask, runJsonTask, type TaskSession } from "../sessions/task-runner.ts";

// --- stdout / stderr capture ------------------------------------------------
let out = "";
let err = "";
let origWrite: typeof process.stdout.write;
let origErr: (...a: unknown[]) => void;
let origLog: (...a: unknown[]) => void;

beforeEach(() => {
  out = "";
  err = "";
  origWrite = process.stdout.write.bind(process.stdout);
  origErr = console.error;
  origLog = console.log;
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
});
afterEach(() => {
  process.stdout.write = origWrite;
  console.error = origErr;
  console.log = origLog;
});

/**
 * Build a fake TaskSession whose prompt() replays a scripted event list to the
 * subscriber (the runner subscribes before calling prompt).
 */
function fakeSession(events: any[], throwOnPrompt?: () => never): TaskSession {
  let sub: ((e: any) => void) | null = null;
  return {
    subscribe: (fn) => {
      sub = fn;
      return () => {
        sub = null;
      };
    },
    prompt: async () => {
      if (throwOnPrompt) throwOnPrompt();
      for (const e of events) sub?.(e);
    },
  };
}

const text = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});
const toolStart = (toolName: string, args: unknown, toolCallId = "c1") => ({
  type: "tool_execution_start",
  toolName,
  toolCallId,
  args,
});
const toolEnd = (
  toolName: string,
  result: unknown,
  isError = false,
  toolCallId = "c1",
) => ({
  type: "tool_execution_end",
  toolName,
  toolCallId,
  result,
  isError,
});

describe("runPrettyTask — text + footer", () => {
  test("streams text_delta to stdout and writes the done footer", async () => {
    await runPrettyTask(
      fakeSession([text("hello "), text("world")]),
      "task",
      "Distill",
    );
    expect(out).toContain("hello world");
    expect(out).toContain("--- Distill done ---");
  });
});

describe("runPrettyTask — tool lines by verbosity", () => {
  test("verbose 0: name only on start, (ok) on end", async () => {
    await runPrettyTask(
      fakeSession([
        toolStart("obsidian_read", { path: "/x" }),
        toolEnd("obsidian_read", "ok-text"),
      ]),
      "task",
      "X",
      0,
    );
    expect(err).toContain("[tool] obsidian_read");
    expect(err).toContain("[tool done] obsidian_read (ok)");
    // No args summary at level 0.
    expect(err).not.toContain("path=");
  });

  test("verbose 1: start carries a priority-key summary; end stays terse", async () => {
    await runPrettyTask(
      fakeSession([
        toolStart("obsidian_search", { query: "foo", limit: 5, junk: "x".repeat(300) }),
        toolEnd("obsidian_search", [{ n: 1 }]),
      ]),
      "task",
      "X",
      1,
    );
    expect(err).toContain("[tool] obsidian_search");
    expect(err).toContain("query=\"foo\"");
    // limit is not a priority key → must NOT appear as key=value.
    expect(err).not.toMatch(/limit=/);
    // junk is also not priority → dropped.
    expect(err).not.toContain("junk=");
  });

  test("verbose 2: start dumps full args JSON + end shows a result preview", async () => {
    await runPrettyTask(
      fakeSession([
        toolStart("t", { a: 1, b: 2 }),
        toolEnd("t", { content: "the result body" }),
      ]),
      "task",
      "X",
      2,
    );
    expect(err).toContain('"a":1');
    expect(err).toContain('"b":2');
    expect(err).toContain("[tool done] t (ok)");
    expect(err).toContain("the result body");
  });

  test("error end is tagged (err)", async () => {
    await runPrettyTask(
      fakeSession([toolEnd("t", "boom", true)]),
      "task",
      "X",
      0,
    );
    expect(err).toContain("[tool done] t (err)");
  });

  test("priority-key selection picks up to 3, query/question/etc. ordered first", async () => {
    await runPrettyTask(
      fakeSession([
        toolStart("t", {
          query: "q",
          question: "qn",
          note: "n",
          path: "p",
        }),
      ]),
      "task",
      "X",
      1,
    );
    // query + question + note are the first three priority keys present.
    expect(err).toContain("query=");
    expect(err).toContain("question=");
    expect(err).toContain("note=");
    // path is the 4th → dropped by the 3-cap.
    expect(err).not.toMatch(/\bpath=/);
  });

  test("long string arg is truncated with an ellipsis", async () => {
    await runPrettyTask(
      fakeSession([toolStart("t", { query: "x".repeat(300) })]),
      "task",
      "X",
      1,
    );
    expect(err).toContain("…");
  });

  test("result summarizeResult: array shape → 'N item(s): [head …]'", async () => {
    await runPrettyTask(
      fakeSession([toolEnd("t", [1, 2, 3])]),
      "task",
      "X",
      2,
    );
    expect(err).toContain("3 item(s):");
    expect(err).toContain("…");
  });

  test("result summarizeResult: object without textish → compact JSON", async () => {
    await runPrettyTask(
      fakeSession([toolEnd("t", { count: 5, ok: true })]),
      "task",
      "X",
      2,
    );
    expect(err).toContain('"count":5');
  });
});

// --- JSON mode --------------------------------------------------------------

describe("runJsonTask — NDJSON shape", () => {
  test("verbose 0: echoes message_update + emits message_end; tool events omit args/result", async () => {
    await runJsonTask(
      fakeSession([
        text("hi "),
        text("there"),
        toolStart("t", { secret: 1 }),
        toolEnd("t", "big result"),
      ]),
      "task",
      0,
    );
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);
    expect(types).toEqual([
      "message_update",
      "message_update",
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
    ]);
    // message_end carries the accumulated assistant text.
    const end = lines[lines.length - 1]!;
    expect(end.message.content[0].text).toBe("hi there");
    // verbose 0 → no args/result on tool events.
    const start = lines.find((l) => l.type === "tool_execution_start")!;
    expect(start.args).toBeUndefined();
    const tend = lines.find((l) => l.type === "tool_execution_end")!;
    expect(tend.result).toBeUndefined();
    expect(tend.isError).toBe(false);
  });

  test("verbose 1: tool_end result is summarized (capped), tool_start has args", async () => {
    await runJsonTask(
      fakeSession([
        toolStart("t", { q: 1 }),
        toolEnd("t", "x".repeat(500)),
      ]),
      "task",
      1,
    );
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    const start = lines.find((l) => l.type === "tool_execution_start")!;
    expect(start.args).toEqual({ q: 1 });
    const tend = lines.find((l) => l.type === "tool_execution_end")!;
    // level-1 result is summarized + capped → shorter than the raw 500 chars.
    expect(typeof tend.result).toBe("string");
    expect(tend.result.length).toBeLessThan(500);
    expect(tend.result.endsWith("…")).toBe(true);
  });

  test("verbose 2: tool_end carries the FULL result object", async () => {
    const big = { deep: { nested: "x".repeat(50) } };
    await runJsonTask(
      fakeSession([toolEnd("t", big)]),
      "task",
      2,
    );
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    const tend = lines.find((l) => l.type === "tool_execution_end")!;
    expect(tend.result).toEqual(big);
  });

  test("prompt throwing → emits a {type:'error'} line, then re-throws", async () => {
    await expect(
      runJsonTask(fakeSession([], () => { throw new Error("model 500"); }), "task", 0),
    ).rejects.toThrow("model 500");
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    const errLine = lines[lines.length - 1]!;
    expect(errLine.type).toBe("error");
    expect(errLine.message).toBe("model 500");
  });
});
