/**
 * e2e-extensions — pi-agent extension loading across source AND deployed-package
 * layouts, from multiple cwds. (Formerly scripts/verify.ts — folded into bun:test
 * so `bun test` is the single entry point, and so it gates behind PI_AGENT_E2E
 * like the other bundle e2e. Run via `./bun-apps/pi-agent/run-test.sh` or
 * `PI_AGENT_E2E=1 bun test`, or directly `bun run verify`.)
 *
 * WHY THIS EXISTS
 *   run-dir/resolve.ts has three modes (source / repo-bundle / deploy-package)
 *   and cwd-coupled bugs that are INVISIBLE when you only test from inside the
 *   artifact or trust the model's `-p` reply. This codifies the method that
 *   catches them: build + deploy a fresh package, run a probe extension
 *   (pi.getAllTools()) across SOURCE (repo + /tmp) and DEPLOY (foreign cwd +
 *   repo), assert ZERO conflict/cannot-find/failed-to-load and matched>0, and
 *   kill the process the instant the probe fires (no model call — fast/offline).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	E2E_ENABLED,
	DEPLOY_ENABLED,
	PI_AGENT_DIR,
	REPO_ROOT,
	SRC_CLI,
	ensureBundle,
} from "./e2e-harness.ts";

// probe: counts tools whose source path includes $PI_VERIFY_MARKER, then writes
// a [PROBE] line the runner reads. We kill the process the instant it fires —
// no model call, fully offline.
const PROBE_TS = `
export default (pi) => {
  pi.on("session_start", () => {
    const tools = pi.getAllTools();
    const marker = process.env.PI_VERIFY_MARKER ?? "";
    let matched = 0;
    for (const t of tools) {
      if (marker && String(t.sourceInfo?.path ?? "").includes(marker)) matched++;
    }
    process.stderr.write("[PROBE] total=" + tools.length + " matched=" + matched + "\\n");
  });
};
`;

interface Scenario {
	name: string;
	cmd: string[];
	cwd: string;
	marker: string;
}
interface Result {
	total: number | null;
	matched: number | null;
	errors: string[];
}

async function runScenario(s: Scenario): Promise<Result> {
	const errors: string[] = [];
	let total: number | null = null;
	let matched: number | null = null;
	const proc = Bun.spawn(s.cmd, {
		cwd: s.cwd,
		env: { ...process.env, PI_VERIFY_MARKER: s.marker },
		stderr: "pipe",
		stdout: "pipe",
	});
	const reader = proc.stderr.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const ERR = /conflict|cannot find|failed to load/i;
	let killed = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const m = line.match(/\[PROBE\] total=(\d+) matched=(\d+)/);
				if (m) {
					total = +m[1];
					matched = +m[2];
					try {
						proc.kill();
					} catch {
						/* */
					}
					killed = true;
				} else if (ERR.test(line)) {
					errors.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
				}
			}
			if (killed) break;
		}
	} finally {
		try {
			proc.kill();
		} catch {
			/* */
		}
	}
	return { total, matched, errors };
}

// Shared assertions for one scenario's Result.
function assertCleanLoad(r: Result) {
	// ZERO conflict/cannot-find/failed-to-load.
	expect(r.errors).toEqual([]);
	// The probe extension itself was loaded (matched > 0).
	expect(r.matched).not.toBeNull();
	expect(r.matched as number).toBeGreaterThan(0);
	expect(r.total).not.toBeNull();
	// Built-in tool floor (7) plus the matched extension's tools.
	expect(r.total as number).toBeGreaterThanOrEqual(7 + (r.matched as number));
}

