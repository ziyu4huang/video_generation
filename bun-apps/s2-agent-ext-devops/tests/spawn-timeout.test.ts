/**
 * spawn-timeout.test.ts — the timeout contract of the spawn seam:
 *  - `createLiveSpawn`'s group-kill behaviour (below), and
 *  - `withDefaultTimeout`, the pure wrap that injects the cap onto spawns
 *    (like the git/gh clients') that never pass options of their own.
 *
 * The 6-hour `bun test --isolate` orphan (see SpawnOptions.timeoutMs) is the
 * incident the group-kill half guards against: on timeout the WHOLE process
 * group must die, including grandchildren the direct child spawned. The
 * withDefaultTimeout half guards the 2026-08-24 incident — an unbounded
 * `git fetch` over a stalled SSH transport hung `sync-default-branch` for 11+
 * minutes. The timeout path used to wrap the child in
 * `/usr/bin/perl -e 'setpgrp(0,0); exec …'` (macOS-only assumption); it now
 * uses node:child_process `detached: true` + `kill(-pid)`, verified on macOS —
 * the live test re-verifies the contract on every platform it runs on.
 * Skipped on Windows (no POSIX process groups).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveSpawn, withDefaultTimeout, SPAWN_TIMEOUT_EXIT_CODE, type SpawnFn, type SpawnResult } from "../src/spawn.js";

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

describe("withDefaultTimeout — wrapping contract (pure, no live spawn)", () => {
	/** Recording fake: the wrapper must forward cmd/args verbatim and echo its options. */
	function echoSpawn(): { fn: SpawnFn; calls: (string[] | { cwd?: string; timeoutMs?: number } | undefined)[] } {
		const calls: (string[] | { cwd?: string; timeoutMs?: number } | undefined)[] = [];
		const fn: SpawnFn = async (cmd, args, options): Promise<SpawnResult> => {
			calls.push([cmd, ...args]);
			calls.push(options);
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		return { fn, calls };
	}

	test("no options ⇒ the default timeoutMs is injected, cmd/args forwarded verbatim", async () => {
		const rec = echoSpawn();
		await withDefaultTimeout(rec.fn, 5000)("git", ["fetch", "origin"]);
		expect(rec.calls[0]).toEqual(["git", "fetch", "origin"]);
		expect(rec.calls[1]).toEqual({ timeoutMs: 5000 });
	});

	test("options without timeoutMs ⇒ cwd preserved, default added", async () => {
		const rec = echoSpawn();
		await withDefaultTimeout(rec.fn, 5000)("git", ["status"], { cwd: "/repo" });
		expect(rec.calls[1]).toEqual({ cwd: "/repo", timeoutMs: 5000 });
	});

	test("an explicit per-call timeoutMs wins over the default", async () => {
		const rec = echoSpawn();
		await withDefaultTimeout(rec.fn, 5000)("bun", ["test"], { timeoutMs: 60_000 });
		expect(rec.calls[1]).toEqual({ timeoutMs: 60_000 });
	});

	test("the wrapped fn is still a plain (cmd, args) callable SpawnFn", async () => {
		const rec = echoSpawn();
		const wrapped: SpawnFn = withDefaultTimeout(rec.fn, 250);
		const r = await wrapped("git", ["rev-parse", "HEAD"]);
		expect(r.exitCode).toBe(0);
	});
});
