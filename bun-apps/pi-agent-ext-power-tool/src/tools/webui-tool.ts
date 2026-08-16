// webui-tool.ts — single-call visual/design audit of the live webui.
// Sibling of browser-tool.ts: same engine (headless system Chrome), same
// run-dir audit trail, but PURPOSE-BUILT for webui design verification —
// the instrument for the v3 simplify effort (planning D3).
// Pure logic (state → invariants/report) is split from Chrome I/O so units
// run everywhere; only audit() needs a real browser (Chrome-gated tests).
import { defineTool } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser } from "playwright-core";
import { chromeLikelyAvailable } from "./browser-tool.js";

// Same gate family as browser-tool: ONE power_browser gate covers both
// headless-Chrome tools. browser-tool.ts owns the canonical registration
// (both modules load together via TOOL_FACTORIES); the re-assert below is
// an identical, idempotent copy so this file stays correct standalone.
GATE_DEFS["power_browser"] ??= {
  id: "power_browser",
  keywords: [
    "browser",
    "chrome",
    "headless",
    "webpage",
    "web page",
    "open page",
    "page snapshot",
    "browser automation",
    "drive the gui",
    "webui",
  ],
  description: "Code-first headless-Chrome browsing: openPage/snapshot/screenshot via JS",
};

const DEFAULT_PORT = 8890;
const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 20_000;
const TAB_SETTLE_MS = 150;

// ─── Pure audit logic (no Chrome; unit-tested everywhere) ─────────────────────

export interface WebuiAuditState {
  url: string;
  tabs: string[];
  panes: Array<{
    id: string;
    hidden: boolean;
    articles: Array<{ id: string; kind: string; attention: string; title: string }>;
  }>;
  consoleErrors: string[];
  pageErrors: string[];
}

export interface WebuiAuditFinding {
  check: string;
  pass: boolean;
  detail: string;
}

/**
 * The six design invariants of the v3 simplify effort. Family-tolerant where
 * v2 and v3 legitimately differ (pane families, rest-state visibility) and
 * strict where the design is absolute (at most one visible pane, zero errors).
 * The tool DETECTS the live state; it never assumes which version is running.
 */
export function evaluateInvariants(state: WebuiAuditState): WebuiAuditFinding[] {
  const findings: WebuiAuditFinding[] = [];

  // panes-exclusive: at most ONE visible pane; the v3 rest default is ALL
  // hidden (v2 kept a transcript-style default) — either passes, two don't.
  const visible = state.panes.filter((pane) => !pane.hidden);
  findings.push({
    check: "panes-exclusive",
    pass: visible.length <= 1,
    detail:
      visible.length === 0
        ? "all panes hidden at rest (v3 default)"
        : visible.length === 1
          ? `1 visible pane: ${visible[0].id}`
          : `${visible.length} visible panes: ${visible.map((pane) => pane.id).join(", ")}`,
  });

  // ask-cards-located: ask-* articles belong to the inbox family — ask-pane
  // (v3) or cards-pane/inbox-pane (v2 naming).
  const askPanes = new Set(["ask-pane", "cards-pane", "inbox-pane"]);
  const askLocated = state.panes
    .filter((pane) => askPanes.has(pane.id))
    .flatMap((pane) => pane.articles.filter((a) => a.id.startsWith("ask-")));
  const askOffenders = state.panes
    .filter((pane) => !askPanes.has(pane.id))
    .flatMap((pane) =>
      pane.articles.filter((a) => a.id.startsWith("ask-")).map((a) => `${a.id} in ${pane.id}`),
    );
  findings.push({
    check: "ask-cards-located",
    pass: askOffenders.length === 0,
    detail:
      askOffenders.length === 0
        ? `${askLocated.length} ask-* card(s) in inbox-family panes (ask/cards/inbox)`
        : `misplaced: ${askOffenders.join(", ")}`,
  });

  // viewer-cards-located: kind=viewer articles live only in data panes.
  const viewerOffenders = state.panes
    .filter((pane) => !pane.id.includes("data"))
    .flatMap((pane) =>
      pane.articles.filter((a) => a.kind === "viewer").map((a) => `${a.id} in ${pane.id}`),
    );
  const viewerCount = state.panes
    .filter((pane) => pane.id.includes("data"))
    .flatMap((pane) => pane.articles.filter((a) => a.kind === "viewer")).length;
  findings.push({
    check: "viewer-cards-located",
    pass: viewerOffenders.length === 0,
    detail:
      viewerOffenders.length === 0
        ? `${viewerCount} viewer card(s) in data panes`
        : `misplaced: ${viewerOffenders.join(", ")}`,
  });

  // report-articles-located: inside report panes, only report-* articles.
  const reportOffenders = state.panes
    .filter((pane) => pane.id.includes("report"))
    .flatMap((pane) =>
      pane.articles.filter((a) => !a.id.startsWith("report-")).map((a) => `${a.id} in ${pane.id}`),
    );
  const reportCount = state.panes
    .filter((pane) => pane.id.includes("report"))
    .flatMap((pane) => pane.articles.filter((a) => a.id.startsWith("report-"))).length;
  findings.push({
    check: "report-articles-located",
    pass: reportOffenders.length === 0,
    detail:
      reportOffenders.length === 0
        ? `${reportCount} report-* article(s) in report panes`
        : `misplaced: ${reportOffenders.join(", ")}`,
  });

  // zero-page-errors / zero-console-errors: the webui must load clean.
  findings.push({
    check: "zero-page-errors",
    pass: state.pageErrors.length === 0,
    detail:
      state.pageErrors.length === 0
        ? "no page errors"
        : `${state.pageErrors.length} page error(s): ${state.pageErrors.map(oneLine).join(" | ")}`,
  });
  findings.push({
    check: "zero-console-errors",
    pass: state.consoleErrors.length === 0,
    detail:
      state.consoleErrors.length === 0
        ? "no console errors"
        : `${state.consoleErrors.length} console error(s): ${state.consoleErrors.map(oneLine).join(" | ")}`,
  });

  return findings;
}

