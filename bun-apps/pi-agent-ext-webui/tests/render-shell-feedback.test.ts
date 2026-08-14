import { describe, expect, it } from "bun:test";
import {
  APPROVE_TEXT,
  REGENERATE_TEXT,
  RENDER_SHELL_HTML,
  STEER_FRAME,
} from "../src/render-shell.js";

/**
 * zk-spawn prototype tests (#03, interactive-webui-v2): shell-hosted feedback
 * toolbar. The inline shell script lives in an HTML string with no build/module
 * step, so it is exercised via (a) the pure steer-formulation helpers (the
 * PINNED shapes the inline script duplicates) and (b) string-contains checks
 * over RENDER_SHELL_HTML for the toolbar / ws / log wiring.
 *
 * A live DOM-behavior test (load the shell, inject an <img> into #content, call
 * attachFeedbackToolbars, assert an [Approve] control) is NOT feasible here:
 * this package's test env has NO DOM (no happy-dom/jsdom; `typeof document ===
 * "undefined"`), and the task scope forbids adding deps or a bunfig preload.
 * Per the task's fallback note we rely on the string + pure-helper assertions.
 */
describe("steer formulation pure helpers", () => {
  it("STEER_FRAME builds a { type: 'steer' } frame", () => {
    const f = STEER_FRAME("x");
    expect(f.type).toBe("steer");
    expect(f.text).toBe("x");
  });

  it("APPROVE_TEXT matches the pinned Approve formulation", () => {
    expect(APPROVE_TEXT("cat.png")).toBe(
      "Approved: image cat.png looks good, no changes needed.",
    );
  });

  it("REGENERATE_TEXT with a tweak includes the tweak", () => {
    expect(REGENERATE_TEXT("cat.png", "warmer tones")).toBe(
      "Regenerate image cat.png with: warmer tones",
    );
  });

  it("REGENERATE_TEXT with an empty tweak omits the 'with:' clause", () => {
    expect(REGENERATE_TEXT("cat.png", "")).toBe("Regenerate image cat.png.");
  });
});

describe("RENDER_SHELL_HTML — feedback toolbar wiring (zk-spawn)", () => {
  it("opens the existing /ws inbound channel", () => {
    expect(RENDER_SHELL_HTML).toContain("/ws");
    expect(RENDER_SHELL_HTML).toContain("new WebSocket");
  });

  it("defines attachFeedbackToolbars and calls it after md injection", () => {
    expect(RENDER_SHELL_HTML).toContain("function attachFeedbackToolbars");
    expect(RENDER_SHELL_HTML).toContain("attachFeedbackToolbars(contentEl)");
  });

  it("renders an Approve control", () => {
    // The inline script builds a <button> with textContent 'Approve'.
    expect(RENDER_SHELL_HTML).toContain("Approve");
  });

  it("renders a Regenerate control", () => {
    expect(RENDER_SHELL_HTML).toContain("Regenerate");
  });

  it("has the on-screen steer log panel with a clear link", () => {
    expect(RENDER_SHELL_HTML).toContain("webui-feedback-log");
    expect(RENDER_SHELL_HTML).toContain("webui-log-clear");
  });

  it("sends steer frames via JSON.stringify and guards against a non-OPEN ws", () => {
    expect(RENDER_SHELL_HTML).toContain("type: 'steer'");
    expect(RENDER_SHELL_HTML).toContain("JSON.stringify");
    expect(RENDER_SHELL_HTML).toContain("ws.send");
    expect(RENDER_SHELL_HTML).toContain("WebSocket.OPEN");
    expect(RENDER_SHELL_HTML).toContain("ws not open");
  });

  it("still preserves the original shell contract (tabs/content/sse/sandbox)", () => {
    expect(RENDER_SHELL_HTML).toContain("<!-- webui-render-shell -->");
    expect(RENDER_SHELL_HTML).toContain('id="tabs"');
    expect(RENDER_SHELL_HTML).toContain('id="content"');
    expect(RENDER_SHELL_HTML).toContain("EventSource('/api/events')");
    expect(RENDER_SHELL_HTML).toContain("setAttribute('sandbox', '')");
  });
});
