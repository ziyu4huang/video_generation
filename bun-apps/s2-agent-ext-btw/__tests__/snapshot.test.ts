// bun-apps/s2-agent-ext-btw/__tests__/snapshot.test.ts
import { describe, expect, it } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BtwDetails } from "../src/btw/types";
import { snapshotsFromDetails, snapshotsFromMessages, statusFromEvent } from "../src/btw/snapshot";

const ev = (partial: Record<string, unknown>): AgentSessionEvent =>
  partial as unknown as AgentSessionEvent;

const details: BtwDetails[] = [
  {
    question: "what failed?",
    thinking: "",
    answer: "the shader compile step",
    provider: "anthropic",
    model: "claude-sonnet-4",
    api: "anthropic",
    thinkingLevel: "off",
    timestamp: 1,
  },
];

describe("snapshotsFromDetails", () => {
  it("maps persisted BtwDetails to stable keyed snapshots", () => {
    expect(snapshotsFromDetails(details)).toEqual([
      { id: "btw-d-0", role: "user", text: "what failed?", status: "done" },
      { id: "btw-d-1", role: "assistant", text: "the shader compile step", status: "done" },
    ]);
  });

  it("returns an empty array for an empty thread", () => {
    expect(snapshotsFromDetails([])).toEqual([]);
  });
});

describe("statusFromEvent", () => {
  it("maps tool lifecycle events to running-tool status", () => {
    expect(statusFromEvent(ev({ type: "tool_execution_start", toolName: "bash" }))).toEqual({
      status: "running-tool",
      statusText: "running-tool: bash",
    });
    expect(statusFromEvent(ev({ type: "tool_execution_start" }))).toEqual({
      status: "running-tool",
      statusText: "running-tool: tool",
    });
  });

  it("maps turn lifecycle back to streaming/done", () => {
    expect(statusFromEvent(ev({ type: "tool_execution_end" }))).toEqual({ status: "streaming" });
    expect(statusFromEvent(ev({ type: "turn_end" }))).toEqual({ status: "done" });
  });

  it("returns null for events that do not change status", () => {
    expect(statusFromEvent(ev({ type: "message_update" }))).toBeNull();
    expect(statusFromEvent(ev({ type: "turn_start" }))).toBeNull();
  });
});

describe("snapshotsFromMessages", () => {
  it("derives keyed snapshots, folding the status override into the last message", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "partial answer" }] },
    ] as unknown as Parameters<typeof snapshotsFromMessages>[0];
    expect(
      snapshotsFromMessages(messages, { status: "running-tool", statusText: "running-tool: bash" }),
    ).toEqual([
      { id: "btw-m-0", role: "user", text: "q", status: "done" },
      {
        id: "btw-m-1",
        role: "assistant",
        text: "partial answer",
        status: "running-tool",
        statusText: "running-tool: bash",
      },
    ]);
  });

  it("defaults the last live message to streaming when no override is set", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "a" }] },
    ] as unknown as Parameters<typeof snapshotsFromMessages>[0];
    expect(snapshotsFromMessages(messages, null)).toEqual([
      { id: "btw-m-0", role: "user", text: "q", status: "done" },
      { id: "btw-m-1", role: "assistant", text: "a", status: "streaming" },
    ]);
  });
});
