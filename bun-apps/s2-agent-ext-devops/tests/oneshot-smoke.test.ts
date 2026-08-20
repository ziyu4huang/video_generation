/**
 * Tests for the oneshot-smoke adaptive boot gate — classifyRun / shouldRun
 * pure-policy unit tests, state round-trip against a tmpdir, and the
 * runOneshotSmoke runner driven entirely through a recording fake SpawnFn
 * (same style as tests/ci-recipe.test.ts). NO real spawns, NO network, NO
 * writes outside a tmpdir: every filesystem touch goes through mkFakeRepo().
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyRun,
	shouldRun,
	computeInputHash,
	readState,
	writeState,
	runOneshotSmoke,
	STATE_VERSION,
	PASS_TTL_MS,
	CANARY_TTL_MS,
	BOOT_HANG_DIAGNOSTIC,
	type OneshotSmokeState,
} from "../src/oneshot-smoke.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const HOUR = 3_600_000;

/**
 * A minimal fake monorepo: every file the gate hashes (content is irrelevant —
 * only bytes-vs-hash determinism matters), plus the devops package.json that
 * marks the repoRoot as "this monorepo" (the gate's applicability marker).
 */
function mkFakeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "oneshot-smoke-"));
	const files = [
		"bun-apps/s2-agent/src/cli.ts",
		"bun-apps/s2-agent/src/cli-argv.ts",
		"bun-apps/s2-agent/src/static-extensions.ts",
		"bun-apps/s2-agent-ext-hermes-memory/extensions/hermes-memory.ts",
		"bun-apps/s2-agent-ext-hermes-memory/src/index.ts",
		"bun-apps/s2-agent-ext-devops/src/oneshot-smoke.ts",
	];
	for (const rel of files) {
		mkdirSync(join(repo, rel, ".."), { recursive: true });
		writeFileSync(join(repo, rel), `// fake ${rel}\n`);
	}
	writeFileSync(join(repo, "bun-apps/s2-agent-ext-devops/package.json"), '{"name":"@repo/s2-agent-ext-devops"}');
	return repo;
}

function rmRepo(repo: string) {
	rmSync(repo, { recursive: true, force: true });
}

