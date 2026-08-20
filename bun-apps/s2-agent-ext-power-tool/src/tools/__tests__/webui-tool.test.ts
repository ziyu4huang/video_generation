/**
 * webui-tool.test.ts — units for the pure audit logic + one Chrome-gated
 * integration against a Bun.serve stub of the five-tab webui shell.
 *
 * Chrome gating mirrors browser-tool.test.ts: a real headless launch is
 * probed ONCE at module load (bun evaluates test.skipIf at definition time,
 * so a beforeAll probe cannot flip it). Machines without system Chrome skip
 * the integration gracefully while the pure units still run everywhere.
 * PI_POWER_BROWSER_RUNS_ROOT points at a temp dir for the whole file — no
 * test ever writes under the real ~/.pi/power-browser.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromeLikelyAvailable } from "../browser-tool.js";
import {
  evaluateInvariants,
  formatReport,
  makeWebuiTool,
  type WebuiAuditState,
} from "../webui-tool.js";

// ─── Fixtures (pure) ──────────────────────────────────────────────────────────

type Article = WebuiAuditState["panes"][number]["articles"][number];

function article(id: string, kind: string, attention: string, title: string): Article {
  return { id, kind, attention, title };
}

/** Healthy v2 rest state: five tabs, exactly one visible pane (data), cards located. */
function healthyV2(): WebuiAuditState {
  return {
    url: "http://localhost:8890",
    tabs: ["report", "ask", "inbox", "data", "cards"],
    panes: [
      { id: "report-pane", hidden: true, articles: [article("report-1", "report", "low", "Daily")] },
      { id: "ask-pane", hidden: true, articles: [article("ask-1", "ask", "high", "Ask")] },
      { id: "inbox-pane", hidden: true, articles: [] },
      { id: "data-pane", hidden: false, articles: [article("viewer-1", "viewer", "mid", "Viewer")] },
      { id: "cards-pane", hidden: true, articles: [] },
    ],
    consoleErrors: [],
    pageErrors: [],
  };
}

function finding(findings: ReturnType<typeof evaluateInvariants>, check: string) {
  const match = findings.find((f) => f.check === check);
  if (!match) throw new Error(`missing finding ${check}`);
  return match;
}

// ─── evaluateInvariants (pure, no Chrome) ─────────────────────────────────────

describe("evaluateInvariants (pure)", () => {
  test("healthy v2 five-tab state: all 7 checks pass in canonical order", () => {
    const findings = evaluateInvariants(healthyV2());
    expect(findings.map((f) => f.check)).toEqual([
      "panes-exclusive",
      "ask-cards-located",
      "viewer-cards-located",
      "report-articles-located",
      "report-iframe-sized",
      "zero-page-errors",
      "zero-console-errors",
    ]);
    for (const f of findings) expect(f.pass).toBe(true);
  });

  test("v3 rest state (all panes hidden) also passes panes-exclusive", () => {
    const state = healthyV2();
    state.panes = state.panes.map((p) => ({ ...p, hidden: true }));
    const f = finding(evaluateInvariants(state), "panes-exclusive");
    expect(f.pass).toBe(true);
    expect(f.detail).toContain("all panes hidden");
  });

  test("ask card in the wrong pane → ask-cards-located FAIL naming the offender", () => {
    const state = healthyV2();
    state.panes[0].articles.push(article("ask-42", "ask", "high", "Stray ask"));
    const f = finding(evaluateInvariants(state), "ask-cards-located");
    expect(f.pass).toBe(false);
    expect(f.detail).toContain("ask-42");
    expect(f.detail).toContain("report-pane");
  });

  test("two visible TOP-LEVEL panes → panes-exclusive FAIL naming both ids", () => {
    const state = healthyV2();
    state.panes[0].hidden = false; // report-pane visible alongside cards-pane
    state.panes[4].hidden = false; // cards-pane (top-level) — data-pane is a fold child since webui #1684
    const f = finding(evaluateInvariants(state), "panes-exclusive");
    expect(f.pass).toBe(false);
    expect(f.detail).toContain("report-pane");
    expect(f.detail).toContain("cards-pane");
  });

  test("fold child visible alongside one top-level pane → panes-exclusive PASS (fold children don't count)", () => {
    const state = healthyV2();
    state.panes[0].hidden = false; // report-pane visible; data-pane already visible (fold child)
    const f = finding(evaluateInvariants(state), "panes-exclusive");
    expect(f.pass).toBe(true);
    expect(f.detail).toContain("report-pane");
    expect(f.detail).toContain("+1 fold children");
  });

  test("page error → zero-page-errors FAIL carrying the message", () => {
    const state = healthyV2();
    state.pageErrors.push("Uncaught TypeError: boom is not a function");
    const f = finding(evaluateInvariants(state), "zero-page-errors");
    expect(f.pass).toBe(false);
    expect(f.detail).toContain("Uncaught TypeError");
  });
});

