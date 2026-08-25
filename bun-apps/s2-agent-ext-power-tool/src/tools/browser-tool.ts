/**
 * browser-tool.ts — code-first headless-Chrome browsing for power-tool.
 *
 * Philosophy (ported from BetterWright's tool-schemas): ONE tool, `{code,
 * note}` params — not a step vocabulary. The model writes JS against injected
 * globals and gets the last expression back:
 *
 *   page, pages, context, openPage(url?), closePage(),
 *   snapshot({interactive?, ref?, diff?, pruneMode?, urls?, maxChars?}),
 *   screenshot(path?)
 *
 * - Headless ONLY, system Chrome via `channel: "chrome"` (never downloads a
 *   browser; launch failure returns a helpful error). Standing user rule: no
 *   headful automation, ever.
 * - Lazy singleton: the browser launches on first call, closes after 120s
 *   idle, next call recreates it. No daemon.
 * - Snapshot pipeline mirrors BetterWright's worker: ariaSnapshot({mode:"ai"})
 *   → compressSnapshot → optional prune (D7 `pruneMode`: "act" =
 *   filterInteractive, "read" = content lines kept) → per-(page, scope) diff
 *   store → char limit that REFUSES instead of truncating.
 * - D6 audit: every call is recorded to
 *   ~/.pi/power-browser/runs/<sessionStamp>-<seq>/steps.jsonl
 *   ({ts, code, note?, ok, resultSummary, screenshot?}, one line per call);
 *   default screenshots land in the same dir as shot-<n>.png.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { actModeHint, compressSnapshot, diffSnapshots, filterInteractive, filterReadable } from "./snapshot-compress.js";

// Register the gate family in the shared registry at module load: browsing is
// on-demand (UI debugging, page inspection), so the tool stays dormant
// behind keyword gating instead of riding along with the always-on inspect_*
// diagnostics (which are `core: true` because you need them when things break).
GATE_DEFS["power_browser"] = {
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

/**
 * QA-only gate probes, colocated with the gate they describe.
 *
 * tool-gate collects these (qa/collect-probes.ts) and derives its L1 corpus from
 * them, so this gate is fully covered without editing tool-gate. Keeping the
 * probes next to GATE_DEFS above means a keyword change and its probes move
 * together — when they lived in tool-gate, adding this tool left main red until
 * someone repaired a package its author does not own.
 *
 * PLAIN object, no type import: tool-gate depends on power-tool, so importing
 * `GateProbeSet` back would close a dependency cycle. Shape is enforced by
 * tool-gate's collector drift guard.
 *
 * `recallFloor: 0` with no adversarial set — browsing is a deliberate-dispatch
 * gate. You ask for a browser by name; there is no "I need this without saying
 * so" phrasing to recall-test, which is exactly why the tool is keyword-gated
 * and not always-on core.
 */
export const __GATE_PROBES__ = {
  gate: "browser",
  recallFloor: 0,
  adversarial: [] as string[],
  controls: [
    "open the page in a headless browser and snapshot it",
    "drive the gui and screenshot the webui",
  ],
  // Word-boundary matching is what makes these inert: "browse" is not "browser",
  // and bare "page" is not "web page" / "open page" / "page snapshot".
  mustNotFire: ["browse the repo for the config file", "the error is on page 3 of the log"],
};

const IDLE_CLOSE_MS = 120_000;
const CODE_TIMEOUT_MS = 30_000;

/**
 * Per-call code timeout, overridable for tests/ops via
 * PI_POWER_BROWSER_CODE_TIMEOUT_MS (read lazily so the guard can be exercised
 * without a real 30s wait).
 */
export function codeTimeoutMs(): number {
  const override = Number(process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : CODE_TIMEOUT_MS;
}
const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 20_000;

// System-Chrome candidates — `channel: "chrome"` resolves these; probing the
// paths first lets us fail fast with a helpful message instead of a launch
// stack. playwright-core never downloads browsers on its own.
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** Cheap filesystem probe for a system Chrome/Chromium. */
export function chromeLikelyAvailable(): boolean {
  return CHROME_CANDIDATES.some((candidate) => fs.existsSync(candidate));
}

// ─── Singleton browser state ──────────────────────────────────────────────────

interface BrowserState {
  browser: Browser | null;
  context: BrowserContext | null;
  pages: Page[]; // live array — exposed as the `pages` global (mutate in place)
  current: Page | null;
  /** The page runCode's eager ensurePage created implicitly — openPage reuses it while virgin. */
  implicitPage: Page | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastSnapshots: WeakMap<Page, Map<string, string>>;
}

const state: BrowserState = {
  browser: null,
  context: null,
  pages: [],
  current: null,
  implicitPage: null,
  idleTimer: null,
  lastSnapshots: new WeakMap(),
};

function armIdleTimer(): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => void closeBrowser(), IDLE_CLOSE_MS);
  state.idleTimer.unref?.();
}

