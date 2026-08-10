import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentHistoryEntry } from "../src/agent-history.js";
import type { GitScopeOps, SubagentScopeCheck } from "../src/git-scope.js";
import type { RepoBaseline } from "../src/watchdog/repo-diff.js";
import type { WatchdogResult } from "../src/watchdog/types.js";
import {
  augmentOutputWithScopeViolation,
  captureCommitBaseline,
  captureWatchdogBaseline,
  resolveDisplayModel,
  runScopeCheck,
  runWatchdogReview,
} from "../src/subagent-tool-run.js";

const fakeGitOps = (head: string | (() => Promise<string>) = "abc"): GitScopeOps =>
  ({ headCommit: typeof head === "string" ? async () => head : head }) as unknown as GitScopeOps;

test("resolveDisplayModel: requestedModel wins; then capability > tier > mainModel > default", () => {
  assert.equal(resolveDisplayModel("gpt-4", "vision", "big", "m"), "gpt-4");
  assert.equal(resolveDisplayModel(undefined, "vision", "big", "m"), "capability:vision");
  assert.equal(resolveDisplayModel(undefined, undefined, "big", "m"), "tier:big");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, "m"), "m");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, undefined), "default");
});

test("captureCommitBaseline: undefined when scope unset or worktree-isolated", async () => {
  assert.equal(await captureCommitBaseline(undefined, "/r", "/r", fakeGitOps()), undefined);
  assert.equal(await captureCommitBaseline(["src/"], "/wt", "/r", fakeGitOps()), undefined);
});

test("captureCommitBaseline: returns headCommit on the real tree", async () => {
  assert.equal(await captureCommitBaseline(["src/"], "/r", "/r", fakeGitOps("deadbeef")), "deadbeef");
});

test("captureCommitBaseline: swallows headCommit throw → undefined", async () => {
  const ops = fakeGitOps(async () => { throw new Error("no git"); });
  assert.equal(await captureCommitBaseline(["src/"], "/r", "/r", ops), undefined);
});

test("runScopeCheck: undefined unless scope set + real tree + baseCommit present", async () => {
  const compute = async () => ({ outOfScope: [], inScope: [] } as unknown as SubagentScopeCheck);
  assert.equal(await runScopeCheck(undefined, "/r", "/r", "abc", fakeGitOps(), compute), undefined);
  assert.equal(await runScopeCheck(["src/"], "/wt", "/r", "abc", fakeGitOps(), compute), undefined);
  assert.equal(await runScopeCheck(["src/"], "/r", "/r", undefined, fakeGitOps(), compute), undefined);
  const out = await runScopeCheck(["src/"], "/r", "/r", "abc", fakeGitOps(), compute);
  assert.deepEqual(out, { outOfScope: [], inScope: [] } as unknown as SubagentScopeCheck);
});

test("captureWatchdogBaseline: undefined when normalizeWatchdogParam rejects; {opts,baseline} otherwise", () => {
  // undefined param → normalizeWatchdogParam returns a falsy opts → undefined
  assert.equal(captureWatchdogBaseline("/r", undefined, () => ({}) as RepoBaseline), undefined);
  // a truthy param (boolean true) → opts truthy, baseline computed
  const got = captureWatchdogBaseline("/r", true, () => ({ marker: "x" } as unknown as RepoBaseline));
  assert.ok(got && "opts" in got && got.baseline);
});

test("runWatchdogReview: summary line when ran/editGated; empty otherwise; error line on throw", async () => {
  const ran: WatchdogResult = { ran: true, editGated: false, summary: "ok" } as unknown as WatchdogResult;
  const gated: WatchdogResult = { ran: false, editGated: true, summary: "no-diff" } as unknown as WatchdogResult;
  const idle: WatchdogResult = { ran: false, editGated: false, summary: "" } as unknown as WatchdogResult;
  const fakeRun = async (_input: { cwd: string; before: RepoBaseline; opts: { l1: boolean; l2: boolean }; taskLabel: string }) => ran;
  assert.ok((await runWatchdogReview(fakeRun, { l1: true, l2: false }, {} as RepoBaseline, "/r", "t")).outputAppend.includes("ok"));
  assert.ok((await runWatchdogReview(async () => gated, { l1: true, l2: false }, {} as RepoBaseline, "/r", "t")).outputAppend.includes("no-diff"));
  assert.equal((await runWatchdogReview(async () => idle, { l1: true, l2: false }, {} as RepoBaseline, "/r", "t")).outputAppend, "");
  const err = await runWatchdogReview(async () => { throw new Error("boom"); }, { l1: true, l2: false }, {} as RepoBaseline, "/r", "t");
  assert.ok(err.outputAppend.includes("watchdog-error: boom"));
  assert.equal(err.result, undefined);
});

test("augmentOutputWithScopeViolation: passthrough when none; appends block when out-of-scope", () => {
  assert.equal(augmentOutputWithScopeViolation("done", undefined), "done");
  const out = augmentOutputWithScopeViolation("done", { outOfScope: ["evil.txt"], inScope: [] } as unknown as SubagentScopeCheck);
  assert.ok(out.startsWith("done\n\n--- ⚠ commit-scope violation (1) ---"));
  assert.ok(out.includes("- evil.txt"));
});
