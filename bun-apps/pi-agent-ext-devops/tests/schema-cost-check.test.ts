/**
 * Tests for runSchemaCostCheck — the schema-cost regression gate extracted from
 * the former `scripts/check-schema-cost.ts`. The comparison/output/exit semantics
 * must be IDENTICAL to the old script; these tests pin them.
 *
 * No real pi-agent CLI is ever spawned: the `--live` path skips collection
 * entirely, and the collection paths inject a recording `SpawnFn`. Baseline /
 * live JSON are real temp files (the fn reads them via readFileSync, like the
 * script did).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchemaCostCheck } from "../src/schema-cost-check.js";
import type { SpawnFn } from "../src/spawn.js";

const TMP = join(tmpdir(), `schema-cost-check-test-${process.pid}`);
beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Write a JSON temp file and return its absolute path. */
function writeJson(name: string, obj: unknown): string {
	const path = join(TMP, name);
	writeFileSync(path, JSON.stringify(obj));
	return path;
}

/**
 * Safety-net spawn: returns exit 1 if ever called. The `--live` tests pass this
 * so an accidental collection call (a regression) would flip their exitCode to 1
 * and fail loudly instead of silently hitting the real CLI.
 */
const neverSpawn: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 1 });

describe("runSchemaCostCheck", () => {
	test("within threshold → exitCode 0", async () => {
		const baseline = writeJson("baseline-ok.json", { totalTokens: 1000, tools: 10 });
		const live = writeJson("live-ok.json", { totalTokens: 1010, tools: 10 }); // +1%
		const r = await runSchemaCostCheck({ repoRoot: TMP, baseline, live, threshold: 5, spawn: neverSpawn });
		expect(r.exitCode).toBe(0);
	});

	test("over threshold → exitCode 0 (info-only WARNING, NEVER blocks)", async () => {
		const baseline = writeJson("baseline-over.json", { totalTokens: 1000, tools: 10 });
		const live = writeJson("live-over.json", { totalTokens: 1200, tools: 10 }); // +20%
		const r = await runSchemaCostCheck({ repoRoot: TMP, baseline, live, threshold: 5, spawn: neverSpawn });
		expect(r.exitCode).toBe(0);
	});

	test("decreased → exitCode 0", async () => {
		const baseline = writeJson("baseline-down.json", { totalTokens: 1000, tools: 10 });
		const live = writeJson("live-down.json", { totalTokens: 900, tools: 10 }); // -10%
		const r = await runSchemaCostCheck({ repoRoot: TMP, baseline, live, threshold: 5, spawn: neverSpawn });
		expect(r.exitCode).toBe(0);
	});

	test("hard collection failure (CLI exit 1) → exitCode 1, does NOT throw, needs no baseline", async () => {
		const failSpawn: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 1 });
		const r = await runSchemaCostCheck({ repoRoot: TMP, threshold: 5, spawn: failSpawn });
		expect(r.exitCode).toBe(1);
	});

	test("unparseable CLI stdout → exitCode 1, does NOT throw", async () => {
		const garbageSpawn: SpawnFn = async () => ({ stdout: "not json {{{", stderr: "", exitCode: 0 });
		const r = await runSchemaCostCheck({ repoRoot: TMP, threshold: 5, spawn: garbageSpawn });
		expect(r.exitCode).toBe(1);
	});

	test("--live skips collection entirely (spawn never invoked)", async () => {
		const baseline = writeJson("baseline-noscroll.json", { totalTokens: 1000, tools: 10 });
		const live = writeJson("live-noscroll.json", { totalTokens: 1000, tools: 10 });
		let called = false;
		const trackingSpawn: SpawnFn = async () => {
			called = true;
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const r = await runSchemaCostCheck({ repoRoot: TMP, baseline, live, threshold: 5, spawn: trackingSpawn });
		expect(r.exitCode).toBe(0);
		expect(called).toBe(false);
	});
});
