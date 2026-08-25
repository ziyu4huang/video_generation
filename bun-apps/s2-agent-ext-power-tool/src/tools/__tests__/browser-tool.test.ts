/**
 * browser-tool.test.ts — integration tests for the `browser` tool.
 *
 * Chrome-gated: a real headless launch is probed ONCE at module load (before
 * test registration — bun evaluates `test.skipIf` at definition time, so a
 * beforeAll probe cannot flip it; module-load probe gives the same
 * once-per-file semantics). When system Chrome is unavailable every
 * integration test skips gracefully; the pure-seam tests still run.
 *
 * Audit-root seam: PI_POWER_BROWSER_RUNS_ROOT points at a temp dir for the
 * whole file, so no test ever writes under the real ~/.pi/power-browser.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetBrowserToolForTests,
  chromeLikelyAvailable,
  codeTimeoutMs,
  makeBrowserTool,
  resolveCloseTarget,
} from "../browser-tool.js";

interface Payload {
  ok: boolean;
  result?: unknown;
  error?: string;
  pages?: string[];
  screenshot?: string;
  runDir: string;
}

/** Drive the tool the way pi does: execute -> JSON text payload. */
async function runTool(code: string, note?: string): Promise<Payload> {
  const tool = makeBrowserTool();
  const res = await tool.execute("test-call", { code, ...(note ? { note } : {}) }, undefined, undefined, undefined as never);
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Payload;
}

// ─── Chrome probe + temp audit root (once per file) ───────────────────────────

const runsRootOverride = fs.mkdtempSync(path.join(os.tmpdir(), "power-browser-test-"));
const savedRunsRoot = process.env.PI_POWER_BROWSER_RUNS_ROOT;
const savedTimeoutMs = process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS;
process.env.PI_POWER_BROWSER_RUNS_ROOT = runsRootOverride;

let chromeOk = chromeLikelyAvailable();
if (chromeOk) {
  try {
    await runTool("'probe'"); // real headless launch — throws if it fails
  } catch {
    chromeOk = false;
  }
}
await __resetBrowserToolForTests(); // close the probe browser, reset the run dir

afterAll(async () => {
  await __resetBrowserToolForTests();
  if (savedRunsRoot === undefined) delete process.env.PI_POWER_BROWSER_RUNS_ROOT;
  else process.env.PI_POWER_BROWSER_RUNS_ROOT = savedRunsRoot;
  if (savedTimeoutMs === undefined) delete process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS;
  else process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS = savedTimeoutMs;
  fs.rmSync(runsRootOverride, { recursive: true, force: true });
});

// ─── Pure seams (no Chrome) ───────────────────────────────────────────────────

describe("pure seams", () => {
  test("codeTimeoutMs: 30s default, env override honored, garbage ignored", () => {
    delete process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS;
    expect(codeTimeoutMs()).toBe(30_000);
    process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS = "250";
    expect(codeTimeoutMs()).toBe(250);
    process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS = "not-a-number";
    expect(codeTimeoutMs()).toBe(30_000);
    process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS = "-5";
    expect(codeTimeoutMs()).toBe(30_000);
    if (savedTimeoutMs === undefined) delete process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS;
    else process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS = savedTimeoutMs;
  });

  test("chromeLikelyAvailable is a boolean filesystem probe", () => {
    expect(typeof chromeLikelyAvailable()).toBe("boolean");
  });

  test("resolveCloseTarget: numbers index, objects identity-match, unmatched designates current", () => {
    const a = {} as import("playwright-core").Page;
    const b = {} as import("playwright-core").Page;
    const proxyLike = {} as import("playwright-core").Page; // the live `page` global can never identity-match
    const pages = [a, b];
    expect(resolveCloseTarget(pages, b)).toBe(b); // no target -> current
    expect(resolveCloseTarget(pages, b, 0)).toBe(a); // numeric index
    expect(resolveCloseTarget(pages, b, 5)).toBe(null); // out of range -> null
    expect(resolveCloseTarget(pages, b, a)).toBe(a); // real reference identity-matches
    expect(resolveCloseTarget(pages, b, proxyLike)).toBe(b); // proxy-like falls back to current
    expect(resolveCloseTarget(pages, null, proxyLike)).toBe(proxyLike); // nothing live -> the target itself
  });
});

// ─── Integration (system Chrome required) ─────────────────────────────────────

