/**
 * deploy-run.ts — locate the source s2-agent dir and spawn a script with
 * captured + logged output and a timeout.
 *
 * The devops scripts live ONLY in the source repo
 * (bun-apps/s2-agent-ext-devops/ — deploy library in src/deploy/, runnable
 * entries in scripts/), never in a deployed tree. A
 * candidate bun-apps/ is valid only when its s2-agent-ext-devops holds them. So the tools are dev-time: they resolve the source dir
 * (PI_AGENT_DIR env > the #pi/ext-dir walk > the cwd walk — a dist-hosted
 * session inside a source worktree resolves via cwd) and refuse
 * to spawn if it can't be found.
 *
 * The probe pair is src/deploy/run.ts + scripts/run-test.ts. It used to be
 * scripts/deploy.ts + run-test.sh (the pre-Bun-port name); whenever a probed
 * file moves, EVERY probe must move with it or every resolve returns null —
 * pi_verify would refuse to run with "could not locate the source s2-agent
 * dir", which reads like a broken checkout rather than a stale probe.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export interface ResolveOpts {
	PI_AGENT_DIR?: string;
}

/** True when <bunApps>/s2-agent-ext-devops looks like the source package:
 *  the deploy library in src/deploy/ plus the runnable scripts/ entries. */
function hasDevopsScripts(bunAppsDir: string): boolean {
	const pkg = join(bunAppsDir, "s2-agent-ext-devops");
	return (
		existsSync(join(pkg, "src", "deploy", "run.ts")) &&
		existsSync(join(pkg, "scripts", "run-test.ts"))
	);
}

/**
 * Start dir for the source-repo walk, via the `#pi/ext-dir` idiom.
 *
 * In the DEPLOYED bundle the specifier is bundler-external and the loader's
 * injected require serves it as the deployed ext/<name>/ dir (a string); the
 * walk from there finds no source repo → null → the caller fails closed. In
 * SOURCE mode the package.json `imports` map resolves it to
 * src/sh-ext-dir.ts, whose default export is this package's root. The two
 * forms are told apart at the require site — never statically imported (the
 * module must stay out of any bundle graph; see sh-ext-dir.ts).
 */
function extDirStart(): string | undefined {
	try {
		const m = require("#pi/ext-dir") as unknown;
		if (typeof m === "string") return m; // dist loader: the deployed ext dir
		if (typeof m === "object" && m !== null && typeof (m as { default?: unknown }).default === "string") {
			return (m as { default: string }).default; // source mode: package root
		}
	} catch {
		// No loader and no imports map — fall through to the cwd rung.
	}
	return undefined;
}

/**
 * Find the source bun-apps/s2-agent dir, or null if unreachable.
 *
 *  The devops SCRIPTS live in the sibling s2-agent-ext-devops package
 *  (scripts/); the returned dir is still s2-agent's — run-test.ts drives that
 *  package, and tools derive the ext-devops scripts dir from it.
 *
 *  Ladder (first hit wins): explicit `startDir` (a TEST seam that replaces
 *  the whole default ladder) > the `#pi/ext-dir` rung > **the cwd rung**.
 *  The cwd rung is the dist-hosted fix: a session launched from a deployed
 *  dist gets an ext-dir inside the dist tree, whose walk finds no source
 *  repo — but that session very often sits in a source WORKTREE as its cwd,
 *  so cwd is walked before giving up (2026-08-29; previously the cwd was
 *  only the fallback when the ext-dir rung was absent, and a dist-hosted
 *  session inside a worktree failed with "Could not locate the source
 *  s2-agent dir"). At each rung BOTH the dir itself and its `bun-apps/`
 *  subdir are tried as the base, so a cwd at a repo ROOT (not inside
 *  bun-apps) still resolves.
 *
 *  It used to start from this module's import.meta.url — but a cjs bundle
 *  folds that into the build machine's path, which the deploy relocatability
 *  gate rejects, so the default is resolved at CALL time instead. */
export function resolvePiAgentDir(
	env: ResolveOpts = (process.env as unknown as ResolveOpts),
	startDir?: string,
	deps: { extDirStart?: () => string | undefined } = {},
): string | null {
	const envDir = env.PI_AGENT_DIR;
	if (envDir && hasDevopsScripts(dirname(envDir))) {
		return envDir;
	}
	if (startDir) {
		return walkUpForS2Agent(startDir);
	}
	const extDirRung = deps.extDirStart ? deps.extDirStart() : extDirStart();
	if (extDirRung) {
		const found = walkUpForS2Agent(extDirRung);
		if (found) return found;
	}
	return walkUpForS2Agent(process.cwd());
}

/** Upward walk from `start` (≤8 rungs): each rung tries the dir itself AND
 *  its `bun-apps/` subdir as the bun-apps base whose `s2-agent` + devops
 *  scripts make a valid source repo. Returns the s2-agent dir or null. */
function walkUpForS2Agent(start: string): string | null {
	let dir = start;
	for (let i = 0; i < 8; i++) {
		for (const base of [dir, join(dir, "bun-apps")]) {
			if (hasDevopsScripts(base) && existsSync(join(base, "s2-agent"))) {
				return join(base, "s2-agent");
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export interface RunOpts {
	cmd: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
	logName: string;
}

export interface RunResult {
	exitCode: number;
	output: string;
	logPath: string;
	timedOut: boolean;
}

/**
 * Spawn cmd+args at cwd, tee combined stdout+stderr to a log file, enforce a timeout.
 *
 * NOT unified onto src/spawn.ts's SpawnFn — deliberately a separate
 * implementation: the contracts differ (this one tees a combined
 * stdout+stderr stream to a log file and resolves raw Buffers; SpawnFn returns
 * stdout/stderr as separate strings). What they DO share is the group-kill
 * discipline: on timeout the whole process group dies (`detached: true` +
 * `kill(-pid)`), because killing only the direct child reaps e.g. `bash` and
 * orphans whatever `run-test.ts` spawned beneath it — the same class of
 * incident SpawnOptions.timeoutMs documents.
 */
export function runScript(opts: RunOpts): Promise<RunResult> {
	const logDir = join(tmpdir(), "pi-deploy-ext-logs");
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, `${opts.logName}-${process.pid}-${Date.now()}.log`);
	const writeStream = createWriteStream(logPath);
	return new Promise((resolveP) => {
		const chunks: Buffer[] = [];
		let timedOut = false;
		const proc = spawn(opts.cmd, opts.args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				proc.kill("SIGKILL"); // group gone or never formed — fall back to the child
			}
		}, opts.timeoutMs);
		const onChunk = (b: Buffer) => {
			chunks.push(b);
			writeStream.write(b);
		};
		proc.stdout?.on("data", onChunk);
		proc.stderr?.on("data", onChunk);
		proc.on("error", (err) => {
			clearTimeout(timer);
			writeStream.end(() => resolveP({ exitCode: -1, output: String(err), logPath, timedOut }));
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			writeStream.end(() =>
				resolveP({ exitCode: code ?? -1, output: Buffer.concat(chunks).toString("utf8"), logPath, timedOut }),
			);
		});
	});
}

/** Last ~40 non-empty lines of output, for an errorTail summary. */
export function tailOutput(output: string, lines = 40): string {
	const all = output.split("\n").filter((l) => l.trim().length > 0);
	return all.slice(-lines).join("\n");
}
