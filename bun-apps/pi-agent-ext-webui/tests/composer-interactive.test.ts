/**
 * composer-interactive.test.ts — the click-interception gate (2026-08-18
 * incident): the fixed #webui-feedback-log overlay (z-index 50, bottom-right)
 * sat ON TOP of the restored composer — #webui-send was visible+enabled but
 * UNCLICKABLE (playwright: "subtree intercepts pointer events", 58 retries).
 * Doctrine fix: the composer is the PRIMARY input and always wins the corner
 * (positioned, z 60); the log — a HITL trace — collapses to its head by
 * default and expands on click. Literal pins; the playwright lifecycle E2E
 * is the behavioral proof.
 */
import { describe, expect, test } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";

describe("composer vs feedback-log stacking", () => {
  test("composer is positioned and stacked ABOVE the log overlay (z 60 > 50)", () => {
    expect(RENDER_SHELL_HTML).toContain("#composer { display: flex; gap: .4rem; padding: .5rem 1rem; border-top: 1px solid #8884; max-width: 1500px; margin: 0 auto; width: 100%; box-sizing: border-box; position: relative; z-index: 60;");
  });

  test("the log ships COLLAPSED by default with a toggle (trace demoted, primary input unblocked)", () => {
    expect(RENDER_SHELL_HTML).toContain('<div id="webui-feedback-log" class="collapsed">');
    expect(RENDER_SHELL_HTML).toContain("#webui-feedback-log.collapsed #webui-feedback-log-body { display: none; }");
    expect(RENDER_SHELL_HTML).toContain("classList.toggle('collapsed')");
    expect(RENDER_SHELL_HTML).toContain("webui-log-clear"); // the clear link survives
  });
});