/** Recording spawn: canned results in call order; records cmd/args/options. */
function mkSpawn(results: SpawnResult[]) {
	const calls: Array<{ cmd: string; args: string[]; cwd?: string; timeoutMs?: number }> = [];
	let i = 0;
	const fn: SpawnFn = async (cmd, args, options) => {
		calls.push({ cmd, args, cwd: options?.cwd, timeoutMs: options?.timeoutMs });
		return results[Math.min(i++, results.length - 1)] ?? { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

/** Fake clock: starts at T0, advanced manually via tick(). */
const T0 = 1_700_000_000_000;
function mkClock() {
	let t = T0;
	return { now: () => t, tick: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

const okRun = (over: Partial<Parameters<typeof classifyRun>[0]> = {}): Parameters<typeof classifyRun>[0] => ({
	exitCode: 0,
	stdout: "ok\n",
	stderr: "",
	durationMs: 3000,
	...over,
});

describe("classifyRun — pure classification", () => {
	test("exit 0 + non-empty stdout → pass", () => {
		expect(classifyRun(okRun())).toEqual({ verdict: "pass", reason: "ok" });
	});

	test("fast nonzero + provider/auth output → skip (boot completed)", () => {
		const c = classifyRun(okRun({ exitCode: 1, stdout: "", stderr: "no API key for provider X", durationMs: 2000 }));
		expect(c.verdict).toBe("skip");
		expect(c.reason).toBe("provider-unavailable");
	});

	test("SLOW provider failure (>10s) → fail, not skip — slow is a hang signal", () => {
		const c = classifyRun(okRun({ exitCode: 1, stdout: "", stderr: "provider error", durationMs: 60_000 }));
		expect(c.verdict).toBe("fail");
		expect(c.reason).toBe("nonzero-exit");
	});

	test("non-provider crash → fail with captured tail", () => {
		const c = classifyRun(okRun({ exitCode: 2, stdout: "ReferenceError: boom", stderr: "" }));
		expect(c.verdict).toBe("fail");
		expect(c.reason).toBe("nonzero-exit");
		expect(c.detail).toContain("boom");
	});

	test("timeout → fail with the incident diagnostic (root cause + recipe + pointer)", () => {
		const c = classifyRun(okRun({ timedOut: true, exitCode: -1, stdout: "", stderr: "" }));
		expect(c.verdict).toBe("fail");
		expect(c.reason).toBe("timeout");
		expect(c.detail).toBe(BOOT_HANG_DIAGNOSTIC);
		expect(c.detail).toContain("syncMarkdownMemories");
		expect(c.detail).toContain("-ne -ns -e");
		expect(c.detail).toContain("docs/agents/learnings.md");
	});

	test("exit 0 with EMPTY stdout → fail loud (silence is not a boot)", () => {
		const c = classifyRun(okRun({ stdout: "  \n" }));
		expect(c.verdict).toBe("fail");
		expect(c.reason).toBe("empty-stdout");
	});
});

describe("shouldRun — adaptive policy", () => {
	const hash = "a".repeat(64);
	const base = (): OneshotSmokeState => ({
		version: STATE_VERSION,
		inputHash: hash,
		lastPassTs: T0 - 2 * HOUR,
		lastCanaryTs: T0 - 2 * HOUR,
		lastDurationMs: 4103,
	});

	test("no state → fast+canary", () => {
		expect(shouldRun(null, hash, T0).mode).toBe("fast+canary");
	});

	test("state version mismatch → fast+canary", () => {
		const s = { ...base(), version: 999 };
		expect(shouldRun(s, hash, T0).mode).toBe("fast+canary");
	});

	test("input hash change (hermes edit) → fast+canary — re-canary on any boot-input change", () => {
		const r = shouldRun(base(), "b".repeat(64), T0);
		expect(r.mode).toBe("fast+canary");
		expect(r.reason).toContain("inputs changed");
	});

	test("stale canary (>24h) outranks a fresh pass-cache — the wedge lived exactly there", () => {
		const s = { ...base(), lastCanaryTs: T0 - 25 * HOUR };
		const r = shouldRun(s, hash, T0);
		expect(r.mode).toBe("fast+canary");
		expect(r.reason).toContain("canary stale");
	});

	test("fresh matching state → skip-cached with age + last duration", () => {
		const r = shouldRun(base(), hash, T0);
		expect(r.mode).toBe("skip-cached");
		expect(r.reason).toMatch(/^cached-pass 2\.0h ago, 4103ms$/);
	});

	test("pass expired (6h) but canary fresh → fast-only", () => {
		const s = { ...base(), lastPassTs: T0 - 7 * HOUR };
		const r = shouldRun(s, hash, T0);
		expect(r.mode).toBe("fast-only");
	});

	test("force beats the pass-cache", () => {
		expect(shouldRun(base(), hash, T0, { force: true }).mode).toBe("fast+canary");
	});
});

describe("state file round-trip", () => {
	test("writeState creates the .cache dir; readState returns the same state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oneshot-state-"));
		const path = join(dir, "nested/.cache/oneshot-smoke.state.json");
		const s: OneshotSmokeState = {
			version: STATE_VERSION,
			inputHash: "c".repeat(64),
			lastPassTs: 1,
			lastCanaryTs: 2,
			lastDurationMs: 3,
		};
		await writeState(path, s);
		expect(existsSync(path)).toBe(true);
		expect(await readState(path)).toEqual(s);
		rmRepo(dir);
	});

	test("garbage / wrong-shape / missing state → null (never throws)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oneshot-state-"));
		const path = join(dir, "state.json");
		writeFileSync(path, "{not json");
		expect(await readState(path)).toBeNull();
		writeFileSync(path, JSON.stringify({ version: 1, inputHash: "x" }));
		expect(await readState(path)).toBeNull();
		expect(await readState(join(dir, "absent.json"))).toBeNull();
		rmRepo(dir);
	});
});

