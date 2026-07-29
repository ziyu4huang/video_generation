// tests/watchdog-types.test.ts

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WatchdogFinding, WatchdogOptions, WatchdogResult } from "../src/watchdog/types.js";

describe("watchdog types", () => {
  it("WatchdogResult shape is constructible", () => {
    const r: WatchdogResult = {
      ran: true,
      editGated: false,
      elapsedMs: 5,
      l1: { ran: true, provider: "typescript-language-server", findings: [] },
      l2: { ran: false, findings: [] },
      summary: "clean",
    };
    assert.equal(r.summary, "clean");
  });
  it("WatchdogFinding blocker carries a path+line", () => {
    const f: WatchdogFinding = { severity: "blocker", source: "lsp", path: "a.ts", line: 7, message: "x" };
    assert.equal(f.severity, "blocker");
  });
  it("WatchdogOptions defaults are explicit booleans", () => {
    const o: WatchdogOptions = { l1: true, l2: false };
    assert.equal(o.l2, false);
  });
});
