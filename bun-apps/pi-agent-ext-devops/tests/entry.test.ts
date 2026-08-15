/**
 * Smoke test for the extension entry: it registers exactly the four tools with
 * the right names + that await_pr_merge requires `prNumber`, sweep_branches
 * is fully optional (dry-run by default), and local_ci has no required params
 * (defaults to origin/main..HEAD). (Tool behavior is covered by the
 * recipe/gh/branch-* and ci-recipe tests — execute() is not exercised here.)
 */
import { test, expect, describe } from "bun:test";
import entry from "../extensions/devops.js";

/** Tool shape the fake API records — mirrors the fields these tests assert
 * on (name/parameters + description + owner-declared gating). */
type FakeTool = {
	name: string;
	description?: string;
	parameters: { required?: string[]; properties?: Record<string, unknown> };
	gating?: { keywords?: string[]; requires?: { nouns?: string[]; verbs?: string[] } };
};

function fakePi() {
	const tools: FakeTool[] = [];
	return {
		tools,
		api: {
			registerTool: (t: FakeTool) => tools.push(t),
		},
	};
}

	describe("devops extension entry", () => {
		test("registers every devops tool, and nothing else", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			expect(pi.tools.map((t) => t.name).sort()).toEqual([
				"await_pr_merge",
				"devops_retrospect",
				"local_ci",
				"main_health",
				"pi_deploy",
				"pi_verify",
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

		test("pi_deploy has optional mode/outDir/noFreeze (no required params) + owner-declared gating", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "pi_deploy");
			expect(tool?.parameters.required ?? []).toEqual([]);
			expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual(["mode", "noFreeze", "outDir"]);
			// gating keywords preserved verbatim from the dissolved deploy extension.
			expect(tool?.gating?.keywords).toEqual(["build bundle", "bundle pi-agent", "pi-agent bundle", "run-test"]);
			expect((tool as any)?.gating?.requires?.nouns).toContain("pi-agent");
			expect((tool as any)?.gating?.requires?.verbs).toContain("deploy");
		});

		test("pi_verify has optional tier/bail (no required params) + mirrors pi_deploy gating", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "pi_verify");
			expect(tool?.parameters.required ?? []).toEqual([]);
			expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual(["bail", "tier"]);
			// mirrored gating — same keywords as pi_deploy.
			expect(tool?.gating?.keywords).toEqual(["build bundle", "bundle pi-agent", "pi-agent bundle", "run-test"]);
		});
	});
