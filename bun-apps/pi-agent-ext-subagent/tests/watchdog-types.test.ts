import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WatchdogFinding, WatchdogOptions, WatchdogResult } from "../src/watchdog/types.js";
import { normalizeWatchdogParam } from "../src/watchdog/types.js";

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
  it("normalizeWatchdogParam(true) enables L1 only", () => {
    assert.deepEqual(normalizeWatchdogParam(true), { l1: true, l2: false });
  });
  it("normalizeWatchdogParam({}) returns defaults (L1 on, L2 off)", () => {
    assert.deepEqual(normalizeWatchdogParam({}), { l1: true, l2: false });
  });
  it("normalizeWatchdogParam({ l1: false }) disables L1", () => {
    assert.deepEqual(normalizeWatchdogParam({ l1: false }), { l1: false, l2: false });
  });
  it("normalizeWatchdogParam({ l2: true }) enables both layers", () => {
    assert.deepEqual(normalizeWatchdogParam({ l2: true }), { l1: true, l2: true });
  });
  it("normalizeWatchdogParam({ l1: true, l2: true }) enables both layers", () => {
    assert.deepEqual(normalizeWatchdogParam({ l1: true, l2: true }), { l1: true, l2: true });
  });
  it("normalizeWatchdogParam(undefined) returns undefined", () => {
    assert.strictEqual(normalizeWatchdogParam(undefined), undefined);
  });
  it("normalizeWatchdogParam(null) returns undefined (null footgun)", () => {
    assert.strictEqual(normalizeWatchdogParam(null), undefined);
  });
  it("normalizeWatchdogParam(false) returns undefined", () => {
    assert.strictEqual(normalizeWatchdogParam(false), undefined);
  });
  it('normalizeWatchdogParam("watch") returns undefined for non-matching type', () => {
    assert.strictEqual(normalizeWatchdogParam("watch"), undefined);
  });
});
