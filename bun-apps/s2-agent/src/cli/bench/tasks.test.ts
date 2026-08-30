import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_TASKS, checkAnalysis, checkEdit, checkNeedle, copyFixtureToTemp } from "./tasks.ts";

const tmpRoots: string[] = [];
afterAll(() => {
	for (const t of tmpRoots) rmSync(t, { recursive: true, force: true });
});

describe("BENCH_TASKS", () => {
	test("three tasks with prompts loaded from TASK.md", () => {
		expect(BENCH_TASKS.map((t) => t.id).sort()).toEqual(["analysis", "edit", "needle"]);
		for (const t of BENCH_TASKS) expect(t.prompt.length).toBeGreaterThan(20);
	});
});

describe("copyFixtureToTemp", () => {
	test("copies the fixture tree to a temp dir; repo file untouched by a write", async () => {
		const task = BENCH_TASKS.find((t) => t.id === "needle")!;
		const repoBefore = readFileSync(join(task.dir, "data.txt"), "utf8");
		const dir = await copyFixtureToTemp(task);
		tmpRoots.push(dir);
		expect(existsSync(join(dir, "data.txt"))).toBe(true);
		// A write into the temp copy must not leak back into the repo fixture.
		writeFileSync(join(dir, "data.txt"), "clobbered by the test");
		expect(readFileSync(join(task.dir, "data.txt"), "utf8")).toBe(repoBefore);
	});
});

describe("quality gates", () => {
	test("needle: exact token passes, near-miss fails", async () => {
		expect((await checkNeedle("NEEDLE-7Q4X9M2B", "/ignore")).pass).toBe(true);
		const near = await checkNeedle("The token is NEEDLE-7Q4X9M2B.", "/ignore");
		expect(near.pass).toBe(true); // substring match allowed: token must appear verbatim
		expect((await checkNeedle("NEEDLE-XXXX", "/ignore")).pass).toBe(false);
	});

	test("edit: pristine fixture fails, fixed copy passes, test-file tamper fails", async () => {
		const task = BENCH_TASKS.find((t) => t.id === "edit")!;
		const pristine = await copyFixtureToTemp(task);
		tmpRoots.push(pristine);
		const pristineResult = await checkEdit("", pristine);
		expect(pristineResult.pass).toBe(false);

		const fixed = await copyFixtureToTemp(task);
		tmpRoots.push(fixed);
		writeFileSync(join(fixed, "src/calc.ts"), `export function movingSum(values: number[], window: number): number[] {
	const out: number[] = []; let acc = 0;
	for (let i = 0; i < values.length; i++) { acc += values[i]; if (i >= window) acc -= values[i - window]; out.push(acc); }
	return out;
}
`);
		expect((await checkEdit("", fixed)).pass).toBe(true);

		const tampered = await copyFixtureToTemp(task);
		tmpRoots.push(tampered);
		writeFileSync(join(tampered, "src/calc.test.ts"), `import { test, expect } from "bun:test"; test("always", () => { expect(1).toBe(1); });
`);
		const tamperedResult = await checkEdit("", tampered);
		expect(tamperedResult.pass).toBe(false);
		expect(tamperedResult.detail).toContain("test file");
	});

	test("analysis: all three answers present passes; missing one fails", async () => {
		const ok = await checkAnalysis("1. ord-101\n2. SKU-BQ\n3. Cleo Frost", "/ignore");
		expect(ok.pass).toBe(true);
		const missing = await checkAnalysis("1. ord-101\n2. SKU-BQ\n3. Wrong Name", "/ignore");
		expect(missing.pass).toBe(false);
		expect(missing.detail).toContain("Cleo Frost");
	});
});
