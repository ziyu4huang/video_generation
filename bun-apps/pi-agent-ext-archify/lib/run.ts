import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Absolute path to the package-local vendored archify CLI. */
export const VENDORED_BIN = join(PKG_ROOT, "vendored/bin/archify.mjs");

export interface ArchifyResult { stdout: string; stderr: string; status: number | null }

/** Run the local vendored archify CLI under Bun. Never shells out to ../archify. */
export function runArchify(args: string[], cwd: string): ArchifyResult {
  const r = spawnSync("bun", [VENDORED_BIN, ...args], { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/** Write an IR object to a temp file, run fn(irPath), then clean up. */
export function withTempIr<T>(ir: unknown, fn: (irPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "archify-ir-"));
  const irPath = join(dir, "ir.json");
  try {
    writeFileSync(irPath, JSON.stringify(ir));
    return fn(irPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
