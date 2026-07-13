import { test, expect, describe } from "bun:test";
import { createCapturePi } from "../../perf-harness/src/index.ts";
import distillFactory from "../extensions/distill.ts";

describe("distill tool registration", () => {
	test("registers exactly 1 tool named 'distill'", () => {
		const { pi, tools } = createCapturePi();
		distillFactory(pi);
		const names = Object.keys(tools);
		expect(names).toEqual(["distill"]);
	});

	test("tool has no promptSnippet (stealth invariant)", () => {
		const { pi, tools } = createCapturePi();
		distillFactory(pi);
		expect(tools.distill.description).toBeTruthy();
		expect((tools.distill as any).promptSnippet).toBeUndefined();
	});

	test("description mentions all 3 actions", () => {
		const { pi, tools } = createCapturePi();
		distillFactory(pi);
		const desc = tools.distill.description as string;
		expect(desc).toContain("status");
		expect(desc).toContain("gate");
		expect(desc).toContain("converge");
	});
});
