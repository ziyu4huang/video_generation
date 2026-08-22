import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, join, delimiter } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * dsh-archify bundle-relative root.
 *
 * The s2-agent extension resolved the vendored tree through the `#pi/ext-dir`
 * imports idiom, which the bun cjs bundler folds into a build-machine path
 * literal (the exact failure that shipped #809). A DSH bundle is NOT compiled
 * into a single file — it ships as source and is imported by the Node host as
 * ESM — so `import.meta.url` resolves to the real on-disk location, making the
 * vendored tree reachable directly beside `lib/`.
 */
const BUNDLE_LIB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the vendored archify CLI across source / installed-bundle modes.
 * Ladder: (1) `ARCHIFY_BIN` env override, (2) walk-up probe for
 * `vendored/bin/archify.mjs` from the bundle lib dir (bounded to 6 levels),
 * defaulting to `process.cwd()`. When nothing is found the last candidate is
 * returned so the pre-flight guard — not a throw — surfaces the problem.
 */
export function resolveVendoredBin(startDir: string = BUNDLE_LIB_DIR): string {
  const fromEnv = process.env.ARCHIFY_BIN;
  if (fromEnv) return fromEnv;
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "vendored", "bin", "archify.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dir, "vendored", "bin", "archify.mjs");
}

/** Absolute path to the vendored archify CLI, resolved once at module load. */
export const VENDORED_BIN = resolveVendoredBin();

/**
 * Scan `PATH` for a runnable `bun` executable.
 *
 * The DSH host runs under Node, so `globalThis.Bun` (the s2-agent's
 * `Bun.which` route) is undefined here. We locate `bun` on PATH directly —
 * the same ladder step the design (D1) prescribes.
 */
function whichBun(): string {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of ["bun", "bun.exe"]) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* unreadable candidate — keep scanning */
      }
    }
  }
  return "";
}

/**
 * Resolve the JavaScript runtime that can execute the vendored .mjs bins.
 *
 * Ladder: (1) `ARCHIFY_RUNTIME` env override, (2) a real `bun` on PATH,
 * (3) `process.execPath` when its basename is literally "bun" (a bun-hosted
 * process). Empty string when nothing resolves — `runArchify` then surfaces a
 * clear failure instead of spawning the wrong entry.
 */
export function resolveRuntime(): string {
  const fromEnv = process.env.ARCHIFY_RUNTIME;
  if (fromEnv) return fromEnv;
  const onPath = whichBun();
  if (onPath) return onPath;
  if (basename(process.execPath) === "bun") return process.execPath;
  return "";
}

/** Surfaced when the resolved bin does not exist on disk (deploy omitted vendored/). */
function binMissingMessage(path: string): string {
  return `archify vendored bin not found at ${path}; the bundle may be missing vendored/ (set ARCHIFY_BIN to override).`;
}

/** Surfaced when no runtime can execute the .mjs bins (host without bun on PATH). */
function runtimeMissingMessage(): string {
  return (
    "archify found no JavaScript runtime to execute its vendored bins: " +
    "install bun on PATH or set ARCHIFY_RUNTIME to a bun executable " +
    "(process.execPath is the Node host and cannot run the vendored scripts)."
  );
}

export interface ArchifyResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Run the local vendored archify CLI asynchronously so it never blocks the
 * event loop, using a resolvable script runtime (see resolveRuntime). An
 * optional AbortSignal cancels the child. Never shells out to ../archify.
 */
export function runArchify(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  bin: string = VENDORED_BIN,
  runner: string = resolveRuntime(),
): Promise<ArchifyResult> {
  return new Promise((resolve) => {
    if (!existsSync(bin)) {
      resolve({ stdout: "", stderr: binMissingMessage(bin), status: 1 });
      return;
    }
    if (!runner) {
      resolve({ stdout: "", stderr: runtimeMissingMessage(), status: 1 });
      return;
    }
    // `encoding: "utf8"` collapses @types/node's spawn overloads to `never`;
    // annotate as ChildProcess and decode chunks manually instead.
    const child: ChildProcess = spawn(runner, [bin, ...args], { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Uint8Array) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    // Both `error` (spawn/abort failure) and `close` resolve — we never reject,
    // so callers can treat a non-zero/null status uniformly as failure.
    child.on("error", () => resolve({ stdout, stderr, status: null }));
    child.on("close", (code) => resolve({ stdout, stderr, status: code }));
  });
}

/** Write an IR object to a temp file, await fn(irPath), then clean up. */
export async function withTempIr<T>(ir: unknown, fn: (irPath: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "archify-ir-"));
  const irPath = join(dir, "ir.json");
  try {
    writeFileSync(irPath, JSON.stringify(ir));
    return await fn(irPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
