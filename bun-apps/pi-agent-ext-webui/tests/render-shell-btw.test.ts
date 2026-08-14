import { describe, expect, it } from "bun:test";
import { BTW_FRAME, BTW_MESSAGE_HTML, RENDER_SHELL_HTML } from "../src/render-shell";

describe("RENDER_SHELL_HTML btw panel scaffold", () => {
  it("embeds the btw side panel structure", () => {
    expect(RENDER_SHELL_HTML).toContain('id="btw-panel"');
    expect(RENDER_SHELL_HTML).toContain('id="btw-messages"');
    expect(RENDER_SHELL_HTML).toContain('id="btw-input"');
    for (const id of ["btw-collapse", "btw-ask", "btw-new", "btw-clear", "btw-inject", "btw-summarize", "btw-mode", "btw-model", "btw-thinking"]) {
      expect(RENDER_SHELL_HTML).toContain(`id="${id}"`);
    }
  });

  it("uses the agreed localStorage key for the collapse state", () => {
    expect(RENDER_SHELL_HTML).toContain("btw-panel-collapsed");
  });
});

describe("BTW_FRAME pure helper", () => {
  it("builds flat btw command frames", () => {
    expect(BTW_FRAME("ask", { text: "hi" })).toEqual({ type: "btw", kind: "ask", text: "hi" });
    expect(BTW_FRAME("mode", { mode: "tangent" })).toEqual({ type: "btw", kind: "mode", mode: "tangent" });
  });

  it("omits the extra keys entirely when none are given", () => {
    const f = BTW_FRAME("clear");
    expect(f).toEqual({ type: "btw", kind: "clear" });
    expect("text" in f).toBe(false);
  });
});

describe("RENDER_SHELL_HTML btw client logic", () => {
  it("ships the first inbound ws handler for btw frames", () => {
    expect(RENDER_SHELL_HTML).toContain("ws.onmessage");
    expect(RENDER_SHELL_HTML).toContain('frame.type === "btw"');
  });

  it("pulls the thread snapshot and model list on load (pull-then-subscribe)", () => {
    expect(RENDER_SHELL_HTML).toContain("fetch('/api/btw')");
    expect(RENDER_SHELL_HTML).toContain("fetch('/api/btw/models')");
  });

  it("sends btw commands over the existing /ws socket", () => {
    expect(RENDER_SHELL_HTML).toContain("sendBtw(");
    expect(RENDER_SHELL_HTML.split("new WebSocket(").length - 1).toBe(1); // exactly one construction site
  });

  it("keeps the SSE refresh loop as-is", () => {
    expect(RENDER_SHELL_HTML).toContain("new EventSource('/api/events')");
  });
});

describe("BTW_MESSAGE_HTML pure helper", () => {
  it("renders a snapshot row keyed by id with escaped text", () => {
    const html = BTW_MESSAGE_HTML({ id: "btw-m-1", role: "assistant", text: "a < b", status: "done" });
    expect(html).toContain('data-id="btw-m-1"');
    expect(html).toContain("a &lt; b");
    expect(html).not.toContain("btw-status");
  });

  it("renders the status line for non-done snapshots", () => {
    const html = BTW_MESSAGE_HTML({
      id: "btw-m-1",
      role: "assistant",
      text: "ans",
      status: "running-tool",
      statusText: "running-tool: bash",
    });
    expect(html).toContain("btw-status");
    expect(html).toContain("running-tool: bash");
  });
});
