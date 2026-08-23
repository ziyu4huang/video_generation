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
	 * Omitted (the default) means no cap — unchanged behaviour for the git/gh
	 * clients, which never pass options.
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

/**
 * Wrap a SpawnFn so every call that does NOT set its own `timeoutMs` inherits
 * `defaultMs` (an explicit per-call value always wins). This is the adoption
 * seam for the git/gh clients, whose calls pass NO options at all — an
 * unbounded `git fetch` over a stalled SSH transport would then hang the whole
 * CLI for as long as the network stays silent. (RCA correction 2026-08-24: the
 * 11-minute `sync-default-branch` stall that motivated this wrap was NOT such
 * a fetch — the operator invoked the devops tool through the s2-agent TUI
 * wrapper, whose parser treats an unknown bare token as a PROMPT and starts an
 * agent session that waits on a model. The cap stands anyway: unbounded
 * network spawns are the same hazard class ci-recipe already caps, and the
 * same morning a healthy `git fetch origin` ran 2.5s.) Wrap the spawn BEFORE
 * handing it to both the recipe and `createBranchClient` — both issue bare
 * `spawn(cmd, args)` calls, so one wrap covers the entire tool surface.
 */
export function withDefaultTimeout(spawn: SpawnFn, defaultMs: number): SpawnFn {
	return (cmd, args, options) =>
		spawn(cmd, args, options?.timeoutMs === undefined ? { ...options, timeoutMs: defaultMs } : options);
}