// Deploy once into a temp dir via `deploy.ts <flags>`, write the probe, return
// { pkgDir, pkgPiAgent, probePath }. Cleans up on failure.
async function deployPkg(extraFlags: string[]): Promise<{
	pkgDir: string;
	pkgPiAgent: string;
	probePath: string;
}> {
	await ensureBundle(); // bundle is a prerequisite of deploy.ts
	const pkgDir = mkdtempSync(join(tmpdir(), "pi-agent-verify-"));
	const deploy = Bun.spawn(
		["bun", "scripts/deploy.ts", pkgDir, "--no-build", ...extraFlags],
		{ cwd: PI_AGENT_DIR, stdout: "inherit", stderr: "inherit" },
	);
	const code = await deploy.exited;
	if (code !== 0) {
		rmSync(pkgDir, { recursive: true, force: true });
		throw new Error(`deploy.ts ${extraFlags.join(" ")} exited ${code}`);
	}
	const pkgPiAgent = join(pkgDir, "pi-agent.js");
	if (!existsSync(pkgPiAgent)) {
		throw new Error(`deployed package missing pi-agent.js at ${pkgPiAgent}`);
	}
	const probePath = join(pkgDir, ".verify-probe.ts");
	writeFileSync(probePath, PROBE_TS);
	return { pkgDir, pkgPiAgent, probePath };
}

// SOURCE mode is identical for both deploy modes — cover it once here.
describe.skipIf(!E2E_ENABLED || !DEPLOY_ENABLED)("e2e: SOURCE extension loading (reference)", () => {
	let probePath = "";
	beforeAll(() => {
		probePath = join(tmpdir(), `pi-source-probe-${process.pid}.ts`);
		writeFileSync(probePath, PROBE_TS);
	});
	afterAll(() => {
		if (existsSync(probePath)) rmSync(probePath, { force: true });
	});
	for (const cwd of [REPO_ROOT, tmpdir()]) {
		test(`SOURCE from ${cwd === REPO_ROOT ? "repo" : "/tmp"}`, async () => {
			const r = await runScenario({
				name: "source",
				cmd: ["bun", SRC_CLI, "-e", probePath, "-p", "hi"],
				cwd,
				marker: join(REPO_ROOT, "bun-apps"),
			});
			assertCleanLoad(r);
		});
	}
});

// DEPLOY-PACKAGE mode = `deploy.ts --release` (copies every ext source folder).
describe.skipIf(!E2E_ENABLED || !DEPLOY_ENABLED)("e2e: DEPLOY-PACKAGE (--release) extension loading", () => {
	let pkg = { pkgDir: "", pkgPiAgent: "", probePath: "" };
	beforeAll(async () => {
		pkg = await deployPkg(["--release"]);
	}, 120_000); // deploys + bun install: needs headroom past the 5s default
	afterAll(() => {
		if (pkg.pkgDir) rmSync(pkg.pkgDir, { recursive: true, force: true });
	});
	for (const cwd of [tmpdir(), REPO_ROOT]) {
		test(`DEPLOY-PACKAGE from ${cwd === REPO_ROOT ? "repo" : "/tmp"}`, async () => {
			const r = await runScenario({
				name: "deploy-pkg",
				cmd: ["bun", pkg.pkgPiAgent, "-e", pkg.probePath, "-p", "hi"],
				cwd,
				marker: pkg.pkgDir,
			});
			assertCleanLoad(r);
		});
	}
});

// DEPLOY-BUNDLE mode = `deploy.ts` default (pre-bundled ext-bundles/*.thin.js).
// node_modules is NOT copied by default (redundant — everything resolves via
// baked repo .bun-store abs paths; the deploy is same-machine-repo-present).
describe.skipIf(!E2E_ENABLED || !DEPLOY_ENABLED)("e2e: DEPLOY-BUNDLE (default) extension loading", () => {
	let pkg = { pkgDir: "", pkgPiAgent: "", probePath: "" };
	beforeAll(async () => {
		pkg = await deployPkg([]);
	}, 120_000); // builds 5 ext bundles + deploys: needs headroom past the 5s default
	afterAll(() => {
		if (pkg.pkgDir) rmSync(pkg.pkgDir, { recursive: true, force: true });
	});
	for (const cwd of [tmpdir(), REPO_ROOT]) {
		test(`DEPLOY-BUNDLE from ${cwd === REPO_ROOT ? "repo" : "/tmp"}`, async () => {
			const r = await runScenario({
				name: "deploy-bundle",
				cmd: ["bun", pkg.pkgPiAgent, "-e", pkg.probePath, "-p", "hi"],
				cwd,
				// ext-bundles resolve under pkgDir; npm exts resolve to the repo
				// .bun store (abs paths), so marker=pkgDir counts the bundled exts.
				marker: join(pkg.pkgDir, "ext-bundles"),
			});
			assertCleanLoad(r);
		});
	}
});
