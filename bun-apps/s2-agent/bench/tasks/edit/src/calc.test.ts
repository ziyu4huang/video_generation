import { describe, expect, test } from "bun:test";
import { movingSum } from "./calc.ts";

describe("movingSum", () => {
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
