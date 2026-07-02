/**
 * e2e-harness — shared build + spawn helpers for pi-agent-cli's deploy e2e.
 *
 * WHY A SEPARATE GATE
 * -------------------
 * The unit suite (args/dispatch/passthrough/shared/doctor/…) tests PURE logic —
 * it never builds the bundle or spawns the CLI. That leaves a gap: the things
 * that only break in bundle mode (a static import the bundler dropped, an asset
 * path that resolves wrong once bundled, a cwd-coupled resolver). Those need a
 * real `bun dist/pi-agent-cli/cli.js` spawn. Builds are slow, so the e2e test
 * files gate on PICLI_E2E=1 and call ensureBundle() in beforeAll; a plain
 * `bun test` (the pre-commit baseline) skips them and stays fast.
 *
 * `bun-apps/pi-agent-cli/run-test.sh` sets PICLI_E2E=1 for the full run.
 *
 * Ported from bun-apps/pi-agent/src/__tests__/e2e-harness.ts (same shape; the
 * cli-specific difference is runBundle's DEFAULT cwd = a fresh temp dir, to
 * prove the bundle is self-contained and runs outside the repo).
 */
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** bun-apps/pi-agent-cli (this package). import.meta.dir = <pkg>/src/__tests__ */
export const PKG_DIR = dirname(dirname(import.meta.dir));
/** repo root (the dist/ tree lives here, not inside the package). */
export const REPO_ROOT = dirname(dirname(PKG_DIR));
/** Source-mode entry — what `bun src/cli.ts` / `./run.sh` (source) runs. */
export const SRC_CLI = join(PKG_DIR, "src", "cli.ts");
/** Bundle entry, produced by `bun scripts/build.ts` (next to a node_modules symlink). */
export const DIST_BUNDLE = join(REPO_ROOT, "dist", "pi-agent-cli", "cli.js");
/** Compiled standalone exe, produced by `bun scripts/build.ts --compile`. */
export const DIST_EXE = join(REPO_ROOT, "dist", "pi-agent-cli", "pi-agent-cli");

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

/** E2E fires only when PICLI_E2E is set; otherwise test files skip themselves. */
export const E2E_ENABLED = truthy(process.env.PICLI_E2E);

/**
 * The compile-exe e2e (builds the standalone binary too — slower) is gated
 * BEHIND PICLI_E2E_COMPILE so run-test.sh can offer a middle tier:
 * medium = build + bundle e2e (cheap), high = + compile exe.
 */
export const COMPILE_ENABLED = truthy(process.env.PICLI_E2E_COMPILE);

let bundlePromise: Promise<string> | null = null;

/**
 * Build the bundle once per test run (cached). Set PICLI_E2E_NO_BUILD=1 to
 * reuse an existing dist/pi-agent-cli/cli.js (faster re-runs during dev).
 * Returns the bundle path; throws if the build fails or the file is absent.
 */
export function ensureBundle(): Promise<string> {
	if (bundlePromise) return bundlePromise;
	bundlePromise = (async () => {
		if (existsSync(DIST_BUNDLE) && truthy(process.env.PICLI_E2E_NO_BUILD)) {
			return DIST_BUNDLE;
		}
		const build = Bun.spawn(["bun", "scripts/build.ts"], {
			cwd: PKG_DIR,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await build.exited;
		if (code !== 0) throw new Error(`bun scripts/build.ts exited ${code}`);
		if (!existsSync(DIST_BUNDLE)) {
			throw new Error(`build ok but ${DIST_BUNDLE} not found`);
		}
		return DIST_BUNDLE;
	})();
	return bundlePromise;
}

let exePromise: Promise<string> | null = null;

/**
 * Build the compiled exe once per run (cached). Slower than the bundle — only
 * call from compile-parity assertions (gated on PICLI_E2E_COMPILE).
 */
export function ensureExe(): Promise<string> {
	if (exePromise) return exePromise;
	exePromise = (async () => {
		if (existsSync(DIST_EXE) && truthy(process.env.PICLI_E2E_NO_BUILD)) {
			return DIST_EXE;
		}
		const build = Bun.spawn(["bun", "scripts/build.ts", "--compile"], {
			cwd: PKG_DIR,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await build.exited;
		if (code !== 0) throw new Error(`bun scripts/build.ts --compile exited ${code}`);
		if (!existsSync(DIST_EXE)) {
			throw new Error(`compile ok but ${DIST_EXE} not found`);
		}
		return DIST_EXE;
	})();
	return exePromise;
}

export interface SpawnResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

/**
 * Spawn `bun <bundle> <args…>` (or a compiled exe directly when `exe` is passed)
 * and collect output. Default cwd = a FRESH TEMP DIR (not the repo) so the e2e
 * proves the bundle is self-contained and deploys outside the source tree.
 * `timeoutMs` kills the process — the suite must never hang (e.g. if a
 * regression makes the CLI wait on a model call instead of honoring --help).
 */
export async function runBundle(
	args: string[],
	opts: {
		env?: Record<string, string | undefined>;
		cwd?: string;
		timeoutMs?: number;
		/** Run the compiled exe instead of `bun <bundle>`. */
		exe?: string;
	} = {},
): Promise<SpawnResult> {
	const target = opts.exe ?? (await ensureBundle());
	const invocation = opts.exe ? [target, ...args] : ["bun", target, ...args];
	const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "pi-cli-e2e-"));
	const proc = Bun.spawn(invocation, {
		cwd,
		env: { ...process.env, ...opts.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const timer = setTimeout(() => {
		try {
			process.stderr.write(
				`\n[e2e-harness] timeout (${timeoutMs}ms) killing ${invocation.join(" ")}\n`,
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
