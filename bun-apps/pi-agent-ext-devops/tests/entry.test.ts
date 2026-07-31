/**
 * Smoke test for the extension entry: it registers exactly the two tools with
 * the right names + that `prNumber` is required. (The tools' behavior is
 * covered by pr-logic/recipe/gh tests; execute() isn't called here — no real
 * gh/git subprocess is triggered.)
 */
import { test, expect, describe } from "bun:test";
import entry from "../extensions/devops.js";

function fakePi() {
	const tools: Array<{ name: string; parameters: { required?: string[] } }> = [];
	return {
		tools,
		api: { registerTool: (t: { name: string; parameters: { required?: string[] } }) => tools.push(t) },
	};
}

describe("devops extension entry", () => {
	test("registers await_pr_merge + pr_status tools", () => {
		const pi = fakePi();
		// The default export is the setup function receiving the extension api.
		(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
		expect(pi.tools.map((t) => t.name).sort()).toEqual(["await_pr_merge", "pr_status"]);
	});

	test("await_pr_merge requires prNumber", () => {
		const pi = fakePi();
		(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
		const tool = pi.tools.find((t) => t.name === "await_pr_merge");
		expect(tool?.parameters.required).toContain("prNumber");
	});
});
