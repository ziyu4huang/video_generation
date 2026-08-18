/**
 * feed-filter.test.ts — webui-readability G4: find-across-turns. The Inbox
 * feed is append-only; this pins the client-side filter contract: a substring
 * input + kind chips (all/text/cards) hide non-matching chat rows and card
 * articles; a MutationObserver re-applies on every appended row (render
 * functions stay untouched — no per-render hooks).
 */
import { describe, expect, test } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";

describe("RENDER_SHELL_HTML — G4 feed filter", () => {
  test("filter bar ships with input + kind chips", () => {
    expect(RENDER_SHELL_HTML).toContain('id="feed-filter"');
    expect(RENDER_SHELL_HTML).toContain('data-kind="all"');
    expect(RENDER_SHELL_HTML).toContain('data-kind="text"');
    expect(RENDER_SHELL_HTML).toContain('data-kind="cards"');
  });

  test("applyFeedFilter + MutationObserver wiring; setPane hides the bar off-Inbox", () => {
    expect(RENDER_SHELL_HTML).toContain("function applyFeedFilter()");
    expect(RENDER_SHELL_HTML).toContain("new MutationObserver(applyFeedFilter)");
    expect(RENDER_SHELL_HTML).toContain("row.style.display");
    expect(RENDER_SHELL_HTML).toContain("filterBar.hidden = name !== 'events'");
  });
});
