/**
 * Smoke test for the extension entry: it registers exactly the four tools with
 * the right names + that await_pr_merge requires `prNumber`, sweep_branches
 * is fully optional (dry-run by default), and local_ci has no required params
 * (defaults to origin/main..HEAD). (Tool behavior is covered by the
 * recipe/gh/branch-* and ci-recipe tests — execute() is not exercised here.)
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
		test("registers await_pr_merge + pr_status + sweep_branches + local_ci + sync_repo + devops_retrospect + prepare_branch + verify_merge tools", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			expect(pi.tools.map((t) => t.name).sort()).toEqual([
				"await_pr_merge",
				"devops_retrospect",
				"local_ci",
				"pr_status",
				"prepare_branch",
				"sweep_branches",
				"sync_repo",
				"verify_merge",
			]);
		});

		test("await_pr_merge requires prNumber + only the local-ci-gated params (poll-loop params dropped)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "await_pr_merge");
			expect(tool?.parameters.required).toEqual(["prNumber"]);
			const keys = Object.keys(tool?.parameters.properties ?? {}).sort();
			// only prNumber / strategy / deleteBranch remain …
			expect(keys).toEqual(["deleteBranch", "prNumber", "strategy"]);
			// … the poll-loop / rebase params are gone.
			for (const dropped of ["timeoutSec", "pollIntervalSec", "handleBehind", "branch"]) {
				expect(tool?.parameters.properties).not.toHaveProperty(dropped);
			}
			// strategy default is squash (matches the repo's gh-ship convention).
			expect((tool?.parameters.properties?.strategy as { description?: string }).description).toMatch(/squash/);
			// the description frames it as a local_ci gate, not the old poll/auto-merge loop.
			expect(tool?.description).toMatch(/local_ci/);
			expect(tool?.description).not.toMatch(/auto-merge|force-push|rebase\+force-push/i);
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

		test("local_ci has no required params (defaults to origin/main..HEAD)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "local_ci");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["baseRef", "packages", "all", "strict", "includeGates"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
		});

		test("sync_repo has optional mode + dryRun (no required params)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "sync_repo");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["mode", "dryRun"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
		});

		test("devops_retrospect has no required params (expectedScope + lookback optional)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "devops_retrospect");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["expectedScope", "lookback"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
			// advisory only — never aborts (it has no `aborted` field; worst case is warnings[]).
			expect(tool?.description).toMatch(/advisory/i);
			expect(tool?.description).not.toMatch(/abort/i);
		});

		test("prepare_branch has optional branch/base/create/rebase/forcePush/dryRun (no required params)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "prepare_branch");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["branch", "base", "create", "rebase", "forcePush", "dryRun"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
			expect(tool?.description).toMatch(/behind/i);
		});

		test("verify_merge requires pr + only expectedScope optional", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "verify_merge");
			expect(tool?.parameters.required).toEqual(["pr"]);
			expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual(["expectedScope", "pr"]);
			expect(tool?.description).toMatch(/CLEAN\/CONTAMINATED|scope/);
		});
	});
