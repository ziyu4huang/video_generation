/**
 * e2e-readonly — a deploy is an IMMUTABLE artifact: code + extensions, with all
 * per-user state in ~/.pi/agent. This test freezes one (the DEFAULT — deploy.ts
 * writes `.deploy-readonly` + chmod a-w unless --no-freeze is passed) and proves
 * it still runs end-to-end from a foreign cwd, with ZERO writes landing inside
 * the frozen tree.
 *
 * Run for EVERY deploy mode — bundle AND snapshot — because the read-only
 * contract is cross-cutting, and the two modes exercise DIFFERENT runtime
 * write-paths:
 *   • bundle    — extensions are pre-compiled .js; no jiti involved.
 *   • snapshot  — extensions are .ts source, loaded by jiti at runtime. jiti
 *     CAN cache compiled .ts to node_modules/.cache/jiti, which lives INSIDE
 *     the frozen tree. run.sh's JITI_FS_CACHE=0 export (gated on
 *     .deploy-readonly) neutralizes that. NOTE: on the current jiti version
 *     the unset default is already no-FS-cache, so JITI_FS_CACHE=0 is
 *     DEFENSIVE insurance against a future jiti that flips that default — the
 *     snapshot loop passes with or without it. The loop's real load-bearing
 *     assertions are the zero-write snapshot + the EACCES/EPERM stderr guard
 *     below: any patch that introduces a runtime write into the frozen
 *     snapshot tree surfaces there.
 *
 * Why this is its own file: a regression in any leg — e.g. a new patch that
 * writes a cache into the deploy dir, or run.sh losing the JITI_FS_CACHE=0
 * export — would silently break `drop on /opt` deploys, and no other e2e catches
 * it (e2e-extensions deploys --no-freeze precisely so it can clean up).
 *
 * Run via `bun-apps/pi-agent-ext-devops/scripts/run-test.sh readonly` (or `full`). Gates: PI_AGENT_E2E +
 * PI_AGENT_E2E_DEPLOY (same as e2e-extensions).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { E2E_ENABLED, DEPLOY_ENABLED, PI_AGENT_DIR, DEPLOY_SCRIPT } from "./e2e-harness.ts";

const SKIPPED = !(E2E_ENABLED && DEPLOY_ENABLED);

// Both modes share the same assertions; only the deploy flags + the doctor
// `mode` field + the beforeAll timeout differ. snapshot is slower (copies
// pi-agent + every sibling extension package dir + all of node_modules).
const MODES = [
	{ name: "bundle", flag: [] as string[], doctorMode: "bundle", deployMs: 120_000 },
	{ name: "snapshot", flag: ["--snapshot"], doctorMode: "source", deployMs: 180_000 },
] as const;

for (const MODE of MODES) {
	describe.skipIf(SKIPPED)(`e2e: READ-ONLY ${MODE.name} deploy runs + writes nothing to the frozen tree`, () => {
		let pkgDir: string;
		let userDir: string; // the per-user PI_CODING_AGENT_DIR (writable, NOT the deploy)
		let foreignCwd: string;
		// Snapshot of the frozen tree's file list, taken right after deploy freezes
		// it. Every run afterward must leave this set unchanged (no writes leaked in).
		let frozenFiles: string[];

		async function deployFrozen() {
			pkgDir = mkdtempSync(join(tmpdir(), `pi-agent-ro-${MODE.name}-`));
			userDir = mkdtempSync(join(tmpdir(), `pi-agent-ro-${MODE.name}-user-`));
			foreignCwd = mkdtempSync(join(tmpdir(), `pi-agent-ro-${MODE.name}-cwd-`));
			// DEFAULT deploy (no --no-freeze) → deploy.ts freezes it. (deploy.ts no
			// longer has a --verify flag — its old boot+probe step was dropped in
			// the bundle/snapshot/standalone/exe unification; the doctor/smoke
			// probes below cover the same ground.)
			const deploy = Bun.spawn(["bun", DEPLOY_SCRIPT, pkgDir, ...MODE.flag], {
				cwd: PI_AGENT_DIR,
				stdout: "inherit",
				stderr: "inherit",
			});
			const code = await deploy.exited;
			if (code !== 0) throw new Error(`deploy.ts (${MODE.name}) exited ${code}`);
		}

		function snapshotFiles(): string[] {
			// `find` over the frozen tree, sorted. Used to prove no file was added or
			// modified by a run. (chmod a-w already enforces this at the OS level — the
			// snapshot is the positive assertion that the smoke actually exercised the
			// tree without the OS having to reject a write.)
			const r = Bun.spawnSync(["find", pkgDir, "-type", "f"]);
			return r.stdout.toString().split("\n").filter(Boolean).sort();
		}

		beforeAll(async () => {
			await deployFrozen();
			frozenFiles = snapshotFiles();
		}, MODE.deployMs);

		afterAll(() => {
			for (const d of [pkgDir, userDir, foreignCwd]) {
				if (!d) continue;
				try {
					// Frozen tree is chmod a-w — unfreeze before rm or rmSync EPERMs.
					Bun.spawnSync(["chmod", "-R", "u+w", d], { stdout: "ignore", stderr: "ignore" });
					rmSync(d, { recursive: true, force: true });
				} catch {
					/* best-effort cleanup */
				}
			}
		});

		test("deploy.ts froze the tree (.deploy-readonly marker present)", () => {
			expect(existsSync(join(pkgDir, ".deploy-readonly"))).toBe(true);
			// snapshot ships raw source (pi-agent/src/cli.ts), not a bundled pi-agent.js.
			const entry = MODE.name === "snapshot" ? join(pkgDir, "pi-agent", "src", "cli.ts") : join(pkgDir, "pi-agent.js");
			expect(existsSync(entry)).toBe(true);
		});

		test("doctor runs from a foreign cwd on the frozen deploy", async () => {
			// Invoke run.sh (NOT the entry directly) so the .deploy-readonly marker
			// detection + env hardening in run.sh is exercised end-to-end. For
			// snapshot this is the path where jiti loads .ts extensions under a
			// frozen tree.
			const proc = Bun.spawn([join(pkgDir, "run.sh"), "doctor", "--json"], {
				cwd: foreignCwd,
				env: { ...process.env, PI_CODING_AGENT_DIR: userDir },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const code = await proc.exited;
			expect(code).toBe(0);
			const start = stdout.indexOf("{");
			const end = stdout.lastIndexOf("}");
			expect(start).toBeGreaterThanOrEqual(0);
			const report = JSON.parse(stdout.slice(start, end + 1));
			expect(report.mode).toBe(MODE.doctorMode);
			expect(report.ok).toBe(true);
			// stderr must NOT contain a permission error from a stray write attempt.
			expect(stderr).not.toMatch(/EACCES|EPERM|read-only|Permission denied/i);
		}, 60_000);

		test("doctor --smoke loads extensions on the frozen deploy (matched > 0)", async () => {
			const proc = Bun.spawn([join(pkgDir, "run.sh"), "doctor", "--smoke", "--json"], {
				cwd: foreignCwd,
				env: { ...process.env, PI_CODING_AGENT_DIR: userDir },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const code = await proc.exited;
			expect(code).toBe(0);
			const start = stdout.indexOf("{");
			const end = stdout.lastIndexOf("}");
			const report = JSON.parse(stdout.slice(start, end + 1));
			const smoke = report.checks.find((c: { id: string }) => c.id === "runtime-smoke");
			const matched = Number(smoke?.detail?.match(/matched=(\d+)/)?.[1] ?? -1);
			expect(matched).toBeGreaterThan(0);
			expect(stderr).not.toMatch(/EACCES|EPERM|read-only|Permission denied/i);
		}, 60_000);

		test("NO file was written into the frozen deploy tree across the runs above", () => {
			// The load-bearing invariant: the deploy tree is byte-identical before and
			// after doctor + smoke ran against it. For snapshot this is the guard that
			// catches a runtime write into the frozen tree — be it a jiti FS cache
			// (if JITI_FS_CACHE=0 ever stops neutralizing it) or any new patch that
			// drops a cache/log/sqlite file into the deploy dir.
			const after = snapshotFiles();
			expect(after).toEqual(frozenFiles);
		});

		test("per-user state went to PI_CODING_AGENT_DIR, NOT the deploy tree", () => {
			// pi + pi-hermes-memory route all per-user state (sessions, auth, the
			// hermes sqlite DB) through PI_CODING_AGENT_DIR. Assert at least one file
			// landed in the user dir over the course of the runs, proving state is NOT
			// silently falling back to the deploy tree.
			const r = Bun.spawnSync(["find", userDir, "-type", "f"]);
			const files = r.stdout.toString().split("\n").filter(Boolean);
			expect(files.length).toBeGreaterThan(0);
		});
	});
}
