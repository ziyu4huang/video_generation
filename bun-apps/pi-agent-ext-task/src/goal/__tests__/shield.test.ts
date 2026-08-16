import { describe, expect, test } from "bun:test";
import {
	contractItems,
	checkRegressionShield,
	parseAuditorVerdict,
	type RegressionShieldResult,
} from "../shield.js";

describe("contractItems", () => {
	test("strips bullets, numbers, and 'done when:' prefixes", () => {
		const items = contractItems("Done when: all green\n- file X exists\n2) no crashes\nout of scope: perf");
		expect(items).toEqual(["all green", "file X exists", "no crashes"]);
	});
	test("drops preamble lines ending in colon or 'the following'", () => {
		const items = contractItems("Done when ALL of the following are true:\nitem one\nitem two:");
		expect(items).toEqual(["item one"]);
	});
});

describe("parseAuditorVerdict", () => {
	test("approved from the last verdict-bearing block", () => {
		expect(parseAuditorVerdict("some analysis\n\n<approved/>")).toEqual({
			approved: true, disapproved: false, impossible: false, impossibleReason: undefined,
		});
	});
	test("disapproved", () => {
		expect(parseAuditorVerdict("<disapproved/>").disapproved).toBe(true);
	});
	test("impossible captures reason", () => {
		const r = parseAuditorVerdict("<impossible>needs a resource we lack</impossible>");
		expect(r.impossible).toBe(true);
		expect(r.impossibleReason).toBe("needs a resource we lack");
	});
	test("no verdict marker → all false", () => {
		const r = parseAuditorVerdict("just analysis, no tag");
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.impossible).toBe(false);
	});
});

describe("checkRegressionShield", () => {
	test("passes when evidence block addresses all items", () => {
		const contract = "file X exists\nno crashes";
		const report = "<evidence>\nItem: file X exists\nOutput: ls shows X\nItem: no crashes\nOutput: ran tests\n</evidence>";
		const r: RegressionShieldResult = checkRegressionShield(report, contract);
		expect(r.passed).toBe(true);
		expect(r.missingItems).toEqual([]);
		expect(r.hasEvidenceBlock).toBe(true);
	});
	test("fails when evidence block is missing", () => {
		const r = checkRegressionShield("approved with prose only, no evidence", "file X exists");
		expect(r.passed).toBe(false);
		expect(r.hasEvidenceBlock).toBe(false);
	});
	test("fails when an item is unaddressed", () => {
		const report = "<evidence>\nItem: file X exists\nOutput: ls shows X\n</evidence>";
		const r = checkRegressionShield(report, "file X exists\nno crashes");
		expect(r.passed).toBe(false);
		expect(r.missingItems).toEqual(["no crashes"]);
	});
});
