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
import { createLiveSpawn, withDefaultTimeout, SPAWN_TIMEOUT_EXIT_CODE, type SpawnFn } from "../src/spawn.js";

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

describe("withDefaultTimeout — every call capped unless it opts out", () => {
	// The sync-default-branch 11-minute hang (2026-08-24): git/gh spawns had NO
	// cap because timeoutMs was opt-in per call site. withDefaultTimeout is the
	// entry-point wrap that bounds the whole live surface.
	test("fills in the default cap when the caller passes none (records options through)", async () => {
		const seen: Array<{ cwd?: string; timeoutMs?: number }> = [];
		const inner: SpawnFn = async (_cmd, _args, options) => {
			seen.push({ cwd: options?.cwd, timeoutMs: options?.timeoutMs });
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const spawn = withDefaultTimeout(inner, 1234);
		await spawn("git", ["fetch"]);
		await spawn("git", ["fetch"], { cwd: "/tmp" });
		expect(seen[0]?.timeoutMs).toBe(1234);
		expect(seen[1]).toEqual({ cwd: "/tmp", timeoutMs: 1234 }); // cwd survives the wrap
	});

	test("an explicit per-call timeoutMs wins over the default", async () => {
		const seen: number[] = [];
		const inner: SpawnFn = async (_cmd, _args, options) => {
			seen.push(options?.timeoutMs ?? -1);
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const spawn = withDefaultTimeout(inner, 1234);
		await spawn("git", ["fetch"], { timeoutMs: 99 });
		expect(seen[0]).toBe(99);
	});

	test("live: a stalled command under the wrap is killed at the default cap", async () => {
		const spawn = withDefaultTimeout(createLiveSpawn(tmpdir()), 800);
		const res = await spawn("bash", ["-c", "sleep 30"]);
		expect(res.exitCode).toBe(SPAWN_TIMEOUT_EXIT_CODE);
		expect(res.timedOut).toBe(true);
	}, 10_000);
});
