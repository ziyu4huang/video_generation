/**
 * deploy-run.ts — locate the source s2-agent dir and spawn a script with
 * captured + logged output and a timeout.
 *
 * The devops scripts live ONLY in the source repo
 * (bun-apps/s2-agent-ext-devops/scripts/), never in a deployed tree. A
 * candidate bun-apps/ is valid only when its s2-agent-ext-devops/scripts/
 * holds them. So the tools are dev-time: they resolve the source dir
 * (PI_AGENT_DIR env, else an upward walk for a sibling s2-agent/) and refuse
 * to spawn if it can't be found.
 *
 * The probe pair used to be deploy.ts + run-test.sh. deploy.ts went with the
 * four legacy deploy modes; deploy.ts is the deploy script now, and probing
 * for a file that no longer exists would make every resolve return null —
 * pi_verify would refuse to run with "could not locate the source s2-agent
 * dir", which reads like a broken checkout rather than a stale probe.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export interface ResolveOpts {
	PI_AGENT_DIR?: string;
}

/** True when <bunApps>/s2-agent-ext-devops/scripts/ holds the devops scripts. */
function hasDevopsScripts(bunAppsDir: string): boolean {
	const scriptsDir = join(bunAppsDir, "s2-agent-ext-devops", "scripts");
	return (
		existsSync(join(scriptsDir, "deploy.ts")) && existsSync(join(scriptsDir, "run-test.sh"))
	);
}

/** Find the source bun-apps/s2-agent dir, or null if unreachable.
 *
 *  The devops SCRIPTS live in the sibling s2-agent-ext-devops package
 *  (scripts/); the returned dir is still s2-agent's — run-test.sh drives that
 *  package, and tools derive the ext-devops scripts dir from it. */
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
		const candidate = join(dir, "s2-agent");
		if (existsSync(candidate) && hasDevopsScripts(dir)) {
			return candidate;
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
