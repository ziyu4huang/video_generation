// tests/watchdog-repo-diff.test.ts

import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { changedTsJsPaths, computeBaseline, diffTextForReview } from "../src/watchdog/repo-diff.js";

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wd-diff-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: dir });
  execSync("git commit -q --allow-empty -m init", { cwd: dir });
  return dir;
}

describe("repo-diff", () => {
  let dir: string;
  before(() => {
    dir = mkRepo();
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("edit-gate: identical signatures when nothing changes", () => {
    const a = computeBaseline(dir);
    const b = computeBaseline(dir);
    assert.ok(a, "baseline must exist");
    assert.ok(b, "baseline must exist");
    assert.equal(a.key, b.key);
  });

  it("signature changes + changedTsJsPaths lists a new TS file", () => {
    const before = computeBaseline(dir);
    assert.ok(before, "baseline must exist");
    fs.writeFileSync(path.join(dir, "impl.ts"), "export const x = 1;\n");
    const after = computeBaseline(dir);
    assert.ok(after, "baseline must exist");
    assert.notEqual(before.key, after.key);
    assert.ok(changedTsJsPaths(before, after).includes("impl.ts"));
  });

  it("diffTextForReview includes the new file content", () => {
    const txt = diffTextForReview(dir, ["impl.ts"]);
    assert.match(txt, /export const x = 1/);
  });
});
