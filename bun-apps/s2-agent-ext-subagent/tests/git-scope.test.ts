import { test } from "bun:test";
import assert from "node:assert/strict";
import { computeScopeCheck, type GitScopeOps, outOfScopePaths, realGitOps } from "../src/git-scope.js";

// ── outOfScopePaths (pure prefix classification) ──

test("outOfScopePaths: empty scope ⇒ every touched path is out of scope (read-only guard)", () => {
  const touched = ["src/a.ts", "README.md"];
  assert.deepEqual(outOfScopePaths(touched, []), ["src/a.ts", "README.md"]);
});

test("outOfScopePaths: file entry matches itself exactly", () => {
  assert.deepEqual(outOfScopePaths(["src/a.ts", "src/b.ts"], ["src/a.ts"]), ["src/b.ts"]);
});

test("outOfScopePaths: dir entry (trailing slash) covers everything under it", () => {
  assert.deepEqual(outOfScopePaths(["src/a.ts", "src/sub/b.ts", "README.md"], ["src/"]), ["README.md"]);
});

test("outOfScopePaths: dir entry without trailing slash still prefixes", () => {
  // 'src' covers 'src/a.ts' and 'src/sub/b.ts' but not 'src-other/x.ts'
  const touched = ["src/a.ts", "src/sub/b.ts", "src-other/x.ts", "src"];
  assert.deepEqual(outOfScopePaths(touched, ["src"]), ["src-other/x.ts"]);
});

test("outOfScopePaths: normalizes leading './' on both scope and touched paths", () => {
  assert.deepEqual(outOfScopePaths(["./src/a.ts"], ["./src/"]), []);
});

test("outOfScopePaths: normalizes trailing '/' on scope entries", () => {
  assert.deepEqual(outOfScopePaths(["src/a.ts", "out/x.ts"], ["src///", "out"]), []);
});

test("outOfScopePaths: preserves input order of out-of-scope paths (no dedup)", () => {
  assert.deepEqual(outOfScopePaths(["z.ts", "a.ts", "m.ts"], ["a.ts"]), ["z.ts", "m.ts"]);
});

test("outOfScopePaths: blank/whitespace touched paths are dropped", () => {
  assert.deepEqual(outOfScopePaths(["src/a.ts", "  ", ""], ["src/"]), []);
});

test("outOfScopePaths: blank scope entries are ignored (treated as empty ⇒ all out)", () => {
  // Only whitespace entries normalize to '' and are filtered → scope is empty.
  assert.deepEqual(outOfScopePaths(["src/a.ts"], ["   "]), ["src/a.ts"]);
});

test("outOfScopePaths: nested file under a sibling dir is out of scope", () => {
  assert.deepEqual(outOfScopePaths(["tests/x.test.ts", "src/y.ts"], ["src/"]), ["tests/x.test.ts"]);
});

// ── computeScopeCheck (orchestration over injectable ops) ──

/** Build a fake GitScopeOps from a fixed post-run HEAD and a path map base..head → paths. */
function fakeOps(opts: { head?: string; paths?: string[]; throwOnHead?: boolean }): {
  ops: GitScopeOps;
  calls: { headCwds: string[]; changed: Array<{ cwd: string; base: string; head: string }> };
} {
  const calls = { headCwds: [] as string[], changed: [] as Array<{ cwd: string; base: string; head: string }> };
  const ops: GitScopeOps = {
    async headCommit(cwd: string) {
      calls.headCwds.push(cwd);
      if (opts.throwOnHead) throw new Error("git blew up");
      return opts.head;
    },
    async changedPaths(cwd: string, base: string, head: string) {
      calls.changed.push({ cwd, base, head });
      return opts.paths ?? [];
    },
  };
  return { ops, calls };
}

test("computeScopeCheck: base undefined ⇒ undefined (nothing to check)", async () => {
  const { ops } = fakeOps({ head: "h2" });
  assert.equal(await computeScopeCheck(ops, "/repo", undefined, ["src/"]), undefined);
});

test("computeScopeCheck: post-run HEAD undefined ⇒ undefined (not a repo after run)", async () => {
  const { ops, calls } = fakeOps({ head: undefined });
  assert.equal(await computeScopeCheck(ops, "/repo", "b1", ["src/"]), undefined);
  assert.equal(calls.changed.length, 0, "changedPaths not called when HEAD can't resolve");
});

test("computeScopeCheck: throwing headCommit ⇒ undefined (never propagates)", async () => {
  const { ops } = fakeOps({ head: "h2", throwOnHead: true });
  assert.equal(await computeScopeCheck(ops, "/repo", "b1", ["src/"]), undefined);
});

test("computeScopeCheck: base === head (no new commits) ⇒ empty touched, no headCommit field", async () => {
  const { ops, calls } = fakeOps({ head: "same", paths: ["should-not-be-used.ts"] });
  const check = await computeScopeCheck(ops, "/repo", "same", ["src/"]);
  assert.deepEqual(check, { baseCommit: "same", touchedPaths: [], outOfScope: [] });
  assert.equal(check?.headCommit, undefined, "headCommit omitted when nothing advanced");
  assert.equal(calls.changed.length, 0, "changedPaths skipped when base === head");
});

test("computeScopeCheck: base !== head ⇒ changedPaths(base..head) classified against scope", async () => {
  const { ops, calls } = fakeOps({ head: "h2", paths: ["src/a.ts", "README.md", ".planning/stub.md"] });
  const check = await computeScopeCheck(ops, "/repo", "b1", ["src/"]);
  assert.deepEqual(calls.changed, [{ cwd: "/repo", base: "b1", head: "h2" }]);
  assert.deepEqual(check?.touchedPaths, ["src/a.ts", "README.md", ".planning/stub.md"]);
  assert.deepEqual(check?.outOfScope, ["README.md", ".planning/stub.md"]);
  assert.equal(check?.headCommit, "h2");
});

test("computeScopeCheck: empty scope flags every touched path", async () => {
  const { ops } = fakeOps({ head: "h2", paths: ["src/a.ts", "x.ts"] });
  const check = await computeScopeCheck(ops, "/repo", "b1", []);
  assert.deepEqual(check?.outOfScope, ["src/a.ts", "x.ts"]);
});

test("computeScopeCheck: all touched in scope ⇒ outOfScope empty", async () => {
  const { ops } = fakeOps({ head: "h2", paths: ["src/a.ts", "src/sub/b.ts"] });
  const check = await computeScopeCheck(ops, "/repo", "b1", ["src/"]);
  assert.deepEqual(check?.outOfScope, []);
});

test("realGitOps is a GitScopeOps (structural shape, no exec here)", () => {
  assert.equal(typeof realGitOps.headCommit, "function");
  assert.equal(typeof realGitOps.changedPaths, "function");
});
