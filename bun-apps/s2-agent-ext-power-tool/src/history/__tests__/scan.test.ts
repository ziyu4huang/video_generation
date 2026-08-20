/**
 * Tests for the transcript scanner.
 *
 * parseSessionLines is PURE over an array of raw JSONL lines — no filesystem —
 * so the whole parser is exercised with inline fixtures.
 */
import { test, expect, describe } from "bun:test";
import { parseSessionLines } from "../scan.ts";

/** Build one JSONL line for a `session` header event. */
function sessionLine(cwd: string, ts: string): string {
  return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: ts, cwd });
}

/** Build one JSONL line for an assistant message carrying toolCall blocks. */
function assistantLine(
  ts: string,
  calls: Array<{ id: string; name: string; arguments?: unknown }>,
): string {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments })),
    },
  });
}

/** Build one JSONL line for a toolResult message. */
function resultLine(ts: string, callId: string, toolName: string, isError = false): string {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "toolResult", toolCallId: callId, toolName, isError },
  });
}

describe("parseSessionLines", () => {
  test("reads cwd and startedAt from the session event", () => {
    const scan = parseSessionLines([sessionLine("/repo/x", "2026-08-01T00:00:00.000Z")]);
    expect(scan.cwd).toBe("/repo/x");
    expect(scan.startedAt).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  test("pairs a toolCall with its toolResult by callId", () => {
    const scan = parseSessionLines([
      sessionLine("/repo/x", "2026-08-01T00:00:00.000Z"),
      assistantLine("2026-08-01T00:00:01.000Z", [{ id: "c1", name: "bash" }]),
      resultLine("2026-08-01T00:00:03.000Z", "c1", "bash"),
    ]);
    expect(scan.calls).toHaveLength(1);
    expect(scan.calls[0]!.callId).toBe("c1");
    expect(scan.results).toHaveLength(1);
    expect(scan.results[0]!.t1 - scan.calls[0]!.t0).toBe(2000);
  });

  test("skips malformed lines instead of throwing", () => {
    const scan = parseSessionLines([
      "{not json",
      "",
      sessionLine("/repo/x", "2026-08-01T00:00:00.000Z"),
    ]);
    expect(scan.cwd).toBe("/repo/x");
  });

  test("gives a toolResult without a callId a non-pairing synthetic id", () => {
    const scan = parseSessionLines([
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-01T00:00:01.000Z",
        message: { role: "toolResult", toolName: "bash", isError: true },
      }),
    ]);
    expect(scan.results).toHaveLength(1);
    expect(scan.results[0]!.callId).toContain("__orphan__");
    expect(scan.results[0]!.isError).toBe(true);
  });
});

describe("parseSessionLines — widened fields", () => {
  test("captures toolCall arguments", () => {
    const scan = parseSessionLines([
      assistantLine("2026-08-01T00:00:01.000Z", [
        { id: "c1", name: "bash", arguments: { cmd: "ls" } },
      ]),
    ]);
    expect(scan.calls[0]!.args).toEqual({ cmd: "ls" });
  });

  test("records the highest observed totalTokens", () => {
    const line = (total: number) =>
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-01T00:00:01.000Z",
        message: { role: "assistant", content: [], usage: { totalTokens: total } },
      });
    const scan = parseSessionLines([line(100), line(900), line(400)]);
    expect(scan.maxTotalTokens).toBe(900);
  });

  test("counts assistant messages as the turn-count proxy", () => {
    const scan = parseSessionLines([
      assistantLine("2026-08-01T00:00:01.000Z", []),
      assistantLine("2026-08-01T00:00:02.000Z", []),
      resultLine("2026-08-01T00:00:03.000Z", "c1", "bash"),
    ]);
    expect(scan.assistantMessages).toBe(2);
  });

  test("takes provider and modelId from the last model_change", () => {
    const mc = (provider: string, modelId: string) =>
      JSON.stringify({
        type: "model_change",
        timestamp: "2026-08-01T00:00:00.000Z",
        provider,
        modelId,
      });
    const scan = parseSessionLines([mc("zai", "glm-5.2"), mc("anthropic", "claude-opus-5")]);
    expect(scan.provider).toBe("anthropic");
    expect(scan.modelId).toBe("claude-opus-5");
  });

  test("leaves maxTotalTokens at 0 when no usage is present", () => {
    const scan = parseSessionLines([assistantLine("2026-08-01T00:00:01.000Z", [])]);
    expect(scan.maxTotalTokens).toBe(0);
  });
});
