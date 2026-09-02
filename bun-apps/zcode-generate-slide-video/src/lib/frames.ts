import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export class ToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly stderrTail?: string,
  ) {
    super(message);
  }
}

/** Run a command; reject with a readable error carrying the stderr tail. */
export async function run(tool: string, args: string[], what: string): Promise<string> {
  const child = spawn(tool, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new ToolError(`${what} failed (${tool} exited ${code})`, tool, stderr.slice(-800));
  }
  return stdout;
}

export async function requireTool(tool: string, hint: string): Promise<void> {
  try {
    await run(tool, ["-version"], `probe ${tool}`);
  } catch {
    try {
      await run(tool, ["-h"], `probe ${tool}`);
    } catch {
      throw new ToolError(`${tool} is required but not on PATH. ${hint}`, tool);
    }
  }
}

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "chromium",
];

export async function detectChrome(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    if (!candidate) continue;
    if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
    if (!candidate.startsWith("/")) {
      try {
        await run(candidate, ["--version"], `probe ${candidate}`);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  throw new ToolError("no headless Chrome found (set CHROME_BIN)", "chrome");
}

export interface FrameOptions {
  width: number;
  height: number;
  chrome: string;
  /** Extra settle time for fonts/JS, ms (virtual time budget). */
  budgetMs?: number;
}

/**
 * Screenshot one slide URL to a PNG. `slide-8.html?embed=1&…` style URLs are
 * passed through unchanged; a cache-busting query is appended so repeated runs
 * never serve a stale render.
 */
export async function screenshotSlide(
  url: string,
  outPng: string,
  opts: FrameOptions,
): Promise<void> {
  const bust = url.includes("?") ? "&" : "?";
  // NOTE: deliberately no --user-data-dir here. A fresh isolated profile per
  // run sounds safer, but REUSING one profile across sequential launches makes
  // the second launch hang indefinitely; without the flag, sequential
  // headless launches are stable (verified over many full-deck renders).
  await run(
    opts.chrome,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--disk-cache-size=1",
      `--window-size=${opts.width},${opts.height}`,
      `--virtual-time-budget=${opts.budgetMs ?? 6000}`,
      `--screenshot=${outPng}`,
      `${url}${bust}v=${Date.now()}`,
    ],
    `screenshot ${basename(outPng)}`,
  );
  if (!existsSync(outPng)) {
    throw new ToolError(`screenshot produced no file: ${outPng}`, "chrome");
  }
}

const LABEL_PATCH_FROM = "return 'map';";
const LABEL_PATCH_TO = "return 'read';";

/**
 * Write a render copy of an archify artifact slide whose viewer starts at READ
 * detail — relationship labels visible at 100% zoom. Only touches a copy; the
 * shipped slide file is never modified.
 */
export async function writeRevealLabelsCopy(
  slidePath: string,
  outPath: string,
): Promise<void> {
  const html = await Bun.file(slidePath).text();
  if (!html.includes(LABEL_PATCH_FROM)) {
    throw new ToolError(
      `revealLabels: ${basename(slidePath)} does not look like an archify artifact ` +
        `(no detailLevel map default) — remove revealLabels for this slide`,
      "reveal-labels",
    );
  }
  await mkdir(join(outPath, ".."), { recursive: true });
  await writeFile(outPath, html.replace(LABEL_PATCH_FROM, LABEL_PATCH_TO));
}

/** mkdtemp-style work dir next to nothing in particular — caller decides location. */
export async function makeWorkDir(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "slide-video-"));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
