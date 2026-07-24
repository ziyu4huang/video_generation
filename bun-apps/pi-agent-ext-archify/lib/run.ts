import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Absolute path to the package-local vendored archify CLI. */
export const VENDORED_BIN = join(PKG_ROOT, "vendored/bin/archify.mjs");

export interface ArchifyResult { stdout: string; stderr: string; status: number | null }

/**
 * Run the local vendored archify CLI asynchronously so it never blocks the
 * event loop, using the current runtime (`process.execPath`) so it does not
 * depend on `bun` being resolvable on PATH. An optional AbortSignal cancels
 * the child. Never shells out to ../archify.
 */
export function runArchify(args: string[], cwd: string, signal?: AbortSignal): Promise<ArchifyResult> {
  return new Promise((resolve) => {
    // `encoding: "utf8"` collapses @types/node's spawn overloads to `never`;
    // annotate as ChildProcess and decode chunks manually instead.
    const child: ChildProcess = spawn(process.execPath, [VENDORED_BIN, ...args], { cwd, signal });
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
