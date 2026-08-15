import { describe, expect, it } from "bun:test";
import { APPEXEC_FRAME, RENDER_SHELL_HTML } from "../src/render-shell.js";

/**
 * Phase 3 (spec Component 4): declarative-controls toolbar. The inline shell
 * script lives in an HTML string with no build/module step, so it is exercised
 * via (a) the pure APPEXEC_FRAME helper (the PINNED wire shape the inline
 * script duplicates) and (b) string-contains checks over RENDER_SHELL_HTML.
 *
 * A live DOM-behavior test (load the shell, render a view with controls, click
 * a button) is NOT feasible here: this package's test env has NO DOM (no
 * happy-dom/jsdom; `typeof document === "undefined"`), and the phase scope
 * forbids adding deps or a bunfig preload. Same fallback as the #03 prototype.
 */
describe("APPEXEC_FRAME pure helper", () => {
  it("builds the appexec respond frame with a tweak", () => {
    const f = APPEXEC_FRAME("pres-1", "revise", "warmer tones");
    expect(f).toEqual({
      type: "appexec",
      extra: { kind: "respond", id: "pres-1", action: "revise", tweak: "warmer tones" },
    });
  });

  it("omits the tweak key when the tweak is undefined", () => {
    const f = APPEXEC_FRAME("pres-1", "approve");
    expect(f).toEqual({
      type: "appexec",
      extra: { kind: "respond", id: "pres-1", action: "approve" },
    });
    expect("tweak" in f.extra).toBe(false);
  });

  it("omits the tweak key for an empty-string tweak (shell sends t || undefined)", () => {
    const f = APPEXEC_FRAME("pres-1", "regenerate", "");
    expect("tweak" in f.extra).toBe(false);
  });
});

describe("RENDER_SHELL_HTML — declarative HITL response wiring (phase 3)", () => {
  it("defines sendAppexecResponse with the respond wire shape", () => {
    expect(RENDER_SHELL_HTML).toContain("function sendAppexecResponse");
    expect(RENDER_SHELL_HTML).toContain("kind: 'respond'");
    expect(RENDER_SHELL_HTML).toContain("type: 'appexec'");
  });

  it("sends via JSON.stringify; queues instead of dropping when the ws is not OPEN (v2 send queue)", () => {
    expect(RENDER_SHELL_HTML).toContain("JSON.stringify");
    expect(RENDER_SHELL_HTML).toContain("ws.send");
    expect(RENDER_SHELL_HTML).toContain("WebSocket.OPEN");
    // v2 (architecture v2 §3.6): a non-OPEN socket QUEUES the frame (flushed on
    // open) instead of logging-and-dropping it — a HITL answer must survive a
    // reconnect.
    expect(RENDER_SHELL_HTML).toContain("wsQueue.push(payload)");
    expect(RENDER_SHELL_HTML).toContain("sendAppexecResponse");
  });

  it("defines renderControls and calls it from renderView (both content branches)", () => {
    expect(RENDER_SHELL_HTML).toContain("function renderControls");
    expect(RENDER_SHELL_HTML).toContain("renderControls(v);");
    expect(RENDER_SHELL_HTML).toContain("takesInput");
    expect(RENDER_SHELL_HTML).toContain("webui-toolbar");
  });

  it("enforces one response per presentation (disable + mark chosen)", () => {
    expect(RENDER_SHELL_HTML).toContain("respondedPresent");
    expect(RENDER_SHELL_HTML).toContain("webui-chosen");
    expect(RENDER_SHELL_HTML).toContain("disabled = true");
  });

  it("auto-focuses a presenting view in the SSE handler without changing the payload shape", () => {
    expect(RENDER_SHELL_HTML).toContain("v.presentId");
    expect(RENDER_SHELL_HTML).toContain("location.hash = data.viewId");
    // payload stays {viewId, updatedAt} — the handler only reads data.viewId
    expect(RENDER_SHELL_HTML).toContain("data.viewId");
  });

  it("reconnects the ws with a 2s guarded backoff (mirrors the SSE pattern)", () => {
    expect(RENDER_SHELL_HTML).toContain("function connectWs");
    expect(RENDER_SHELL_HTML).toContain("function scheduleWsRetry");
    expect(RENDER_SHELL_HTML).toContain("2000");
    expect(RENDER_SHELL_HTML).toContain("wsRetryTimer !== null");
    expect(RENDER_SHELL_HTML).toContain("connectWs()");
  });

  it("keeps the response log panel with a clear link", () => {
    expect(RENDER_SHELL_HTML).toContain("webui-feedback-log");
    expect(RENDER_SHELL_HTML).toContain("webui-log-clear");
    expect(RENDER_SHELL_HTML).toContain("response log");
    expect(RENDER_SHELL_HTML).toContain("function logResponse");
  });

  it("removes the dead #03 prototype (per-image DOM sniffing + steer prose)", () => {
    expect(RENDER_SHELL_HTML).not.toContain("attachFeedbackToolbars");
    expect(RENDER_SHELL_HTML).not.toContain("STEER_FRAME");
    expect(RENDER_SHELL_HTML).not.toContain("APPROVE_TEXT");
    expect(RENDER_SHELL_HTML).not.toContain("REGENERATE_TEXT");
    expect(RENDER_SHELL_HTML).not.toContain("sendSteer");
    expect(RENDER_SHELL_HTML).not.toContain("logSteer");
    expect(RENDER_SHELL_HTML).not.toContain("type: 'steer'");
    expect(RENDER_SHELL_HTML).not.toContain("basenameOf");
    expect(RENDER_SHELL_HTML).not.toContain("Regenerate");
  });

  it("still opens the existing /ws inbound channel", () => {
    expect(RENDER_SHELL_HTML).toContain("/ws");
    expect(RENDER_SHELL_HTML).toContain("new WebSocket");
  });

  it("still preserves the original shell contract (tabs/content/sse/sandbox)", () => {
    expect(RENDER_SHELL_HTML).toContain("<!-- webui-render-shell -->");
    expect(RENDER_SHELL_HTML).toContain("<!doctype html>");
    expect(RENDER_SHELL_HTML).toContain('id="tabs"');
    expect(RENDER_SHELL_HTML).toContain('id="content"');
    expect(RENDER_SHELL_HTML).toContain("EventSource('/api/events')");
    expect(RENDER_SHELL_HTML).toContain("setAttribute('sandbox', '')");
  });
});
