/**
 * Spawn abstraction shared across the DevOps tools.
 *
 * `SpawnFn` is the injectable seam between PURE orchestration (src/recipe.ts,
 * src/ci-recipe.ts, …) and the real `Bun.spawn` stdlib call. It lives here —
 * rather than in extensions/devops.ts — so every src/ module can import it
 * without an `extensions/ → src/ → extensions/` import cycle, and so the ONE
 * untested seam (`createLiveSpawn`, a thin stdlib passthrough) sits next to its
 * own type. Previously `SpawnFn`/`SpawnResult` were defined in src/gh.ts and the
 * live factory (`liveSpawn`) was inlined in extensions/devops.ts; both are now
 * consolidated here.
 *
 * The optional third `options` arg carries a per-call `cwd` override.
 * Orchestration that drives commands in SEVERAL directories (ci-recipe runs
 * `bun run test` inside each `bun-apps/<pkg>/`) passes `options.cwd` per call;
 * the baked-in default cwd (the repo root) is used when omitted — so the
 * existing gh/branch clients, which never pass options, are unchanged. Adding an
 * optional trailing parameter is backwards-compatible: a `(cmd, args) => …`
 * function is still assignable to `(cmd, args, options?) => …`.
 */
import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/**
	 * True when the call hit its `timeoutMs` cap and was SIGKILLed (exitCode is
	 * then `SPAWN_TIMEOUT_EXIT_CODE`). Needed by callers that branch on the
	 * timeout reason rather than the exit code alone (oneshot-smoke gate).
	 */
	timedOut?: boolean;
}

/** Exit code reported for a command killed by `timeoutMs`. Matches GNU `timeout`. */
export const SPAWN_TIMEOUT_EXIT_CODE = 124;

export interface SpawnOptions {
	/** Working directory for this single call. Falls back to the baked-in default. */
	cwd?: string;
	/**
	 * Hard wall-clock cap in ms. On expiry the child's WHOLE PROCESS GROUP is
	 * SIGKILLed and the call resolves with `SPAWN_TIMEOUT_EXIT_CODE` (124).
	 * Omitted (the default) means no cap at THIS layer — entry points that
	 * wrap their spawn in `withDefaultTimeout` still bound every call.
	 *
	 * The group, not the child, is the unit that must die. A matrix row is run as
	 * `bash -c "bun test --isolate"`, so killing only the direct child reaps
	 * `bash` and leaves `bun test` running — verified: a grandchild survives
	 * Bun.spawn's own `timeout` option. That is exactly how this repo accumulated
	 * a `bun test --isolate` orphan that spun at 100% CPU for six hours and made
	 * every later run in the same worktree hang.
	 *
	 * Group-kill portability (macOS + Linux): the timeout path spawns via
	 * node:child_process with `detached: true`, which on both POSIX platforms
	 * puts the child in its OWN process group as leader — `kill(-pid)` then
	 * reaches the whole tree without any external helper. The former
	 * `/usr/bin/perl -e 'setpgrp(0,0); exec …'` wrapper assumed macOS's base-system
	 * perl; verified empirically under Bun (detached + group-kill + grandchild
	 * death, 2026-08-22).
	 */
	timeoutMs?: number;
}

/**
 * Injectable process-spawn function. Real impl: `createLiveSpawn` (Bun.spawn).
 * Tests inject a recording fake. The optional `options.cwd` overrides the
 * baked-in default cwd for one call.
 */
export type SpawnFn = (cmd: string, args: string[], options?: SpawnOptions) => Promise<SpawnResult>;

/**
 * Timeout-path spawn: node:child_process with `detached: true` so the child is
 * its own process-group LEADER and `kill(-pid)` reaches the whole tree on both
 * macOS and Linux (see SpawnOptions.timeoutMs for the rationale + the retired
 * perl wrapper). Kept separate from the Bun.spawn fast path: Bun.spawn has no
 * `detached` option, and only calls WITH a cap need group semantics.
 */
function spawnDetached(
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<SpawnResult & { timedOut: boolean }> {
	return new Promise((resolveP) => {
		const proc = nodeSpawn(cmd, args, {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (d: string) => (stdout += d));
		proc.stderr?.on("data", (d: string) => (stderr += d));
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				proc.kill("SIGKILL"); // group gone or never formed — fall back to the child
			}
		}, timeoutMs);
		const finish = (exitCode: number) => {
			clearTimeout(timer);
			resolveP(
				timedOut
					? {
							stdout,
							stderr: `${stderr}\n[spawn] KILLED after ${timeoutMs}ms — command exceeded its timeout`,
							exitCode: SPAWN_TIMEOUT_EXIT_CODE,
							// Flag the timeout reason for callers (oneshot-smoke) that branch
							// on it rather than on the exit code alone.
							timedOut: true,
						}
					: { stdout, stderr, exitCode, timedOut: false },
			);
		};
		proc.on("error", (err) => {
			stderr += `\n[spawn] ${String(err)}`;
			finish(-1);
		});
		proc.on("close", (code) => finish(code ?? -1));
	});
}

/**
 * Wrap a SpawnFn so EVERY call gets a hard wall-clock cap: an explicit
 * per-call `options.timeoutMs` wins, otherwise `defaultTimeoutMs` applies.
 *
 * WHY: the timeout machinery above existed but was opt-in per call site, and
 * the git/gh clients never opted in — a stalled network op (`git fetch`, gh
 * api, `submodule update --remote`) then hung the whole recipe indefinitely
 * (observed: sync-default-branch stuck 11+ minutes on a transient SSH stall,
 * 2026-08-24). Wrapping at the entry point (CLI / extension tool) instead of
 * threading a timeout through every recipe option keeps the recipes
 * timeout-agnostic while bounding the live surface.
 */
export function withDefaultTimeout(spawn: SpawnFn, defaultTimeoutMs: number): SpawnFn {
	return (cmd, args, options) =>
		spawn(cmd, args, { ...options, timeoutMs: options?.timeoutMs ?? defaultTimeoutMs });
}

/**
 * Live Bun.spawn adapter — the only untested seam (thin stdlib passthrough).
 * `cwd` is the default working directory; a caller may override it per call via
 * the third `options.cwd` argument.
 */
export function createLiveSpawn(cwd: string): SpawnFn {
	return async (cmd, args, options) => {
		// With a cap, take the detached/group-kill path (see spawnDetached).
		// Without one, spawn exactly as before — one fewer moving part on the
		// path every gh/git call takes.
		if (options?.timeoutMs !== undefined) {
			return spawnDetached(cmd, args, options.cwd ?? cwd, options.timeoutMs);
		}
		const proc = Bun.spawn([cmd, ...args], { cwd: options?.cwd ?? cwd, stdout: "pipe", stderr: "pipe" });
		// Reading to EOF is what makes a hung child hang the CALLER: these two
		// awaits never resolve while any descendant holds the pipe open.
		const [stdout, stderr] = await Promise.all([
			Bun.readableStreamToText(proc.stdout),
			Bun.readableStreamToText(proc.stderr),
		]);
		const exitCode = await proc.exited;
		return { stdout, stderr, exitCode };
	};
}