/** Collapse whitespace + cap length so one rogue log can't flood the report. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/** Markdown report: header, tabs, per-pane article outline, findings. */
export function formatReport(state: WebuiAuditState, findings: WebuiAuditFinding[]): string {
  const lines: string[] = [`## webui audit — ${state.url}`, ""];
  lines.push(`tabs (${state.tabs.length}): ${state.tabs.length ? state.tabs.join(" · ") : "(none)"}`);
  for (const pane of state.panes) {
    lines.push("", `### ${pane.id}${pane.hidden ? " (hidden)" : " (visible)"}`);
    if (pane.articles.length === 0) lines.push("- (no articles)");
    for (const a of pane.articles) lines.push(`- ${a.id} · ${a.kind} · ${a.attention} · ${a.title}`);
  }
  lines.push("");
  for (const finding of findings) {
    lines.push(`${finding.pass ? "PASS" : "FAIL"} ${finding.check} — ${finding.detail}`);
  }
  return lines.join("\n");
}

// ─── Chrome I/O (the only part that needs a real browser) ─────────────────────

/** What collectDom() pulls out of the live page. */
interface WebuiDom {
  tabs: string[];
  tabIds: string[];
  panes: WebuiAuditState["panes"];
}

/**
 * DOM collector serialized into the page by page.evaluate. Closure-free by
 * necessity — the page context can't see module scope — but the DOM lib IS
 * on for this package, so native DOM types are used directly (types erase;
 * only the function body is serialized into the page).
 */
function collectDom(): WebuiDom {
  const panes: WebuiAuditState["panes"] = [];
  const tabIds: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("[id]")) {
    if (/^(report|ask|cards|inbox|data)-pane$/.test(el.id)) {
      panes.push({
        id: el.id,
        hidden: el.hasAttribute("hidden"),
        articles: Array.from(el.querySelectorAll("article"), (a) => ({
          id: a.id,
          kind: a.getAttribute("data-kind") ?? "",
          attention: a.getAttribute("data-attention") ?? "",
          title: (a.querySelector("h4")?.textContent ?? "").trim(),
        })),
      });
    } else if (/^pane-tab-/.test(el.id) || el.id === "cards-tab") {
      tabIds.push(el.id);
    }
  }
  const tabs = Array.from(document.querySelectorAll("#tabs .tab"), (el) =>
    (el.textContent ?? "").trim(),
  );
  return { tabs, tabIds, panes };
}

