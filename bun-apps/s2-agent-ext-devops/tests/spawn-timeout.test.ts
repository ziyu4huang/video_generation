/**
 * spawn-timeout.test.ts — the group-kill contract of `createLiveSpawn`.
 *
 * The 6-hour `bun test --isolate` orphan (see SpawnOptions.timeoutMs) is the
 * incident this guards against: on timeout the WHOLE process group must die,
 * including grandchildren the direct child spawned. The timeout path used to
 * wrap the child in `/usr/bin/perl -e 'setpgrp(0,0); exec …'` (macOS-only
 * assumption); it now uses node:child_process `detached: true` + `kill(-pid)`,
 * verified on macOS — this test re-verifies the contract on every platform it
 * runs on. Skipped on Windows (no POSIX process groups).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveSpawn, SPAWN_TIMEOUT_EXIT_CODE } from "../src/spawn.js";

const onWindows = process.platform === "win32";

describe.skipIf(onWindows)("createLiveSpawn timeout group-kill", () => {
	test("timeout kills the whole group — a grandchild does not survive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "spawn-timeout-test-"));
		const pidFile = join(dir, "grandchild.pid");
		try {
			const spawn = createLiveSpawn(dir);
			// Child = bash (the group leader); grandchild = a detached-from-bash
			// `sleep` that outlives bash itself. Same shape as
			// `bash -c "bun test --isolate"` rows in the CI matrix.
			const res = await spawn(
				"bash",
				[
					"-c",
					`sleep 60 & echo $! > "${pidFile}"; sleep 60`,
				],
				{ timeoutMs: 1500 },
			);
			expect(res.exitCode).toBe(SPAWN_TIMEOUT_EXIT_CODE);
			expect(res.timedOut).toBe(true);

			// Give the SIGKILL a beat to land, then the grandchild must be gone:
			// signal 0 probes existence without sending a signal.
			const grandchild = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
			expect(Number.isFinite(grandchild)).toBe(true);
			await Bun.sleep(500);
			let alive = true;
			try {
				process.kill(grandchild, 0);
			} catch {
				alive = false;
			}
			expect(alive).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);

	test("no timeout → normal exit code, no timedOut flag", async () => {
		const spawn = createLiveSpawn(tmpdir());
		const res = await spawn("bash", ["-c", "exit 7"]);
		expect(res.exitCode).toBe(7);
		expect(res.timedOut).toBeUndefined();
	});

	test("error path: missing command resolves (not rejects) with a non-zero exit", async () => {
		const spawn = createLiveSpawn(tmpdir());
		const res = await spawn("definitely-not-a-command-xyz", ["--version"], { timeoutMs: 5000 });
		expect(res.exitCode).not.toBe(0);
	});
});