async function closeBrowser(): Promise<void> {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  const browser = state.browser;
  state.browser = null;
  state.context = null;
  state.current = null;
  state.implicitPage = null;
  state.pages.length = 0;
  if (browser) await browser.close().catch(() => {});
}

/** Launch failure surfaces as a helpful error — we NEVER download browsers. */
async function ensureContext(): Promise<BrowserContext> {
  if (state.context) return state.context;
  if (!chromeLikelyAvailable()) {
    throw new Error(
      "No system Chrome/Chromium found. The browser tool drives an installed " +
        "Google Chrome (channel \"chrome\") and never downloads one — install " +
        "Chrome first, or use another tool for this task.",
    );
  }
  const { chromium } = await import("playwright-core");
  try {
    state.browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (error) {
    throw new Error(
      `Headless Chrome failed to launch (${error instanceof Error ? error.message : String(error)}). ` +
        "The browser tool only drives an installed system Chrome and never " +
        "downloads browsers. Check that Google Chrome is installed and up to date.",
    );
  }
  if (!state.browser) throw new Error("Chrome launch returned no browser");
  state.context = await state.browser.newContext();
  state.context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  return state.context;
}

async function ensurePage(): Promise<Page> {
  const context = await ensureContext();
  if (state.current && !state.current.isClosed()) return state.current;
  const page = await context.newPage();
  state.pages.push(page); // in place — the `pages` global array stays identical
  state.current = page;
  state.implicitPage = page;
  return page;
}

function pageIndexOf(page: Page): number {
  return Math.max(0, state.pages.indexOf(page));
}

function pageSummaries(): string[] {
  return state.pages.map((page, index) => {
    try {
      return `page ${index} ${page.url()}`;
    } catch {
      return `page ${index} (closed)`;
    }
  });
}

// ─── D6 audit run-dir ─────────────────────────────────────────────────────────

// Default audit root. Tests (and users who want logs elsewhere) override via
// PI_POWER_BROWSER_RUNS_ROOT — read lazily, not at module load, so an env set
// after import still applies to the first run dir.
function runsRoot(): string {
  const override = process.env.PI_POWER_BROWSER_RUNS_ROOT;
  return override ? path.resolve(override) : path.join(os.homedir(), ".pi", "power-browser", "runs");
}

let runDir: string | null = null;
let shotSeq = 0;

/** Lazily create (mkdir -p) the per-process audit run dir. */
function ensureRunDir(): string {
  if (!runDir) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // 20260816T101530
    let seq = 1;
    let candidate = path.join(runsRoot(), `${stamp}-${seq}`);
    while (fs.existsSync(candidate)) {
      seq += 1;
      candidate = path.join(runsRoot(), `${stamp}-${seq}`);
    }
    fs.mkdirSync(candidate, { recursive: true });
    runDir = candidate;
  }
  return runDir;
}

interface AuditStep {
  ts: string;
  code: string;
  note?: string;
  ok: boolean;
  resultSummary: string;
  screenshot?: string;
}

/** Append one line per call to steps.jsonl (D6). */
function recordStep(step: AuditStep): void {
  fs.appendFileSync(path.join(ensureRunDir(), "steps.jsonl"), `${JSON.stringify(step)}\n`);
}

function summarizeResult(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === undefined) text = "undefined";
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

// ─── Globals exposed to the code string ───────────────────────────────────────

export interface SnapshotOptions {
  /** Legacy alias for `pruneMode: "act"`. */
  interactive?: boolean;
  /** Scope to an aria ref like "e12" or "f1e3". */
  ref?: string;
  /** Diff against the previous snapshot of the same page + scope. */
  diff?: boolean;
  /** D7: "act" = interactive elements only; "read" = content lines kept. */
  pruneMode?: "act" | "read";
  /** Keep `- /url:` property lines (dropped by default). */
  urls?: boolean;
  /** Char limit (1_000–20_000, default 10_000); over-limit REFUSES, not truncates. */
  maxChars?: number;
}

