/**
 * run.ts — locate the source pi-agent dir, path-guard outDir, and spawn a
 * script with captured + logged output and a timeout.
 *
 * deploy.ts and run-test.sh live ONLY in the source repo
 * (bun-apps/pi-agent-ext-devops/scripts/), never in a deployed bundle. The
 * resolver still returns the pi-agent package dir (deploy.ts requires that
 * cwd); a candidate is valid only when its SIBLING pi-agent-ext-devops/
 * contains scripts/deploy.ts + scripts/run-test.sh. So the tools are dev-time:
 * they resolve the source dir (PI_AGENT_DIR env, else an upward walk for a
 * sibling pi-agent/) and refuse to spawn if it can't be found.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export interface ResolveOpts {
	PI_AGENT_DIR?: string;
}

/** True when <bunApps>/pi-agent-ext-devops/scripts/ holds the devops scripts. */
function hasDevopsScripts(bunAppsDir: string): boolean {
	const scriptsDir = join(bunAppsDir, "pi-agent-ext-devops", "scripts");
	return (
		existsSync(join(scriptsDir, "deploy.ts")) && existsSync(join(scriptsDir, "run-test.sh"))
	);
}

/** Find the source bun-apps/pi-agent dir, or null if unreachable.
 *
 *  The deploy/run-test SCRIPTS live in the sibling pi-agent-ext-devops package
 *  (scripts/); the returned dir is still pi-agent's — deploy.ts must run with
 *  that package as cwd, and tools derive the ext-devops scripts dir from it. */
export function resolvePiAgentDir(
	env: ResolveOpts = (process.env as unknown as ResolveOpts),
	modUrl: string = import.meta.url,
): string | null {
	const envDir = env.PI_AGENT_DIR;
	if (envDir && hasDevopsScripts(dirname(envDir))) {
		return envDir;
	}
	let dir = dirname(fileURLToPath(modUrl));
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "pi-agent");
		if (existsSync(candidate) && hasDevopsScripts(dir)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * outDir must resolve under <repo>/dist/ or the OS temp dir. Throws otherwise.
 *
 * Note: the tmpdir escape hatch applies only to paths OUTSIDE the repo. A path
 * inside the repo (which may itself live under tmpdir in tests) is rejected
 * unless it is under <repo>/dist/ — writing into the source tree is never safe.
 */
export function assertSafeOutDir(outDir: string, repoRoot: string): void {
	const abs = isAbsolute(outDir) ? resolve(outDir) : resolve(repoRoot, outDir);
	if (isWithin(resolve(repoRoot, "dist"), abs)) return;
	if (isWithin(resolve(repoRoot), abs)) {
		throw new Error(`outDir must be under <repo>/dist/ or ${tmpdir()} (got ${abs})`);
	}
	if (isWithin(resolve(tmpdir()), abs)) return;
	throw new Error(`outDir must be under <repo>/dist/ or ${tmpdir()} (got ${abs})`);
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

/** Spawn cmd+args at cwd, tee combined stdout+stderr to a log file, enforce a timeout. */
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
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
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
