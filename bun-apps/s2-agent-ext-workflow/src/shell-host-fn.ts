/**
 * shell.run host-fn — execute shell commands from workflow scripts.
 *
 * Registered as "shell.run" in the session host-fn registry. Called via
 * `call("shell.run", { cmd: ["bun", "..."] })`. Deterministic, zero-token.
 *
 * Returns: { exitCode: number, stdout: string, stderr: string }
 * Caps stdout/stderr at 20k chars each to keep journaling bounded.
 *
 * Timeout + cwd are enforced at the Bun.spawnSync level, NOT only in
 * runHostFnWithTimeout: that gate races a Promise, and a synchronous
 * spawnSync blocks the event loop so its timer can never fire. Bun's native
 * sync timeout SIGTERMs the child for real.
 */

import type { HostFnCtx, HostFnRegistrationPayload } from "./host-fn-registry.js";

const MAX_OUTPUT = 20000;
const DEFAULT_TIMEOUT_MS = 30000;

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + `\n[...truncated, was ${str.length} chars]` : str;
}

/**
 * Execute a command synchronously (runs in host context where Bun is available).
 * `timeoutMs` (default 30s) is handed to Bun.spawnSync so a hanging child is
 * killed; `cwd` (from the host-fn ctx) grounds repo-relative commands.
 */
function execute(cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== "string")) {
    throw new TypeError("cmd must be a non-empty array of strings");
  }
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd || undefined,
    timeout: timeoutMs,
    stdin: "ignore",
  });
  const stdout = proc.stdout?.toString() ?? "";
  const stderr = proc.stderr?.toString() ?? "";

  return {
    // timeout kill surfaces as exitCode null + SIGTERM — map to a non-zero
    // exit so callers see failure instead of a misleading 0/NaN.
    exitCode: proc.exitCode ?? (proc.signalCode ? 124 : -1),
    stdout: truncate(stdout, MAX_OUTPUT),
    stderr: truncate(stderr, MAX_OUTPUT),
  };
}

/**
 * Registration payload for the shell.run host-fn. Extensions emit this
 * shape over the workflow:hostfn:v1:register event bus; the runtime applies
 * it via applyHostFnRegistration().
 */
export const shellRunHostFn: HostFnRegistrationPayload = {
  ns: "shell",
  name: "run",
  fn: (args: unknown, ctx: HostFnCtx) => {
    if (!args || typeof args !== "object") {
      throw new TypeError("shell.run requires args object with cmd array");
    }
    const { cmd, timeoutMs } = args as { cmd?: unknown; timeoutMs?: unknown };
    return execute(cmd as string[], {
      cwd: ctx?.cwd,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
    });
  },
  timeoutMs: 30000, // 30s default timeout for shell commands
};
