import { describe, expect, test } from "bun:test";
import { movingSum } from "./calc.ts";

// Discovery guard: this fixture is FAILING-BY-DESIGN (2 of 3) so the benchmark
// agent must fix src/calc.ts. A raw `bun test` from the package root (local_ci
// invokes the runner directly, bypassing the package script's
// --path-ignore-patterns) discovers this file AT ITS REPO LOCATION — skip it
// there. The benchmark (and tasks.test.ts gates) run the TEMP COPY
// (copyFixtureToTemp), whose path lacks "bench/tasks" — active there.
const d = import.meta.dir.includes(`bench${"/"}tasks`) ? describe.skip : describe;

d("movingSum", () => {
	test("window larger than input: cumulative", () => {
		expect(movingSum([1, 2, 3], 5)).toEqual([1, 3, 6]);
	});
	test("sliding window drops outgoing elements", () => {
		expect(movingSum([1, 2, 3, 4], 2)).toEqual([1, 3, 5, 7]);
	});
	test("constant window", () => {
		expect(movingSum([5, 5, 5], 1)).toEqual([5, 5, 5]);
	});
});
