import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";

/**
 * Locate this package's root through the `#pi/ext-dir` idiom (obsidian
 * src/lib/ext-dir.ts reference form). Deliberately NOT import.meta.url:
 * bun's cjs bundler folds it into a build-machine path literal, which the sh
 * deploy's relocatability gate (scanForeignPaths) rejects — the exact failure
 * that shipped #809's "vendored bin unresolved under the default deploy mode".
 * Resolution order:
 *   1. sh deploy: require("#pi/ext-dir") → the deployed ext dir (vendored/
 *      copied beside ext.cjs by the registry's copy: [vendored])
 *   2. jiti/source/bun test: package.json "#pi/ext-dir" imports entry
 *      (lib/sh-ext-dir.ts, real __dirname) → the package root
 *   3. unresolvable → undefined; resolveVendoredBin falls back to a cwd
 *      walk-up so a missing bin surfaces via the pre-flight guard, not a throw.
 */
function shExtDir(): string | undefined {
	try {
		if (typeof require === "function") {
			const mod = require("#pi/ext-dir") as { default?: unknown } | string;
			if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
			if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
				return mod.default; // imports entry: the package root
			}
		}
	} catch {
		// Not resolvable here (native ESM without the loader) — fall through.
	}
	return undefined;
}

const DEFAULT_START_DIR = shExtDir();

/**
 * Resolve the vendored archify CLI across source / sh-deploy modes. Ladder:
 * (1) PI_ARCHIFY_BIN env override, (2) startDir itself, (3) walk-up probe for
 * `vendored/bin/archify.mjs` upward (bounded to 6 levels) — defaulting to the
 * #pi/ext-dir root, so resolution never depends on the caller's cwd. When
 * nothing is found the last candidate is returned so the pre-flight guard —
 * not a throw — surfaces the problem.
 */
export function resolveVendoredBin(startDir: string = DEFAULT_START_DIR ?? process.cwd()): string {
  const fromEnv = process.env.PI_ARCHIFY_BIN;
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
 * Resolve the JavaScript runtime that can execute the vendored .mjs bins.
 *
 * process.execPath is only usable when it IS bun by name (test/jiti runs, or
 * a deploy whose launcher execs the shipped bun): a self-contained host
 * entry would run the AGENT CLI when spawned with a script path, not the
 * script. Ladder: (1) PI_ARCHIFY_RUNTIME env override, (2) a real `bun` on
 * PATH, (3) process.execPath when its basename is literally "bun". Empty
 * string when nothing resolves — runArchify then surfaces a clear failure
 * instead of spawning a wrong runtime.
 */
export function resolveRuntime(): string {
  const fromEnv = process.env.PI_ARCHIFY_RUNTIME;
  if (fromEnv) return fromEnv;
  const bunGlobal = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun;
  const onPath = bunGlobal?.which?.("bun");
  if (onPath) return onPath;
  if (basename(process.execPath) === "bun") return process.execPath;
  return "";
}

/** Surfaced when the resolved bin does not exist on disk (deploy omitted vendored/). */
function binMissingMessage(path: string): string {
  return `archify vendored bin not found at ${path}; deploy may have omitted vendored/ (set PI_ARCHIFY_BIN to override).`;
}

/** Surfaced when no runtime can execute the .mjs bins (no bun on PATH, execPath not bun). */
function runtimeMissingMessage(): string {
  return (
    "archify found no JavaScript runtime to execute its vendored bins: " +
    "install bun on PATH or set PI_ARCHIFY_RUNTIME to a bun executable " +
    "(process.execPath is not a usable script runtime)."
  );
}

export interface ArchifyResult { stdout: string; stderr: string; status: number | null }

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
    child.stdout?.on("data", (chunk: Uint8Array) => { stdout += Buffer.from(chunk).toString("utf8"); });
    child.stderr?.on("data", (chunk: Uint8Array) => { stderr += Buffer.from(chunk).toString("utf8"); });
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
