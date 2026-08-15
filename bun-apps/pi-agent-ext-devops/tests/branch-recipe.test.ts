/**
 * Tests for the sweep_branches orchestration: buildSweepPlan (read + classify),
 * executeSweep (re-guard + delete, incl. the worktree-race invariant), runSweep
 * (dry-run / execute / prune), and resolveProtected. All via a fake BranchClient
 * — no real git/gh. Conservative guarantees under test:
 *  - delete only on positive gh merge evidence (high confidence);
 *  - review (medium/low) never auto-deleted;
 *  - worktree-locked branches never deleted, even if "planned" (re-guarded at execute).
 */
import { test, expect, describe } from "bun:test";
import {
	buildSweepPlan,
	executeSweep,
	runSweep,
	resolveProtected,
	type BranchClient,
} from "../src/branch-recipe.js";

/** A recording fake BranchClient. `mutate` simulates state races between plan & execute. */
function fakeClient(s: {
	locals: { name: string; goneRemote: boolean }[];
	remotes: string[];
	worktrees?: string[];
	current?: string;
	merged?: Record<string, number>;
	open?: string[];
	contained?: string[];
	defaultBranch?: string;
	/** Branches whose local/remote delete should THROW (simulating a non-zero git exit). */
	failLocal?: string[];
	failRemote?: string[];
}) {
	const calls: string[] = [];
	let worktrees = s.worktrees ?? [];
	let current = s.current ?? "";
	let open = s.open ?? [];
	const client: BranchClient = {
		branchVv: async () => s.locals,
		remoteBranches: async () => s.remotes,
		worktrees: async () => {
			calls.push("worktrees");
			return worktrees;
		},
		currentBranch: async () => current,
		mergedPrRefs: async () => new Map(Object.entries(s.merged ?? {})),
		openPrRefs: async () => {
			calls.push("openPrRefs");
			return new Set(open);
		},
		containedBranches: async () => new Set(s.contained ?? []),
		defaultBranch: async () => s.defaultBranch,
		fetchPrune: async () => {
			calls.push("fetchPrune");
		},
		deleteLocalBranch: async (n) => {
			calls.push(`delLocal:${n}`);
			if (s.failLocal?.includes(n)) throw new Error(`git branch -D ${n} failed (exit 1): branch not found`);
		},
		deleteRemoteBranch: async (n) => {
			calls.push(`delRemote:${n}`);
			if (s.failRemote?.includes(n)) throw new Error(`git push origin --delete ${n} failed (exit 1): remote rejected`);
		},
	};
	return {
		client,
		calls,
		mutate: {
			setWorktrees: (v: string[]) => {
				worktrees = v;
			},
			setCurrent: (v: string) => {
				current = v;
			},
			setOpen: (v: string[]) => {
				open = v;
			},
		},
	};
}

/** The canonical matrix: merged / gone / active-open / protected, local + remote. */
function matrixClient() {
	return fakeClient({
		locals: [
			{ name: "main", goneRemote: false },
			{ name: "feat/merged", goneRemote: false },
			{ name: "feat/gone", goneRemote: true },
			{ name: "feat/active", goneRemote: false },
		],
		remotes: ["feat/merged", "rmt/merged"],
		current: "main",
		defaultBranch: "main",
		merged: { "feat/merged": 10, "rmt/merged": 11 },
		open: ["feat/active"],
	});
}
const PROT = () => resolveProtected({ default: "main" });

describe("resolveProtected", () => {
	test("always includes main + master + default + custom", () => {
		expect(resolveProtected({ default: "main" })).toEqual(new Set(["main", "master"]));
		expect(resolveProtected({ default: "trunk", protected: ["release/*"] })).toEqual(
			new Set(["main", "master", "trunk", "release/*"]),
		);
	});
});

