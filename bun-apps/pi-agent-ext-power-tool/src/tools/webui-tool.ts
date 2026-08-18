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
    articles: Array<{
    id: string;
    kind: string;
    attention: string;
    title: string;
    /** report-iframe-sized (inv 7): first iframe rect, when present. */
    iframe?: { w: number; h: number };
  }>;
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
 * The design invariants of the v3 simplify effort (seven as of inv 7). Family-tolerant where
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

  // report-iframe-sized (inv 7): the #1576 bug class — the html-report iframe
  // rendered at the browser default 304x150 because NO sizing rule matched it
  // — passed all six prior invariants. Sized iframes in report panes must be
  // readable: >= 320x300. Thresholds catch the 300x150 default on ANY sane
  // viewport (a 390px-wide phone pane still measures ~358 wide) while never
  // failing a healthy 70vh frame (>= ~400 tall even on short windows). An
  // absent iframe field (older shells, markdown articles) is not checked.
  const IFRAME_MIN_W = 320;
  const IFRAME_MIN_H = 300;
  const reportPanes7 = state.panes.filter((pane) => pane.id.includes("report"));
  // 0x0 = unmeasured (markdown article, older shell, or a pane the tab loop
  // never managed to show) — not evidence of an undersized frame.
  const sizedFrames = reportPanes7.flatMap((pane) =>
    pane.articles.filter((a) => a.iframe && !(a.iframe.w === 0 && a.iframe.h === 0)),
  );
  const undersized = sizedFrames
    .filter((a) => a.iframe!.w < IFRAME_MIN_W || a.iframe!.h < IFRAME_MIN_H)
    .map((a) => `${a.id} at ${a.iframe!.w}x${a.iframe!.h}`);
  findings.push({
    check: "report-iframe-sized",
    pass: undersized.length === 0,
    detail:
      sizedFrames.length === 0
        ? `no sized html-report iframes present (markdown articles only)`
        : undersized.length === 0
          ? `${sizedFrames.length} report iframe(s) sized >= ${IFRAME_MIN_W}x${IFRAME_MIN_H}`
          : `undersized (min ${IFRAME_MIN_W}x${IFRAME_MIN_H}): ${undersized.join(", ")}`,
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
        articles: Array.from(el.querySelectorAll("article"), (a) => {
          const fr = a.querySelector("iframe")?.getBoundingClientRect();
          return {
            id: a.id,
            kind: a.getAttribute("data-kind") ?? "",
            attention: a.getAttribute("data-attention") ?? "",
            title: (a.querySelector("h4")?.textContent ?? "").trim(),
            ...(fr ? { iframe: { w: Math.round(fr.width), h: Math.round(fr.height) } } : {}),
          };
        }),
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

/** Dogfood door: POST the audit report to the audited webui's /api/report.
 * Returns "ok" (published), "rejected" (non-200), or "unreachable" (fetch
 * threw) — NEVER throws: publishing must not fail the audit it reports on. */
export async function publishAuditReport(port: number, markdown: string): Promise<"ok" | "rejected" | "unreachable"> {
  try {
    const res = await fetch("http://localhost:" + port + "/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "webui audit — localhost:" + port,
        source: "webui-audit",
        markdown,
      }),
    });
    return res.ok ? "ok" : "rejected";
  } catch {
    return "unreachable";
  }
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
      "panes, report articles in report panes, report iframes sized readably, zero errors). Returns a markdown " +
      "audit report; a connect failure returns a short error report instead of " +
      "throwing. Args: {port} (default 8890), {publish} (default true — also POSTs this audit " +
      "report into the audited webui's Report tab, so findings are visible in the browser).",
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ description: "webui port (default 8890)" })),
      publish: Type.Optional(Type.Boolean({ description: "Publish this audit report into the audited webui's Report tab (default true)." })),
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

        // Exercise every tab: click + screenshot into the run dir. Inv 7
        // needs GEOMETRY, and geometry needs VISIBILITY — a hidden pane's
        // iframe measures 0x0 (display:none). The rest-state collectDom above
        // captures structure/exclusivity; this overlay captures iframe rects
        // with each pane actually shown, applied before evaluateInvariants.
        const iframeMeasured = new Map<string, { w: number; h: number }>();
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
          for (const pane of (await page.evaluate(collectDom)).panes) {
            for (const a of pane.articles) {
              if (a.iframe && !(a.iframe.w === 0 && a.iframe.h === 0)) {
                iframeMeasured.set(a.id, a.iframe);
              }
            }
          }
          const shot = path.join(dir, `tab-${tabId}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          screenshots.push(shot);
        }

        for (const pane of state.panes) {
          for (const a of pane.articles) {
            const m = iframeMeasured.get(a.id);
            if (m) a.iframe = m;
          }
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

        // Dogfood (audit -> report loop): publish the audit report INTO the
        // webui it just verified — one call leaves the findings visible in the
        // browser's Report tab, and the persistence mirror accumulates audit
        // history across restarts. Best-effort by contract: a publish failure
        // NEVER fails the audit it reports on.
        let publishNote = "";
        if (params.publish !== false) {
          const published = await publishAuditReport(params.port ?? DEFAULT_PORT, report);
          publishNote =
            published === "ok"
              ? "\n\n_audit report published to the webui Report tab._"
              : "\n\n_audit report NOT published (" + published + ") — the webui report route was unreachable._";
        }
        return { content: [{ type: "text" as const, text: report + publishNote }], details: null };
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