async function snapshotPage(page: Page | null, options: SnapshotOptions = {}): Promise<string> {
  if (!page || page.isClosed()) page = await ensurePage();
  const prune = options.pruneMode ?? (options.interactive ? "act" : undefined);
  if (options.ref && !/^(?:f\d+)*e\d+$/.test(options.ref))
    throw new Error(`Invalid snapshot ref "${options.ref}" — expected a marker like "e12" or "f1e3".`);
  const scope = options.ref ? page.locator(`aria-ref=${options.ref}`) : page.locator("body");
  let text = await scope.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS });
  text = compressSnapshot(text, { urls: options.urls === true });
  if (prune === "act") {
    text = filterInteractive(text);
    const hint = actModeHint(text);
    if (hint) text = `${text}\n${hint}`;
  } else if (prune === "read") {
    text = filterReadable(text);
  }

  // Per-(page, scope-key) last-snapshot store backs {diff: true}.
  const key = JSON.stringify([options.ref ?? "", prune ?? null, options.urls === true]);
  const store = state.lastSnapshots.get(page) ?? new Map<string, string>();
  state.lastSnapshots.set(page, store);
  const previous = store.get(key);
  store.set(key, text);

  let title = "";
  try {
    title = (await page.title()).replace(/\s+/g, " ").trim().slice(0, 120);
  } catch {
    // A page mid-navigation can refuse title(); the header works without it.
  }
  const header = `page ${pageIndexOf(page)} ${page.url()}${title ? ` "${title}"` : ""}`;
  if (options.diff && previous !== undefined) {
    const result = diffSnapshots(previous, text);
    if (!result.changed) return `${header}\n(no changes since previous snapshot)`;
    if (!result.tooLarge)
      text = `diff vs previous snapshot (+${result.additions} -${result.removals})\n${result.diff}`;
  }
  const limit = Math.max(1_000, Math.min(Number(options.maxChars || 10_000), 20_000));
  if (text.length <= limit) return `${header}\n${text}`;
  // Refuse instead of truncating: a cut-off tree reads as complete and sends
  // the model acting on half a page, while an error steers it to a scoped
  // re-read.
  const hints: string[] = [];
  if (prune !== "act") hints.push("{pruneMode:'act'} to keep only actionable elements");
  hints.push(options.ref ? "a narrower {ref} subtree" : "{ref} to scope to one element");
  return (
    `${header}\nSnapshot is ${text.length} chars, over the ${limit} limit. ` + `Retry with ${hints.join(", ")}.`
  );
}

async function openPage(url?: string): Promise<string> {
  const context = await ensureContext();
  // Reuse the implicit page runCode's eager ensurePage created while it is
  // still virgin (never navigated off about:blank) — an openPage-first session
  // keeps ONE page instead of carrying a dead blank as page 0 all session.
  const implicit = state.implicitPage;
  if (
    implicit &&
    state.current === implicit &&
    !implicit.isClosed() &&
    (() => {
      try {
        return implicit.url() === "about:blank";
      } catch {
        return false; // destroyed page — fall through to a fresh one
      }
    })()
  ) {
    state.implicitPage = null;
    if (url) await implicit.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return `page ${pageIndexOf(implicit)} ${implicit.url()}`;
  }
  const page = await context.newPage();
  state.pages.push(page);
  state.current = page;
  if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  return `page ${pageIndexOf(page)} ${page.url()}`;
}

/**
 * Resolve a closePage target to the real Page it designates. Exported pure for
 * unit tests — no browser needed. The injected `page` global is a live Proxy
 * over the current page: it forwards every access but can never match a real
 * Page by identity, so an unmatched object designates `current`.
 */
export function resolveCloseTarget(
  pages: Page[],
  current: Page | null,
  target?: Page | number,
): Page | null {
  if (typeof target === "number") return pages[target] ?? null;
  if (!target) return current;
  return pages.includes(target) ? target : (current ?? target);
}

async function closePage(target?: Page | number): Promise<string> {
  const page = resolveCloseTarget(state.pages, state.current, target);
  if (!page) return "no pages open";
  await page.close();
  const index = state.pages.indexOf(page);
  if (index >= 0) state.pages.splice(index, 1);
  // Re-point when the CURRENT page is the closed one (covers both a real
  // reference and the live-page Proxy, which never matches by identity).
  if (state.current && state.current.isClosed()) {
    state.current = state.pages[state.pages.length - 1] ?? null;
  }
  if (state.implicitPage?.isClosed()) state.implicitPage = null;
  return `closed page ${index >= 0 ? index : "?"}; ${state.pages.length} open`;
}

