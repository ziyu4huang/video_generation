/**
 * webui-invariants.test.ts — unit tests for the pure audit logic in
 * webui-tool.ts (evaluateInvariants). The seven invariants ran untested
 * between t01 and inv 7; these pin the interesting branches, especially the
 * report-iframe-sized thresholds (the #1576 bug class: 304x154 default).
 * (Moved from s2-agent-ext-power-tool with the tool itself.)
 */
import { describe, expect, test } from "bun:test";
import { evaluateInvariants, type WebuiAuditState } from "../src/webui-tool.js";

function state(panes: WebuiAuditState["panes"]): WebuiAuditState {
  return { url: "http://t", tabs: ["Inbox", "Report", "Data"], panes, consoleErrors: [], pageErrors: [] };
}
const art = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "report",
  attention: "",
  title: "T",
  ...extra,
});

describe("evaluateInvariants — report-iframe-sized (inv 7)", () => {
  test("healthy 70vh frame passes; undersized 304x154 (the #1576 default) fails", () => {
    const ok = evaluateInvariants(state([
      { id: "cards-pane", hidden: false, articles: [] },
      { id: "report-pane", hidden: true, articles: [art("report-1", { iframe: { w: 1068, h: 630 } })] },
    ]));
    expect(ok.find((f) => f.check === "report-iframe-sized")?.pass).toBe(true);

    const bug = evaluateInvariants(state([
      { id: "cards-pane", hidden: false, articles: [] },
      { id: "report-pane", hidden: true, articles: [art("report-1", { iframe: { w: 304, h: 154 } })] },
    ]));
    const f = bug.find((x) => x.check === "report-iframe-sized");
    expect(f?.pass).toBe(false);
    expect(f?.detail).toContain("304x154");
  });

  test("no sized iframes (markdown articles / older shells) is a trivial pass", () => {
    const r = evaluateInvariants(state([
      { id: "cards-pane", hidden: false, articles: [] },
      { id: "report-pane", hidden: true, articles: [art("report-2")] },
    ]));
    const f = r.find((x) => x.check === "report-iframe-sized");
    expect(f?.pass).toBe(true);
    expect(f?.detail).toContain("no sized html-report iframes");
  });

  test("narrow-but-legal phone-pane frame (358 wide) passes; width-only undersize fails", () => {
    const phone = evaluateInvariants(state([
      { id: "report-pane", hidden: false, articles: [art("report-3", { iframe: { w: 358, h: 761 } })] },
    ]));
    expect(phone.find((f) => f.check === "report-iframe-sized")?.pass).toBe(true);

    const wideButFlat = evaluateInvariants(state([
      { id: "report-pane", hidden: false, articles: [art("report-4", { iframe: { w: 1200, h: 149 } })] },
    ]));
    expect(wideButFlat.find((f) => f.check === "report-iframe-sized")?.pass).toBe(false);
  });

  test("0x0 iframe (unmeasured — hidden pane / markdown era) is skipped, not failed", () => {
    const r = evaluateInvariants(state([
      { id: "report-pane", hidden: true, articles: [art("report-5", { iframe: { w: 0, h: 0 } })] },
    ]));
    const f = r.find((x) => x.check === "report-iframe-sized");
    expect(f?.pass).toBe(true);
    expect(f?.detail).toContain("no sized html-report iframes");
  });

  test("seven invariants emitted; panes-exclusive still enforced", () => {
    const r = evaluateInvariants(state([
      { id: "report-pane", hidden: false, articles: [] },
      { id: "cards-pane", hidden: false, articles: [] },
    ]));
    expect(r.length).toBe(7);
    expect(r.find((f) => f.check === "panes-exclusive")?.pass).toBe(false);
  });
});

describe("evaluateInvariants — panes-exclusive is fold-aware (webui #1684 More fold)", () => {
  test("Case A: healthy More fold — more-pane visible with nested data/btw children — PASSES; fold children not counted", () => {
    const r = evaluateInvariants(state([
      { id: "cards-pane", hidden: true, articles: [] },
      { id: "report-pane", hidden: true, articles: [] },
      { id: "more-pane", hidden: false, articles: [] },
      { id: "data-pane", hidden: false, articles: [] },
      { id: "btw-pane", hidden: false, articles: [] },
    ]));
    const f = r.find((x) => x.check === "panes-exclusive")!;
    expect(f.pass).toBe(true);
    expect(f.detail).toBe("1 visible pane: more-pane (+2 fold children)");
  });

  test("Case B: a REAL violation is still caught — cards AND report both visible — FAILS with 2 visible panes", () => {
    const r = evaluateInvariants(state([
      { id: "cards-pane", hidden: false, articles: [] },
      { id: "report-pane", hidden: false, articles: [] },
      { id: "more-pane", hidden: true, articles: [] },
      { id: "data-pane", hidden: true, articles: [] },
    ]));
    const f = r.find((x) => x.check === "panes-exclusive")!;
    expect(f.pass).toBe(false);
    expect(f.detail).toContain("2 visible panes");
    expect(f.detail).toContain("cards-pane");
    expect(f.detail).toContain("report-pane");
  });

  test("Case C: Inbox family alone — cards visible, fold closed — PASSES as the one top-level pane", () => {
    const r = evaluateInvariants(state([
      { id: "cards-pane", hidden: false, articles: [] },
      { id: "report-pane", hidden: true, articles: [] },
      { id: "more-pane", hidden: true, articles: [] },
      { id: "data-pane", hidden: true, articles: [] },
      { id: "btw-pane", hidden: true, articles: [] },
    ]));
    const f = r.find((x) => x.check === "panes-exclusive")!;
    expect(f.pass).toBe(true);
    expect(f.detail).toBe("1 visible pane: cards-pane");
  });
});

import { connectFailureReport } from "../src/webui-tool.js";

describe("connectFailureReport — failure-kind classification (errdx)", () => {
  test("Chrome launch failure -> launch hint, NOT 'start the webui'", () => {
    const r = connectFailureReport("http://localhost:8890", new Error("browserType.launch: Failed to launch chrome"));
    expect(r).toContain("headless Chrome failed to launch");
    expect(r).toContain("management policy");
    expect(r).not.toContain("Start the webui");
  });
  test("connection refused -> either unreachable-hint (Chrome present) or chrome-missing hint (CI runner)", () => {
    const r = connectFailureReport("http://localhost:8890", new Error("net::ERR_CONNECTION_REFUSED at http://localhost:8890"));
    const unreachable = r.includes("cannot reach the webui") && r.includes("Start the webui");
    const noChrome = r.includes("no system Chrome/Chromium found") && r.includes("Install Google Chrome");
    expect(unreachable || noChrome).toBe(true);
  });
});