// ─── formatReport (pure, no Chrome) ───────────────────────────────────────────

describe("formatReport (pure)", () => {
  test("smoke: url header, tabs line, article outline, PASS lines", () => {
    const state = healthyV2();
    const report = formatReport(state, evaluateInvariants(state));
    expect(report).toContain("## webui audit — http://localhost:8890");
    expect(report).toContain("PASS panes-exclusive");
    expect(report).toContain("- ask-1 · ask · high · Ask");
  });
});

// ─── Chrome probe + temp audit root (once per file) ───────────────────────────

const runsRootOverride = fs.mkdtempSync(path.join(os.tmpdir(), "power-webui-test-"));
const savedRunsRoot = process.env.PI_POWER_BROWSER_RUNS_ROOT;
process.env.PI_POWER_BROWSER_RUNS_ROOT = runsRootOverride;

let chromeOk = chromeLikelyAvailable();
if (chromeOk) {
  try {
    const { chromium } = await import("playwright-core");
    const probe = await chromium.launch({ channel: "chrome", headless: true });
    await probe.close();
  } catch {
    chromeOk = false;
  }
}

afterAll(() => {
  if (savedRunsRoot === undefined) delete process.env.PI_POWER_BROWSER_RUNS_ROOT;
  else process.env.PI_POWER_BROWSER_RUNS_ROOT = savedRunsRoot;
  fs.rmSync(runsRootOverride, { recursive: true, force: true });
});

// ─── Integration (requires system Chrome) ─────────────────────────────────────

/** Minimal five-tab webui shell: one visible pane at rest, cards located. */
const STUB_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>webui stub</title></head>
<body>
  <nav id="tabs">
    <button class="tab" id="pane-tab-report">report</button>
    <button class="tab" id="pane-tab-ask">ask</button>
    <button class="tab" id="pane-tab-inbox">inbox</button>
    <button class="tab" id="pane-tab-data">data</button>
    <button class="tab" id="cards-tab">cards</button>
  </nav>
  <main>
    <section id="report-pane" hidden>
      <article id="report-1" data-kind="report" data-attention="low"><h4>Daily</h4></article>
    </section>
    <section id="ask-pane" hidden>
      <article id="ask-1" data-kind="ask" data-attention="high"><h4>Ask</h4></article>
    </section>
    <section id="inbox-pane" hidden></section>
    <section id="data-pane">
      <article id="viewer-1" data-kind="viewer" data-attention="mid"><h4>Viewer</h4></article>
    </section>
    <section id="cards-pane" hidden></section>
  </main>
  <script>
    for (const el of document.querySelectorAll("#tabs .tab")) {
      el.addEventListener("click", () => {
        const target = el.id === "cards-tab" ? "cards" : el.id.replace("pane-tab-", "");
        for (const p of document.querySelectorAll("section[id$=-pane]")) {
          p.hidden = p.id !== target + "-pane";
        }
      });
    }
  </script>
</body>
</html>`;

describe("integration (requires system Chrome)", () => {
  test.skipIf(!chromeOk)(
    "single call against a Bun.serve stub: full report, panes-exclusive PASS",
    async () => {
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response(STUB_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
      });
      try {
        const tool = makeWebuiTool();
        const res = await tool.execute(
          "test-call",
          { port: server.port },
          undefined,
          undefined,
          undefined as never,
        );
        const first = res.content[0];
        if (!first || first.type !== "text") throw new Error("expected text content");
        const report = first.text;
        expect(report).toContain(`## webui audit — http://localhost:${server.port}`);
        expect(report).toContain("PASS panes-exclusive");
        expect(report).toContain("PASS ask-cards-located");
        expect(report).toContain("PASS zero-console-errors");
        expect(report).toContain("- ask-1 · ask · high · Ask");
      } finally {
        server.stop(true);
      }
    },
  );
});