describe("runOneshotSmoke — runner via fake SpawnFn + fake repo", () => {
	const pass = (): SpawnResult => ({ stdout: "ok\n", stderr: "", exitCode: 0 });

	test("foreign repoRoot (no devops package) → null, gate not applicable", async () => {
		const foreign = mkdtempSync(join(tmpdir(), "foreign-"));
		const { fn, calls } = mkSpawn([pass()]);
		expect(await runOneshotSmoke({ repoRoot: foreign, spawn: fn })).toBeNull();
		expect(calls).toHaveLength(0);
		rmRepo(foreign);
	});

	test("DEVOPS_ONESHOT_SMOKE=skip → exit 0, no spawns", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const { fn, calls } = mkSpawn([pass()]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: { DEVOPS_ONESHOT_SMOKE: "skip" } });
		expect(r?.exitCode).toBe(0);
		expect(r?.mode).toBe("env-skip");
		expect(calls).toHaveLength(0);
		rmRepo(repo);
	});

	test("cached pass (hash match, <6h) → skip, ZERO spawns", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const hash = await computeInputHash(repo);
		await writeState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"), {
			version: STATE_VERSION,
			inputHash: hash,
			lastPassTs: T0 - 1 * HOUR,
			lastCanaryTs: T0 - 1 * HOUR,
			lastDurationMs: 4103,
		});
		const { fn, calls } = mkSpawn([pass()]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: {} });
		expect(r?.verdict).toBe("skip");
		expect(r?.mode).toBe("skip-cached");
		expect(r?.note).toContain("cached-pass 1.0h ago, 4103ms");
		expect(calls).toHaveLength(0);
		rmRepo(repo);
	});

	test("first run: fast probe uses `-ne -ns` (90s cap), canary keeps `-ns` only (180s cap)", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const { fn, calls } = mkSpawn([pass(), pass()]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: {} });
		expect(r?.verdict).toBe("pass");
		expect(r?.exitCode).toBe(0);
		expect(r?.mode).toBe("fast+canary");
		expect(r?.note).toContain("fast");
		expect(r?.note).toContain("canary");
		expect(calls).toHaveLength(2);
		// FAST: the known-good one-shot invocation, capped at 90s, cwd = repo.
		const fast = calls[0];
		expect(fast.args).toContain("-ne");
		expect(fast.args).toContain("-ns");
		expect(fast.args).toContain("-p");
		expect(fast.timeoutMs).toBe(90_000);
		expect(fast.cwd).toBe(repo);
		// CANARY: bare boot — NO `-ne` (static factories load for real), `-ns` stays.
		const canary = calls[1];
		expect(canary.args).not.toContain("-ne");
		expect(canary.args).toContain("-ns");
		expect(canary.timeoutMs).toBe(180_000);
		// State written with BOTH timestamps fresh.
		const state = await readState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"));
		expect(state?.version).toBe(STATE_VERSION);
		expect(state?.inputHash).toBe(await computeInputHash(repo));
		expect(state?.lastPassTs).toBeGreaterThan(T0 - 1);
		expect(state?.lastCanaryTs).toBeGreaterThan(T0 - 1);
		rmRepo(repo);
	});

	test("hash change triggers the canary even though a pass is 1h old", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		// State from BEFORE an input edit: wrong hash.
		await writeState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"), {
			version: STATE_VERSION,
			inputHash: "d".repeat(64),
			lastPassTs: T0 - 1 * HOUR,
			lastCanaryTs: T0 - 1 * HOUR,
			lastDurationMs: 100,
		});
		const { fn, calls } = mkSpawn([pass(), pass()]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: {} });
		expect(r?.mode).toBe("fast+canary");
		expect(calls).toHaveLength(2);
		rmRepo(repo);
	});

	test("pass-cache expired + canary fresh → fast-only: exactly ONE spawn, canary ts preserved", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const hash = await computeInputHash(repo);
		const canaryTs = T0 - 2 * HOUR;
		await writeState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"), {
			version: STATE_VERSION,
			inputHash: hash,
			lastPassTs: T0 - 7 * HOUR,
			lastCanaryTs: canaryTs,
			lastDurationMs: 100,
		});
		const { fn, calls } = mkSpawn([pass()]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: {} });
		expect(r?.mode).toBe("fast-only");
		expect(calls).toHaveLength(1);
		const state = await readState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"));
		expect(state?.lastCanaryTs).toBe(canaryTs);
		expect(state?.lastPassTs).toBeGreaterThan(T0 - 1);
		rmRepo(repo);
	});

	test("fast provider-fail (≤10s, auth output) → SKIP verdict, exit 0, pass-cache still refreshed", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const hash = await computeInputHash(repo);
		const canaryTs = T0 - 2 * HOUR;
		await writeState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"), {
			version: STATE_VERSION,
			inputHash: hash,
			lastPassTs: T0 - 7 * HOUR, // expired → fast-only mode
			lastCanaryTs: canaryTs,
			lastDurationMs: 100,
		});
		const { fn, calls } = mkSpawn([
			{ stdout: "", stderr: "Error: no api key for provider", exitCode: 1 },
		]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: {} });
		expect(r?.verdict).toBe("skip");
		expect(r?.exitCode).toBe(0);
		expect(r?.note).toContain("provider-unavailable");
		expect(calls).toHaveLength(1);
		const state = await readState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"));
		expect(state?.lastPassTs).toBeGreaterThan(T0 - 1); // boot completed → cache it
		rmRepo(repo);
	});

	test("canary provider-fail does NOT refresh lastCanaryTs (bare boot retried next run)", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const { fn } = mkSpawn([
			pass(), // fast
			{ stdout: "", stderr: "model auth failed", exitCode: 1 }, // canary
		]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: {} });
		expect(r?.exitCode).toBe(0);
		expect(r?.verdict).toBe("skip");
		const state = await readState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"));
		expect(state?.lastCanaryTs).toBe(0);
		rmRepo(repo);
	});

	test("timeout → FAIL with the incident diagnostic; state NOT written", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const { fn, calls } = mkSpawn([{ stdout: "", stderr: "", exitCode: -1, timedOut: true }]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, now: clock.now, env: {} });
		expect(r?.exitCode).toBe(1);
		expect(r?.verdict).toBe("fail");
		expect(r?.note).toContain("fast probe: timeout");
		expect(r?.detail).toBe(BOOT_HANG_DIAGNOSTIC);
		expect(calls).toHaveLength(1); // canary never runs after a fast FAIL
		expect(existsSync(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"))).toBe(false);
		rmRepo(repo);
	});

	test("missing hashed input (rename) → structured FAIL naming the file, never a throw", async () => {
		const repo = mkFakeRepo();
		rmSync(join(repo, "bun-apps/s2-agent-ext-hermes-memory/src/index.ts"));
		const { fn, calls } = mkSpawn([pass()]);
		const r = await runOneshotSmoke({ repoRoot: repo, spawn: fn, env: {} });
		expect(r?.exitCode).toBe(1);
		expect(r?.verdict).toBe("fail");
		expect(r?.detail).toContain("input missing");
		expect(r?.detail).toContain("hermes-memory/src/index.ts");
		expect(calls).toHaveLength(0);
		rmRepo(repo);
	});

	test("DEVOPS_ONESHOT_SMOKE=force forces fast+canary past a fresh cache", async () => {
		const repo = mkFakeRepo();
		const clock = mkClock();
		const hash = await computeInputHash(repo);
		await writeState(join(repo, "bun-apps/s2-agent-ext-devops/.cache/oneshot-smoke.state.json"), {
			version: STATE_VERSION,
			inputHash: hash,
			lastPassTs: T0 - 1 * HOUR,
			lastCanaryTs: T0 - 1 * HOUR,
			lastDurationMs: 100,
		});
		const { fn, calls } = mkSpawn([pass(), pass()]);
		const r = await runOneshotSmoke({
			repoRoot: repo,
			spawn: fn,
			now: clock.now,
			env: { DEVOPS_ONESHOT_SMOKE: "force" },
		});
		expect(r?.mode).toBe("fast+canary");
		expect(calls).toHaveLength(2);
		rmRepo(repo);
	});

	test("TTL constants hold the designed budget (6h pass / 24h canary)", () => {
		expect(PASS_TTL_MS).toBe(6 * HOUR);
		expect(CANARY_TTL_MS).toBe(24 * HOUR);
	});
});