// Default audit root — SAME root as browser-tool (tests override via
// PI_POWER_BROWSER_RUNS_ROOT, read lazily so an env set after import applies).
function runsRoot(): string {
  const override = process.env.PI_POWER_BROWSER_RUNS_ROOT;
  return override ? path.resolve(override) : path.join(os.homedir(), ".pi", "power-browser", "runs");
}

/** Fresh audit dir per call: webui-<stamp>-<seq> under the shared runs root. */
function makeRunDir(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // 20260816T101530
  let seq = 1;
  let candidate = path.join(runsRoot(), `webui-${stamp}-${seq}`);
  while (fs.existsSync(candidate)) {
    seq += 1;
    candidate = path.join(runsRoot(), `webui-${stamp}-${seq}`);
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

/** Connect/launch failure → short markdown error report; the tool NEVER throws. */
function connectFailureReport(url: string, error: unknown): string {
  const message = oneLine(error instanceof Error ? error.message : String(error));
  return [
    `## webui audit — ${url}`,
    "",
    `cannot audit: ${message}`,
    "",
    "Start the webui (`bun run dev` in bun-apps/gui-movie-director; `bun run gui:port` " +
      "prints the actual port) or pass {port} for a different one.",
  ].join("\n");
}

export function makeWebuiTool() {
  return defineTool({
    name: "webui",
    gating: { gate: "power_browser" }, // same family as the browser tool
    label: "Webui",
    description:
      "Audit the LIVE webui design in one call: opens http://localhost:<port> in " +
      "headless system Chrome (same engine as the browser tool; never downloads " +
      "a browser), collects the tab list and per-pane article outline, captures " +
      "console/page errors, screenshots every tab into the run dir " +
      "(~/.pi/power-browser/runs/), and evaluates design invariants (at most " +
      "one visible pane, ask cards in the inbox family, viewer cards in data " +
      "panes, report articles in report panes, zero errors). Returns a markdown " +
      "audit report; a connect failure returns a short error report instead of " +
      "throwing. Args: {port} (default 8890).",
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ description: "webui port (default 8890)" })),
    }),

    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const url = `http://localhost:${params.port ?? DEFAULT_PORT}`;
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      let browser: Browser | null = null;
      try {
        if (!chromeLikelyAvailable()) {
          throw new Error(
            "No system Chrome/Chromium found. The webui tool drives an installed " +
              'Google Chrome (channel "chrome") and never downloads one.',
          );
        }
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch({ channel: "chrome", headless: true });
        const context = await browser.newContext();
        context.setDefaultTimeout(ACTION_TIMEOUT_MS);
        const page = await context.newPage();

        // EARLY: listeners go on before navigation so first-load errors count.
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        page.on("pageerror", (error) => {
          pageErrors.push(error instanceof Error ? error.message : String(error));
        });

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        // Rest state first — the invariants DETECT the live layout, they don't
        // assume it. Tab clicks below only drive screenshots.
        const dom = await page.evaluate(collectDom);
        const state: WebuiAuditState = {
          url,
          tabs: dom.tabs,
          panes: dom.panes,
          consoleErrors,
          pageErrors,
        };

        // Exercise every tab: click + screenshot into the run dir.
        const dir = makeRunDir();
        const screenshots: string[] = [];
        for (const tabId of dom.tabIds) {
          try {
            await page.click(`#${tabId}`);
            await page.waitForTimeout(TAB_SETTLE_MS); // let the switch settle
          } catch {
            // A dead tab id shows up in the outline/screenshots; keep auditing
            // the remaining tabs instead of aborting the whole call.
          }
          const shot = path.join(dir, `tab-${tabId}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          screenshots.push(shot);
        }

        const findings = evaluateInvariants(state);
        const report = formatReport(state, findings);

        // D6-style audit trail in the same runs root as the browser tool.
        fs.appendFileSync(
          path.join(dir, "steps.jsonl"),
          `${JSON.stringify({
            ts: new Date().toISOString(),
            url,
            ok: findings.every((finding) => finding.pass),
            summary: findings
              .map((finding) => `${finding.pass ? "PASS" : "FAIL"} ${finding.check}`)
              .join("; "),
            screenshots,
          })}\n`,
        );
        fs.writeFileSync(path.join(dir, "report.md"), `${report}\n`);

        return { content: [{ type: "text" as const, text: report }], details: null };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: connectFailureReport(url, error) }],
          details: null,
        };
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    },
  });
}
