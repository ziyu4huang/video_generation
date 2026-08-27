/**
 * Smoke test for the extension entry: it registers exactly the four tools with
 * the right names + that merge_pr_after_local_ci requires `prNumber`, sweep_merged_branches
 * is fully optional (dry-run by default), and run_local_ci has no required params
 * (defaults to origin/main..HEAD). (Tool behavior is covered by the
 * recipe/gh/branch-* and ci-recipe tests — execute() is not exercised here.)
 */
import { test, expect, describe } from "bun:test";
import entry from "../extensions/devops.js";

/** Tool shape the fake API records — mirrors the fields these tests assert
 * on (name/parameters + description + owner-declared gating). The `gating`
 * field is the 01c reference form ({ core?, gate? }) — inline keywords/requires
 * were deleted. */
type FakeTool = {
	name: string;
	description?: string;
	parameters: { required?: string[]; properties?: Record<string, unknown> };
	gating?: { core?: boolean; gate?: string };
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
		test("BUN_PI_DEVOPS=0 registers NOTHING (the disable knob every shipped extension exposes)", () => {
			// The isolation-contract DISABLE probe sets this env per base-set
			// entry; the knob lives on the entry's first line.
			const saved = process.env.BUN_PI_DEVOPS;
			process.env.BUN_PI_DEVOPS = "0";
			try {
				const pi = fakePi();
				(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
				expect(pi.tools).toHaveLength(0);
			} finally {
				if (saved === undefined) delete process.env.BUN_PI_DEVOPS;
				else process.env.BUN_PI_DEVOPS = saved;
			}
		});

		test("registers every devops tool, and nothing else", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			expect(pi.tools.map((t) => t.name).sort()).toEqual([
				"check_main_health",
				"deploy_pi_agent_sh",
				"merge_pr_after_local_ci",
				"prepare_feature_branch",
				"run_devops_retrospect",
				"run_local_ci",
				"show_pr_status",
				"sweep_merged_branches",
				"sync_default_branch",
				"verify_merge_landed",
				"verify_pi_agent_deploy",
			]);
		});

		test("merge_pr_after_local_ci requires prNumber + only the local-ci-gated params (poll-loop params dropped)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "merge_pr_after_local_ci");
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
			// the description frames it as a run_local_ci gate, not the old poll/auto-merge loop.
			expect(tool?.description).toMatch(/run_local_ci/);
			expect(tool?.description).not.toMatch(/auto-merge|force-push|rebase\+force-push/i);
		});

		test("sweep_merged_branches has no required params (dry-run by default)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "sweep_merged_branches");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["execute", "confirm", "includeLocal", "includeRemote", "protected", "prune", "limit"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
		});

		test("run_local_ci has no required params (defaults to origin/main..HEAD)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "run_local_ci");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["baseRef", "packages", "all", "strict", "includeGates"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
		});

		test("sync_default_branch has optional mode + dryRun (no required params)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "sync_default_branch");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["mode", "dryRun"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
		});

		test("run_devops_retrospect has no required params (expectedScope + lookback optional)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "run_devops_retrospect");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["expectedScope", "lookback"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
			// advisory only — never aborts (it has no `aborted` field; worst case is warnings[]).
			expect(tool?.description).toMatch(/advisory/i);
			expect(tool?.description).not.toMatch(/abort/i);
		});

		test("prepare_feature_branch has optional branch/base/create/rebase/forcePush/dryRun (no required params)", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "prepare_feature_branch");
			expect(tool?.parameters.required ?? []).toEqual([]);
			for (const opt of ["branch", "base", "create", "rebase", "forcePush", "dryRun"]) {
				expect(tool?.parameters.properties).toHaveProperty(opt);
			}
			expect(tool?.description).toMatch(/behind/i);
		});

		test("verify_merge_landed requires pr; expectedScope + allowFetch are optional", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "verify_merge_landed");
			expect(tool?.parameters.required).toEqual(["pr"]);
			// allowFetch is new (issue #1439): without it a call made right after a
			// merge cannot read the sha, and the verdict is UNVERIFIED.
			expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual([
				"allowFetch",
				"expectedScope",
				"pr",
			]);
			expect(tool?.description).toMatch(/CLEAN\/CONTAMINATED|scope/);
		});

		test("deploy_pi_agent_sh has optional force/noFreeze/noCurrent (no required params) + owner-declared gating", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "deploy_pi_agent_sh");
			expect(tool?.parameters.required ?? []).toEqual([]);
			// no `ext` — version dirs are immutable (Phase 3 deleted the in-place rebuild)
			expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual([
				"force",
				"noCurrent",
				"noFreeze",
				"target", // crossos t05 (D6): cross-OS target name, optional
			]);
			// reference form (ticket 01): shared "deploy_pi_agent_sh" family (deploy_pi_agent_sh + verify_pi_agent_deploy).
			expect(tool?.gating?.gate).toBe("deploy_pi_agent_sh");
			expect("keywords" in (tool?.gating ?? {})).toBe(false); // no inline keywords on the tool (01c)
		});

		test("verify_pi_agent_deploy has optional tier/bail (no required params) + mirrors deploy_pi_agent_sh gating", () => {
			const pi = fakePi();
			(entry as (api: { registerTool: (t: unknown) => void }) => void)(pi.api as never);
			const tool = pi.tools.find((t) => t.name === "verify_pi_agent_deploy");
			expect(tool?.parameters.required ?? []).toEqual([]);
			expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual(["bail", "tier"]);
			// same "deploy_pi_agent_sh" family as deploy_pi_agent_sh — co-fire as one group (ticket 01).
			expect(tool?.gating?.gate).toBe("deploy_pi_agent_sh");
			expect("keywords" in (tool?.gating ?? {})).toBe(false); // no inline keywords on the tool (01c)
		});
	});
