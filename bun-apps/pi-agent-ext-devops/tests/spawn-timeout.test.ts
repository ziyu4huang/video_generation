/**
 * createLiveSpawn's timeout is the ONE place this repo's "untested seam" rule is
 * worth breaking: the whole defect it fixes lives in process semantics, not in
 * orchestration, so a fake spawn cannot show it.
 *
 * RCA 2026-08-15: a `bun test --isolate` child outlived its parent and spun at
 * 100% CPU for six hours; every later devops run in that worktree hung. Two
 * facts made that possible, and each gets a test here:
 *
 *   1. Nothing capped a command's wall clock.
 *   2. Killing the direct child is NOT enough. Matrix rows run as
 *      `bash -c "<cmd>"`, so the thing that must die is the process GROUP —
 *      Bun.spawn's own `timeout` option reaps only `bash` and leaves the real
 *      workload orphaned, which is precisely how the six-hour orphan was born.
 *
 * These spawn real processes deliberately. Each one is bounded by its own
 * timeout and asserted dead afterwards, so the suite cannot itself leak one.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { createLiveSpawn, SPAWN_TIMEOUT_EXIT_CODE } from "../src/spawn.js";

/** A marker unique per test process, so pgrep can never match a stray peer. */
const MARK = `devops-spawn-timeout-${process.pid}`;

/** How many live processes still carry the marker. */
function survivors(): number {
	const p = Bun.spawnSync(["pgrep", "-f", MARK]);
	return p.stdout
		.toString()
		.split("\n")
		.filter((l) => l.trim().length > 0).length;
}

afterEach(() => {
	Bun.spawnSync(["pkill", "-9", "-f", MARK]);
});

// P2 (host-binary probe) under the test-portability audit — these spawn real
// bash/perl/pgrep. Gated per .github/TEST-PORTABILITY.md. Note `local_ci`
// deliberately does NOT export CI=true, so this suite still runs there — which
// is the run that gates a merge in this repo.
describe.skipIf(Boolean(process.env.CI))("createLiveSpawn — timeoutMs", () => {
	test("no timeoutMs → unchanged: the command runs to completion", async () => {
		const spawn = createLiveSpawn(process.cwd());
		const r = await spawn("bash", ["-c", "echo hello"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("hello");
	});

	test("a command inside the cap returns its own exit code, not 124", async () => {
		const spawn = createLiveSpawn(process.cwd());
		const r = await spawn("bash", ["-c", "exit 3"], { timeoutMs: 30_000 });
		expect(r.exitCode).toBe(3);
	});

	test("an over-running command is killed and reported as 124", async () => {
		const spawn = createLiveSpawn(process.cwd());
		const t0 = Date.now();
		const r = await spawn("bash", ["-c", `sleep 60 # ${MARK}`], { timeoutMs: 700 });
		expect(r.exitCode).toBe(SPAWN_TIMEOUT_EXIT_CODE);
		expect(r.stderr).toMatch(/KILLED after 700ms/);
		// It must RESOLVE promptly, not merely report late — the original bug was
		// an await that never returned.
		expect(Date.now() - t0).toBeLessThan(15_000);
	});

	test("the whole process GROUP dies — a grandchild does not outlive the kill", async () => {
		const spawn = createLiveSpawn(process.cwd());
		// `bash -c "<grandchild> & wait"` reproduces a matrix row's shape: the
		// direct child is bash, the workload is one level deeper.
		const r = await spawn("bash", ["-c", `bash -c "sleep 60 # ${MARK}" & wait`], { timeoutMs: 700 });
		expect(r.exitCode).toBe(SPAWN_TIMEOUT_EXIT_CODE);
		await Bun.sleep(500); // let the SIGKILL land
		expect(survivors()).toBe(0);
	});
});
