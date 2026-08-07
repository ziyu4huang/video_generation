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
}

export interface SpawnOptions {
	/** Working directory for this single call. Falls back to the baked-in default. */
	cwd?: string;
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
		const proc = Bun.spawn([cmd, ...args], { cwd: options?.cwd ?? cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			Bun.readableStreamToText(proc.stdout),
			Bun.readableStreamToText(proc.stderr),
		]);
		return { stdout, stderr, exitCode: await proc.exited };
	};
}
