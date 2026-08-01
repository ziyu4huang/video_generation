/**
 * Smoke test for the extension entry: it registers exactly the three tools with
 * the right names + that await_pr_merge requires `prNumber` and sweep_branches
 * is fully optional (dry-run by default). (Tool behavior is covered by the
 * pr-logic/recipe/gh/branch-* tests; execute() isn't called here.)
 */
import { test, expect, describe } from "bun:test";
import entry from "../extensions/devops.js";

function fakePi() {
	const tools: Array<{ name: string; parameters: { required?: string[]; properties?: Record<string, unknown> } }> = [];
	return {
		tools,
		api: {
			registerTool: (t: { name: string; parameters: { required?: string[]; properties?: Record<string, unknown> } }) =>
				tools.push(t),
		},
	};
}

	describe("devops extension entry", () => {
		test("registers await_pr_merge + pr_status + sweep_branches tools", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			expect(pi.tools.map((t) => t.name).sort()).toEqual(["await_pr_merge", "pr_status", "sweep_branches"]);
		});

		test("await_pr_merge requires prNumber", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "await_pr_merge");
			expect(tool?.parameters.required).toContain("prNumber");
		});

		test("sweep_branches has no required params (dry-run by default)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "sweep_branches");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["execute", "confirm", "includeLocal", "includeRemote", "protected", "prune", "limit"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
		});
	});