describe("integration (requires system Chrome)", () => {
  test.skipIf(!chromeOk)(
    "openPage('about:blank') + snapshot: read keeps headings, act keeps buttons",
    async () => {
      const payload = await runTool(`
        const opened = await openPage("about:blank");
        await page.setContent("<h1>Probe Heading</h1><button>Go</button><p>Body copy here</p>");
        const read = await snapshot({ pruneMode: "read" });
        const act = await snapshot({ pruneMode: "act" });
        return { opened, read, act };
      `);
      expect(payload.ok).toBe(true);
      const result = payload.result as { opened: string; read: string; act: string };
      expect(result.opened).toContain("about:blank");
      // Read mode keeps content lines (and the page header carries the URL).
      expect(result.read).toContain("Probe Heading");
      expect(result.read).toContain("Body copy here");
      expect(result.read).toContain("about:blank");
      // Act mode keeps actionable elements, drops static text.
      expect(result.act).toContain('button "Go"');
      expect(result.act).not.toContain("Body copy here");
    },
  );

  test.skipIf(!chromeOk)(
    "page lifecycle: openPage reuses the implicit virgin page, closePage removes it",
    async () => {
      // Fresh state so the implicit page is THIS test's (module state persists
      // across tests — an earlier test's openPage would have consumed the flag).
      await __resetBrowserToolForTests();
      // runCode's eager ensurePage created an implicit about:blank as page 0.
      // The FIRST openPage must reuse it (no dead blank left behind); the second
      // opens a real new page; closePage(pages[...]) then removes one.
      const payload = await runTool(`
        const before = pages.length;
        await openPage("about:blank");
        const reused = pages.length - before;
        await openPage("about:blank");
        const two = pages.length - before;
        await closePage(pages[pages.length - 1]);
        const one = pages.length - before;
        return { reused, two, one };
      `);
      expect(payload.ok).toBe(true);
      const result = payload.result as { reused: number; two: number; one: number };
      expect(result.reused).toBe(0); // virgin implicit page reused, not a second blank
      expect(result.two).toBe(1);
      expect(result.one).toBe(0);
      expect(payload.pages).toBeInstanceOf(Array);
    },
  );

  test.skipIf(!chromeOk)(
    "closePage(page) via the live proxy: bookkeeping lands despite identity mismatch",
    async () => {
      const payload = await runTool(`
        await openPage("about:blank");
        await openPage("about:blank");
        const before = pages.length;
        const closed = await closePage(page);
        const after = pages.length;
        return { closed, before, after };
      `);
      expect(payload.ok).toBe(true);
      const result = payload.result as { closed: string; before: number; after: number };
      // The proxy designates current (the last opened page): it must splice by
      // real index — never the pre-fix "closed page ?" — and drop the count.
      expect(result.closed).not.toContain("?");
      expect(result.after).toBe(result.before - 1);
      // The re-pointed current still works for the next call.
      const recovery = await runTool("return await snapshot({ pruneMode: 'act' })");
      expect(recovery.ok).toBe(true);
    },
  );

  test.skipIf(!chromeOk)("error path: throwing code -> {ok:false, error} string", async () => {
    const payload = await runTool("throw new Error('boom')");
    expect(payload.ok).toBe(false);
    expect(typeof payload.error).toBe("string");
    expect(payload.error).toBe("boom");
    // Pages summaries still come back so the model knows the browser state.
    expect(payload.pages).toBeInstanceOf(Array);
  });

  test.skipIf(!chromeOk)("timeout guard: never-settling code rejects fast, then recovers", async () => {
    process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS = "200";
    const started = Date.now();
    let payload: Payload;
    try {
      payload = await runTool("await new Promise(() => {})");
    } finally {
      if (savedTimeoutMs === undefined) delete process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS;
      else process.env.PI_POWER_BROWSER_CODE_TIMEOUT_MS = savedTimeoutMs;
    }
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("timed out after 0.2s");
    expect(Date.now() - started).toBeLessThan(10_000); // guarded fast, not 30s
    // The stuck page was closed; the next call gets a fresh page and works.
    const recovery = await runTool("return await snapshot({ pruneMode: 'act' })");
    expect(recovery.ok).toBe(true);
  });

  test.skipIf(!chromeOk)("D6 audit: noted call lands in steps.jsonl line 1 under the run dir", async () => {
    await __resetBrowserToolForTests(); // fresh run dir so line 1 is OUR call
    const code = "return await openPage('about:blank')";
    const payload = await runTool(code, "opening a blank page");
    expect(payload.ok).toBe(true);
    expect(payload.runDir.startsWith(runsRootOverride)).toBe(true);
    const stepsPath = path.join(payload.runDir, "steps.jsonl");
    expect(fs.existsSync(stepsPath)).toBe(true);
    const lines = fs.readFileSync(stepsPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const step = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(typeof step.ts).toBe("string");
    expect(new Date(step.ts as string).toString()).not.toBe("Invalid Date");
    expect(step.code).toBe(code);
    expect(step.note).toBe("opening a blank page");
    expect(step.ok).toBe(true);
    expect(typeof step.resultSummary).toBe("string");
  });

  test.skipIf(!chromeOk)("default screenshot lands as shot-<n>.png in the run dir", async () => {
    const payload = await runTool("return await screenshot()");
    expect(payload.ok).toBe(true);
    const shot = payload.result as string;
    expect(shot.startsWith(payload.runDir + path.sep)).toBe(true);
    expect(path.basename(shot)).toMatch(/^shot-\d+\.png$/);
    expect(fs.existsSync(shot)).toBe(true);
    expect(payload.screenshot).toBe(shot);
  });
});
