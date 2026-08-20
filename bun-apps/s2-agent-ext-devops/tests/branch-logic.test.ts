/**
 * Tests for the PURE branch-classification logic (no I/O). The heart of
 * sweep_merged_branches: given the observed signals for a branch, decide its
 * confidence tier + bucket (delete / review / keep). Conservative by design —
 * delete only on positive gh merge evidence; [gone] is a hint, never proof.
 */
import { test, expect, describe } from "bun:test";
import { classifyBranch, type BranchInput } from "../src/branch-logic.js";

/** Minimal input: a non-guarded, signal-free branch → keep. Override per case. */
function inp(over: Partial<BranchInput> = {}): BranchInput {
	return {
		kind: "local",
		mergedPr: false,
		gone: false,
		contained: false,
		openPr: false,
		inWorktree: false,
		isProtected: false,
		isCurrent: false,
		...over,
	};
}

describe("classifyBranch — guards (absolute, checked first)", () => {
	test("worktree-locked → keep, even when gh says merged (ABSOLUTE)", () => {
		const v = classifyBranch(inp({ inWorktree: true, mergedPr: true }));
		expect(v.bucket).toBe("keep");
		expect(v.confidence).toBe("none");
		expect(v.reason).toBe("worktree-locked");
	});

	test("protected → keep", () => {
		expect(classifyBranch(inp({ isProtected: true, mergedPr: true })).bucket).toBe("keep");
	});

	test("current → keep", () => {
		expect(classifyBranch(inp({ isCurrent: true, mergedPr: true })).bucket).toBe("keep");
	});

	test("worktree + protected + current together → still keep", () => {
		expect(classifyBranch(inp({ inWorktree: true, isProtected: true, isCurrent: true })).bucket).toBe("keep");
	});
});

describe("classifyBranch — high-confidence delete", () => {
	test("merged + no open-PR conflict → high/delete", () => {
		const v = classifyBranch(inp({ mergedPr: true }));
		expect(v).toEqual({ confidence: "high", bucket: "delete", reason: "gh-confirmed merge" });
	});

	test("corroboration (gone/contained) does not change a high tier", () => {
		expect(classifyBranch(inp({ mergedPr: true, gone: true, contained: true })).confidence).toBe("high");
	});
});

describe("classifyBranch — review (human decides)", () => {
	test("merged BUT an open PR reuses the ref → medium/review", () => {
		const v = classifyBranch(inp({ mergedPr: true, openPr: true }));
		expect(v.bucket).toBe("review");
		expect(v.confidence).toBe("medium");
	});

	test("[gone] without gh merge proof → low/review (hint, not proof)", () => {
		const v = classifyBranch(inp({ gone: true }));
		expect(v.bucket).toBe("review");
		expect(v.confidence).toBe("low");
	});

	test("[gone] never deletes on its own even with corroboration", () => {
		expect(classifyBranch(inp({ gone: true, contained: true })).bucket).toBe("review");
	});
});

describe("classifyBranch — keep (no action)", () => {
	test("no signals → keep", () => {
		const v = classifyBranch(inp());
		expect(v.bucket).toBe("keep");
		expect(v.confidence).toBe("none");
	});

	test("open PR but not merged → keep (branch is active)", () => {
		expect(classifyBranch(inp({ openPr: true })).bucket).toBe("keep");
	});

	test("open PR beats [gone] (active, even though remote deleted)", () => {
		expect(classifyBranch(inp({ openPr: true, gone: true })).bucket).toBe("keep");
	});
});
