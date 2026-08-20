/**
 * spawn.ts — shared subprocess spawn helper for every compose tier + ffprobe.
 *
 * `compose.ts`, `compose_motion.ts`, `remotion.ts`, `ffprobe.ts`, and
 * `captions.ts` each previously carried their OWN byte-identical copy of this
 * exact spawn-wrapping Promise (collect stdout/stderr, resolve `{code:-1,...}`
 * on spawn error, never reject). One implementation now; each tier's
 * `spawnImpl` dependency-injection point is unchanged — callers still pass
 * `deps.spawnImpl ?? runSpawn`, so the unit tests that mock ffmpeg/swift/remotion
 * binaries keep working unchanged.
 *
 * Pure / pi-free: imports only `node:child_process`.
 */
import { spawn } from "node:child_process";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnImpl = (cmd: string, argv: string[], opts?: { cwd?: string }) => Promise<SpawnResult>;

/** The default spawn (real child_process.spawn) used when no `spawnImpl` is injected. */
export function runSpawn(cmd: string, argv: string[], opts: { cwd?: string } = {}): Promise<SpawnResult> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", () => res({ code: -1, stdout, stderr }));
    p.on("exit", (c) => res({ code: c ?? -1, stdout, stderr }));
  });
}
