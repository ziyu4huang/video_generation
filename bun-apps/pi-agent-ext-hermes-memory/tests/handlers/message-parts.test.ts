import { describe, it } from "bun:test";
import assert from "node:assert";
import { collectMessageParts, collectSubagentOutputs } from "../../src/handlers/message-parts.js";

const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

describe("collectSubagentOutputs", () => {
  it("captures a subagent tool_result matched to a subagent toolCall by id", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "call_1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "call_1", content: "The subagent found X" }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), ["[SUBAGENT]: The subagent found X"]);
  });

  it("skips tool_results of non-subagent tools", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: "ls output" }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), []);
  });

  it("accepts the Anthropic tool_use variant for the producer block", () => {
    const entries = [
      msg("assistant", [{ type: "tool_use", id: "u1", name: "subagent", input: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "block output" }] }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), ["[SUBAGENT]: block output"]);
  });

  it("reads tool_result content whether it is a string or a text-block array", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "s", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "s", content: "plain string content" }]),
      msg("assistant", [{ type: "toolCall", id: "a", name: "subagent", arguments: {} }]),
      msg("user", [{
        type: "tool_result", tool_use_id: "a",
        content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), [
      "[SUBAGENT]: plain string content",
      "[SUBAGENT]: first\nsecond",
    ]);
  });

  it("does NOT truncate at the 500-char getMessageText cap (relaxed cap)", () => {
    const long = "a".repeat(600); // > 500 (getMessageText cap), < 4000 (subagent cap)
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: long }]),
    ];
    assert.strictEqual(collectSubagentOutputs(entries)[0], `[SUBAGENT]: ${long}`);
  });

  it("caps each output at SUBAGENT_OUTPUT_MAX_CHARS (4000)", () => {
    const long = "b".repeat(5000);
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: long }]),
    ];
    assert.strictEqual(collectSubagentOutputs(entries)[0].length, `[SUBAGENT]: `.length + 4000);
  });

  it("returns [] when there are no subagent calls", () => {
    assert.deepStrictEqual(
      collectSubagentOutputs([msg("user", "hi"), msg("assistant", [{ type: "text", text: "hello" }])]),
      [],
    );
  });

  it("ignores orphan tool_results whose producer is not in the branch", () => {
    assert.deepStrictEqual(
      collectSubagentOutputs([msg("user", [{ type: "tool_result", tool_use_id: "ghost", content: "orphan" }])]),
      [],
    );
  });

  it("captures multiple subagent outputs in branch order", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "a", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "a", content: "first" }]),
      msg("assistant", [{ type: "toolCall", id: "b", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "b", content: "second" }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), ["[SUBAGENT]: first", "[SUBAGENT]: second"]);
  });
});

describe("collectMessageParts (shared path — regression guard)", () => {
  it("still excludes tool_result blocks (subagent capture is the dedicated path)", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: "must NOT appear in shared path" }]),
      msg("user", [{ type: "text", text: "actual user text" }]),
    ];
    const parts = collectMessageParts(entries);
    assert.ok(!parts.some((p) => p.includes("must NOT appear")), "shared path must exclude tool_result");
    assert.ok(parts.some((p) => p.includes("actual user text")), "shared path keeps text blocks");
  });
});