async function takeScreenshot(pathArg?: string): Promise<string> {
  if (!state.current || state.current.isClosed()) await ensurePage();
  const page = state.current!;
  const target = pathArg ?? path.join(ensureRunDir(), `shot-${(shotSeq += 1)}.png`);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

// ─── Code execution ───────────────────────────────────────────────────────────

type AsyncFunction = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as unknown as AsyncFunction;
const GLOBAL_NAMES = [
  "page",
  "pages",
  "context",
  "openPage",
  "closePage",
  "snapshot",
  "screenshot",
] as const;

interface CodeOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  screenshot?: string;
}

async function runCode(code: string): Promise<CodeOutcome> {
  await ensurePage();
  armIdleTimer();
  const fn = new AsyncFunction(...GLOBAL_NAMES, code);
  let screenshotPath: string | undefined;
  // Live page binding: invocation snapshots globals ONCE, so a plain value (or a
  // one-shot read of the getter) would pin `page` to the pre-code page. A Proxy
  // forwards EVERY property access (methods bound) to the CURRENT page.
  const livePage = new Proxy(
    {},
    {
      get: (_t, prop) => {
        const cur = state.current as unknown as Record<string, unknown> | null;
        if (!cur) return undefined;
        const value = cur[prop as string];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(cur) : value;
      },
    },
  ) as unknown as Page;
  const globals: Record<(typeof GLOBAL_NAMES)[number], unknown> = {
    page: livePage,
    pages: state.pages,
    context: state.context,
    openPage,
    closePage,
    snapshot: (options: SnapshotOptions = {}) => snapshotPage(state.current, options),
    screenshot: async (screenshotPathArg?: string) => {
      screenshotPath = await takeScreenshot(screenshotPathArg);
      return screenshotPath;
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    const timeoutMs = codeTimeoutMs();
    timer = setTimeout(
      () => reject(new Error(`browser code timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    const result = await Promise.race([fn(...GLOBAL_NAMES.map((name) => globals[name])), timedOut]);
    return { ok: true, result, ...(screenshotPath ? { screenshot: screenshotPath } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Timeout cleanup is page-level (the context survives): the runaway code
    // holds a dead page, while the next call gets a fresh one.
    if (message.includes("timed out") && state.current) {
      const stuck = state.current;
      state.current = state.pages.filter((p) => p !== stuck).at(-1) ?? null;
      await stuck.close().catch(() => {});
    }
    return { ok: false, error: message };
  } finally {
    if (timer) clearTimeout(timer);
    armIdleTimer();
  }
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export function makeBrowserTool() {
  return defineTool({
    name: "browser",
    gating: { gate: "power_browser" }, // on-demand browsing, not always-on core
    label: "Browser",
    description:
      "Drive a headless system Chrome with JS code. Runs against globals: " +
      "page, pages, context, openPage(url?), closePage(), " +
      "snapshot({interactive?, ref?, diff?, pruneMode?, urls?, maxChars?}) " +
      "(compressed aria tree; pruneMode 'act' = interactive-only, 'read' = " +
      "content lines; diff vs previous), screenshot(path?) (fullPage PNG). " +
      "Headless only, never downloads a browser. Every call is audit-logged " +
      "with its screenshots under ~/.pi/power-browser/runs/.",
    parameters: Type.Object({
      code: Type.String({
        minLength: 1,
        description:
          "JS body to run; its awaited value is returned. e.g. " +
          '`await openPage("http://localhost:3000"); return await snapshot({pruneMode:"act"})`',
      }),
      note: Type.Optional(
        Type.String({ description: "Present-tense status line (not code)." }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const outcome = await runCode(params.code);
      const runDirUsed = ensureRunDir();
      recordStep({
        ts: new Date().toISOString(),
        code: params.code,
        ...(params.note ? { note: params.note } : {}),
        ok: outcome.ok,
        resultSummary: outcome.ok ? summarizeResult(outcome.result) : (outcome.error ?? "error"),
        ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
      });
      const payload = {
        ok: outcome.ok,
        ...(outcome.ok
          ? { result: outcome.result === undefined ? null : outcome.result }
          : { error: outcome.error }),
        pages: pageSummaries(),
        ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
        runDir: runDirUsed,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: null,
      };
    },
  });
}

/** Test seam: close the browser (if any) and reset module state + run-dir. */
export async function __resetBrowserToolForTests(): Promise<void> {
  await closeBrowser();
  state.lastSnapshots = new WeakMap();
  runDir = null;
  shotSeq = 0;
}
