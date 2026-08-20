import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(MODULE_DIR, "..");

/**
 * Resolve the vendored archify CLI across source / snapshot / bundle deploy
 * modes. Ladder: (1) PI_ARCHIFY_BIN env override, (2) walk-up probe for
 * `vendored/bin/archify.mjs` from startDir upward (bounded to 6 levels), (3)
 * legacy source-relative fallback (preserves prior behavior when nothing is
 * found, so the pre-flight guard — not a throw — surfaces the problem).
 */
export function resolveVendoredBin(startDir: string = MODULE_DIR): string {
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
  return join(PKG_ROOT, "vendored", "bin", "archify.mjs");
}

/** Absolute path to the vendored archify CLI, resolved once at module load. */
export const VENDORED_BIN = resolveVendoredBin();

/** Surfaced when the resolved bin does not exist on disk (deploy omitted vendored/). */
function binMissingMessage(path: string): string {
  return `archify vendored bin not found at ${path}; deploy may have omitted vendored/ (set PI_ARCHIFY_BIN to override).`;
}

export interface ArchifyResult { stdout: string; stderr: string; status: number | null }

/**
 * Run the local vendored archify CLI asynchronously so it never blocks the
 * event loop, using the current runtime (`process.execPath`) so it does not
 * depend on `bun` being resolvable on PATH. An optional AbortSignal cancels
 * the child. Never shells out to ../archify.
 */
export function runArchify(args: string[], cwd: string, signal?: AbortSignal, bin: string = VENDORED_BIN): Promise<ArchifyResult> {
  return new Promise((resolve) => {
    if (!existsSync(bin)) {
      resolve({ stdout: "", stderr: binMissingMessage(bin), status: 1 });
      return;
    }
    // `encoding: "utf8"` collapses @types/node's spawn overloads to `never`;
    // annotate as ChildProcess and decode chunks manually instead.
    const child: ChildProcess = spawn(process.execPath, [bin, ...args], { cwd, signal });
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