describe("buildSweepPlan", () => {
	test("categorizes the matrix: merged→delete, gone→review, open→keep, protected→keep", async () => {
		const { client } = matrixClient();
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.deleteLocal.map((p) => p.name)).toEqual(["feat/merged"]);
		expect(plan.deleteRemote.map((p) => p.name)).toEqual(["feat/merged", "rmt/merged"]);
		expect(plan.review.map((p) => p.name)).toEqual(["feat/gone"]);
		expect(plan.keep.map((k) => k.name)).toEqual(["main", "feat/active"]);
		expect(plan.mergedRefNames.sort()).toEqual(["feat/merged", "rmt/merged"]);
		expect(plan.openRefNames).toEqual(["feat/active"]);
	});

	test("a merged branch checked out in a worktree → keep (not delete)", async () => {
		const { client } = fakeClient({
			locals: [{ name: "feat/wt", goneRemote: false }],
			remotes: [],
			current: "main",
			defaultBranch: "main",
			merged: { "feat/wt": 7 },
			worktrees: ["feat/wt"],
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.deleteLocal).toEqual([]);
		expect(plan.keep.find((k) => k.name === "feat/wt")?.reason).toBe("worktree-locked");
	});

	test("the REMOTE of a worktree-checked-out branch is guarded too, not just the local", async () => {
		// Reverses the earlier "remote ≠ local worktree, delete it anyway" rule.
		// That rule reasons about git mechanics — deleting origin/x does not touch
		// a local checkout of x — but the worktree guard is about the PERSON in
		// that worktree, whose push target and upstream tracking vanish under them
		// mid-session. A live sweep hit exactly this: origin/refactor/c1-residual-
		// planning-parse was in the auto-delete set while a sibling worktree was
		// checked out on it.
		const { client } = fakeClient({
			locals: [{ name: "feat/wt", goneRemote: false }],
			remotes: ["feat/wt"],
			current: "main",
			defaultBranch: "main",
			merged: { "feat/wt": 7 },
			worktrees: ["feat/wt"],
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.deleteLocal).toEqual([]);
		expect(plan.deleteRemote).toEqual([]);
		expect(plan.keep.filter((k) => k.name === "feat/wt").map((k) => k.reason)).toEqual([
			"worktree-locked",
			"worktree-locked",
		]);
	});
});

describe("executeSweep", () => {
	test("deletes high-confidence local + remote; leaves review untouched", async () => {
		const { client, calls } = matrixClient();
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		const out = await executeSweep(plan, client, { protectedSet: PROT() });
		expect(out.deletedLocal).toEqual(["feat/merged"]);
		expect(out.deletedRemote).toEqual(["feat/merged", "rmt/merged"]);
		expect(out.skipped).toEqual([]);
		expect(calls.some((c) => c.startsWith("delLocal:feat/gone"))).toBe(false); // review not touched
	});

	test("INVARIANT: a branch that becomes worktree-locked between plan & execute is NOT deleted", async () => {
		const { client, mutate } = fakeClient({
			locals: [{ name: "feat/x", goneRemote: false }],
			remotes: [],
			current: "main",
			defaultBranch: "main",
			merged: { "feat/x": 5 },
			worktrees: [], // not locked at plan time → planned for delete
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.deleteLocal.map((p) => p.name)).toEqual(["feat/x"]);
		mutate.setWorktrees(["feat/x"]); // race: now locked
		const out = await executeSweep(plan, client, { protectedSet: PROT() });
		expect(out.deletedLocal).toEqual([]);
		expect(out.skipped).toEqual([{ name: "feat/x", reason: "worktree-locked" }]);
	});

	test("INVARIANT: a REMOTE that becomes worktree-locked between plan & execute is NOT deleted", async () => {
		const { client, mutate } = fakeClient({
			locals: [],
			remotes: ["feat/x"],
			current: "main",
			defaultBranch: "main",
			merged: { "feat/x": 5 },
			worktrees: [], // not locked at plan time → planned for delete
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.deleteRemote.map((p) => p.name)).toEqual(["feat/x"]);
		mutate.setWorktrees(["feat/x"]); // race: a sibling worktree checks it out
		const out = await executeSweep(plan, client, { protectedSet: PROT() });
		expect(out.deletedRemote).toEqual([]);
		expect(out.skipped).toEqual([{ name: "feat/x", reason: "worktree-locked" }]);
	});

	test("confirm deletes a reviewed branch (re-guarded); refuses a non-review branch", async () => {
		const { client } = fakeClient({
			locals: [
				{ name: "feat/gone", goneRemote: true },
				{ name: "main", goneRemote: false },
			],
			remotes: [],
			current: "main",
			defaultBranch: "main",
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.review.map((p) => p.name)).toEqual(["feat/gone"]);

		const ok = await executeSweep(plan, client, { protectedSet: PROT(), confirm: ["feat/gone"] });
		expect(ok.deletedLocal).toEqual(["feat/gone"]);

		const nope = await executeSweep(plan, client, { protectedSet: PROT(), confirm: ["main"] });
		expect(nope.deletedLocal).toEqual([]);
		expect(nope.skipped).toEqual([{ name: "main", reason: "not in review" }]);
	});

	test("confirm of a reviewed remote that now has an active OPEN PR is skipped", async () => {
		const { client, mutate } = fakeClient({
			locals: [],
			remotes: ["feat/conflict"],
			current: "main",
			defaultBranch: "main",
			merged: { "feat/conflict": 9 },
			open: ["feat/conflict"], // merged BUT open → review (medium)
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.review.map((p) => p.name)).toEqual(["feat/conflict"]);
		const out = await executeSweep(plan, client, { protectedSet: PROT(), confirm: ["feat/conflict"] });
		expect(out.deletedRemote).toEqual([]); // still open at execute → refused even when confirmed
		expect(out.skipped).toEqual([{ name: "feat/conflict", reason: "open-PR-active" }]);
		// (mutate kept for clarity; the open set is unchanged here)
		void mutate;
	});

	test("a failed LOCAL delete → skipped with reason, NOT in deletedLocal", async () => {
		const { client, calls } = fakeClient({
			locals: [{ name: "feat/merged", goneRemote: false }],
			remotes: [],
			current: "main",
			defaultBranch: "main",
			merged: { "feat/merged": 10 },
			failLocal: ["feat/merged"], // git branch -D exits non-zero
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.deleteLocal.map((p) => p.name)).toEqual(["feat/merged"]);
		const out = await executeSweep(plan, client, { protectedSet: PROT() });
		expect(out.deletedLocal).toEqual([]); // not falsely recorded as deleted
		expect(out.skipped).toContainEqual({ name: "feat/merged", reason: expect.stringMatching(/delete failed.*branch not found/) });
		expect(calls.some((c) => c.startsWith("delLocal:feat/merged"))).toBe(true); // delete WAS attempted
	});

	test("a failed REMOTE delete → skipped with reason, NOT in deletedRemote", async () => {
		const { client } = fakeClient({
			locals: [],
			remotes: ["rmt/merged"],
			current: "main",
			defaultBranch: "main",
			merged: { "rmt/merged": 11 },
			failRemote: ["rmt/merged"], // git push origin --delete exits non-zero
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.deleteRemote.map((p) => p.name)).toEqual(["rmt/merged"]);
		const out = await executeSweep(plan, client, { protectedSet: PROT() });
		expect(out.deletedRemote).toEqual([]); // not falsely recorded as deleted
		expect(out.skipped).toContainEqual({ name: "rmt/merged", reason: expect.stringMatching(/delete failed.*remote rejected/) });
	});

	test("confirm of a reviewed branch whose delete fails → skipped with reason", async () => {
		const { client } = fakeClient({
			locals: [{ name: "feat/gone", goneRemote: true }],
			remotes: [],
			current: "main",
			defaultBranch: "main",
			failLocal: ["feat/gone"],
		});
		const plan = await buildSweepPlan(client, { protectedSet: PROT(), limit: 200, fetched: true });
		expect(plan.review.map((p) => p.name)).toEqual(["feat/gone"]);
		const out = await executeSweep(plan, client, { protectedSet: PROT(), confirm: ["feat/gone"] });
		expect(out.deletedLocal).toEqual([]);
		expect(out.skipped).toContainEqual({ name: "feat/gone", reason: expect.stringMatching(/delete failed/) });
	});
});

describe("runSweep", () => {
	test("dry-run (no execute/confirm) → executed undefined, nothing deleted, prune ran", async () => {
		const { client, calls } = matrixClient();
		const out = await runSweep({ client });
		expect(out.executed).toBeUndefined();
		expect(calls.some((c) => c.startsWith("del"))).toBe(false);
		expect(calls).toContain("fetchPrune");
		expect(out.fetched).toBe(true);
	});

	test("execute=true → deletes high-confidence + executed present", async () => {
		const { client } = matrixClient();
		const out = await runSweep({ client, execute: true });
		expect(out.executed?.deletedLocal).toEqual(["feat/merged"]);
		expect(out.executed?.deletedRemote).toEqual(["feat/merged", "rmt/merged"]);
	});

	test("prune:false skips fetchPrune and sets fetched=false", async () => {
		const { client, calls } = matrixClient();
		const out = await runSweep({ client, prune: false });
		expect(calls).not.toContain("fetchPrune");
		expect(out.fetched).toBe(false);
	});
});
