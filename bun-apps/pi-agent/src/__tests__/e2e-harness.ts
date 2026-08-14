/**
 * e2e-harness — shared build + spawn helpers for pi-agent's bundle-mode e2e.
 *
 * WHY A SEPARATE GATE
 * -------------------
 * The unit suite (patches/index.test.ts, default-model-env.test.ts, …) tests
 * PURE decision logic — it never builds the bundle or runs `main()`. That
 * leaves a gap: the things that only break in bundle mode (a patch module the
 * static-literal switch failed to include, an asset path that resolves wrong
 * once bundled, a cwd-coupled extension loader). Those need a real
 * `bun dist/pi-agent/pi-agent.js` spawn. Builds are slow, so the e2e test
 * files gate on PI_AGENT_E2E=1 and call ensureBundle() in beforeAll; a plain
 * `bun test` (the pre-extension-dev baseline) skips them and stays fast.
 *
 * `bun-apps/pi-agent-ext-devops/scripts/run-test.sh` sets PI_AGENT_E2E=1 for the full run.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** bun-apps/pi-agent (this package). import.meta.dir = <pkg>/src/__tests__ */
export const PI_AGENT_DIR = dirname(dirname(import.meta.dir));
/** repo root (the dist/ tree lives here, not inside the package). */
export const REPO_ROOT = dirname(dirname(PI_AGENT_DIR));
/** Source-mode entry — what `bun src/cli.ts` runs. */
export const SRC_CLI = join(PI_AGENT_DIR, "src", "cli.ts");
/** Bundle entry, produced by `bun scripts/deploy.ts` default (--bundle) mode. */
export const DIST_BUNDLE = join(REPO_ROOT, "dist", "pi-agent", "pi-agent.js");

const truthy = (v: string | undefined) =>
	v === "1" || v === "true" || v === "yes";

/** E2E fires only when PI_AGENT_E2E is set; otherwise test files skip themselves. */
export const E2E_ENABLED = truthy(process.env.PI_AGENT_E2E);

/**
 * The deploy+4-cwd extension e2e (~15s — it builds a deploy package and runs
 * `bun install` inside it) is gated BEHIND PI_AGENT_E2E_DEPLOY so `run-test.sh`
 * can offer a middle tier: medium = build + patch e2e (cheap), high = + deploy.
 * e2e-extensions requires BOTH flags; e2e-patches needs only PI_AGENT_E2E.
 */
export const DEPLOY_ENABLED = truthy(process.env.PI_AGENT_E2E_DEPLOY);

let bundlePromise: Promise<string> | null = null;

/**
 * Build the bundle once per test run (cached). Set PI_AGENT_E2E_NO_BUILD=1 to
 * reuse an existing dist/pi-agent/pi-agent.js (faster re-runs during dev).
 * Returns the bundle path; throws if the build fails or the file is absent.
 */
export function ensureBundle(): Promise<string> {
	if (bundlePromise) return bundlePromise;
	bundlePromise = (async () => {
		if (existsSync(DIST_BUNDLE) && truthy(process.env.PI_AGENT_E2E_NO_BUILD)) {
			return DIST_BUNDLE;
		}
		const build = Bun.spawn(["bun", "scripts/deploy.ts"], {
			cwd: PI_AGENT_DIR,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await build.exited;
		if (code !== 0) throw new Error(`bun scripts/deploy.ts exited ${code}`);
		if (!existsSync(DIST_BUNDLE)) {
			throw new Error(`build ok but ${DIST_BUNDLE} not found`);
		}
		return DIST_BUNDLE;
	})();
	return bundlePromise;
}

export interface SpawnResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

/**
 * Spawn `bun <bundle> <args…>` and collect output. Default cwd = REPO_ROOT so
 * the bundle's neighbor node_modules symlink resolves. `timeoutMs` kills the
 * process (the e2e must never hang the suite — e.g. if a regression makes pi
 * wait on a model call instead of honoring --help).
 */
export async function runBundle(
	args: string[],
	opts: {
		env?: Record<string, string | undefined>;
		cwd?: string;
		timeoutMs?: number;
	} = {},
): Promise<SpawnResult> {
	const bundle = await ensureBundle();
	const proc = Bun.spawn(["bun", bundle, ...args], {
		cwd: opts.cwd ?? REPO_ROOT,
		env: { ...process.env, ...opts.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const timer = setTimeout(() => {
		try {
			process.stderr.write(
				`\n[e2e-harness] timeout (${timeoutMs}ms) killing bun ${bundle} ${args.join(" ")}\n`,
			);
			proc.kill();
		} catch {
			/* already exited */
		}
	}, timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		return { stdout, stderr, code };
	} finally {
		clearTimeout(timer);
	}
}
