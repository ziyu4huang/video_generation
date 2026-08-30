import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The sync-first rule — "before ANY devops chain step and before executing a
// next-goal queue head, verify the tree is at the remote default branch's tip"
// — lives in two SKILL.mds. Prose drifted before (the next-goal v1 template
// drifted with nothing catching it, which is why the validator exists); this
// pin keeps the rule from being edited away or watered down silently. If a
// pinned marker legitimately moves, update it HERE in the same change — a red
// run means the hands-on discipline lost its documented step 1, not that the
// test is flaky.
const PKG = join(import.meta.dir, "..");

function skill(name: string): string {
	return readFileSync(join(PKG, "skills", name, "SKILL.md"), "utf8");
}

describe("sync-first rule is pinned in the devops skills", () => {
	test("devops-workflow keeps step 0 as the unconditional sync check", () => {
		const doc = skill("devops-workflow");
		// Step 0 exists and is unconditional ("no exceptions"), not folded into
		// a later step or made advisory.
		expect(doc).toContain("### 0. Sync check");
		expect(doc).toContain("no exceptions");
		// It covers the next-goal queue head, not just the chain's own steps.
		expect(doc).toContain("before executing a next-goal queue head");
		// And names the canonical invocations: the one-shot hands-on prelude
		// (state-agnostic, verdict callerAtTip) + the rebase form for attached trees.
		expect(doc).toContain("sync-default-branch-cli.ts --mode hands-on");
		expect(doc).toContain("callerAtTip");
		expect(doc).toContain("sync-default-branch-cli.ts --mode rebase");
	});

	test("self-reflect-next-goal keeps sync as EXECUTE step 1", () => {
		const doc = skill("self-reflect-next-goal");
		const execute = doc.slice(doc.indexOf("## EXECUTE"));
		// The first numbered step of EXECUTE is the sync, before reading the
		// queue head — assert it appears before the "Read" step of the list.
		const step1 = execute.indexOf("1. **Sync to the remote default branch first");
		const step2 = execute.indexOf("2. Read `output/LATEST-next-goal.md`");
		expect(step1).toBeGreaterThan(-1);
		expect(step2).toBeGreaterThan(step1);
		// The one-shot hands-on form + its callerAtTip license gate.
		expect(execute).toContain("sync-default-branch-cli.ts --mode hands-on");
		expect(execute).toContain("callerAtTip");
	});

	test("self-reflect-next-goal keeps the stale-tree common-mistake row", () => {
		const doc = skill("self-reflect-next-goal");
		expect(doc).toContain("Executing the queue head from a stale tree");
	});
});
