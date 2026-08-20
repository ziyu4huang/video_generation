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
 * Live Bun.spawn adapter — the only untested seam (thin stdlib passthrough).
 * `cwd` is the default working directory; a caller may override it per call via
 * the third `options.cwd` argument.
 */
export function createLiveSpawn(cwd: string): SpawnFn {
	return async (cmd, args, options) => {
		const timeoutMs = options?.timeoutMs;
		// Without a cap, spawn exactly as before — one fewer moving part on the
		// path every gh/git call takes.
		const argv =
			timeoutMs === undefined
				? [cmd, ...args]
				: // Make the child a process-group LEADER so `kill(-pid)` reaches the
					// whole tree. macOS ships no `setsid(1)`; /usr/bin/perl is part of the
					// base system and setpgrp(0,0) is one call.
					["/usr/bin/perl", "-e", "setpgrp(0,0); exec @ARGV or die $!", "--", cmd, ...args];
		const proc = Bun.spawn(argv, { cwd: options?.cwd ?? cwd, stdout: "pipe", stderr: "pipe" });

		let timedOut = false;
		const timer =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						try {
							process.kill(-proc.pid, "SIGKILL");
						} catch {
							proc.kill(9); // group gone or never formed — fall back to the child
						}
					}, timeoutMs);

		try {
			// Reading to EOF is what makes a hung child hang the CALLER: these two
			// awaits never resolve while any descendant holds the pipe open. The
			// group-kill above is what closes them.
			const [stdout, stderr] = await Promise.all([
				Bun.readableStreamToText(proc.stdout),
				Bun.readableStreamToText(proc.stderr),
			]);
			const exitCode = await proc.exited;
			if (timedOut) {
				return {
					stdout,
					stderr: `${stderr}\n[spawn] KILLED after ${timeoutMs}ms — command exceeded its timeout`,
					exitCode: SPAWN_TIMEOUT_EXIT_CODE,
					// Flag the timeout reason for callers (oneshot-smoke) that branch on
					// it rather than on the exit code alone.
					timedOut: true,
				};
			}
			return { stdout, stderr, exitCode };
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
}
