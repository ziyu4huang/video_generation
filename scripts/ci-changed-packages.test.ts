/**
 * ci-changed-packages.test.ts — deterministic tests for ci-changed-packages.sh's
 * path-based CI matrix filtering.
 *
 * Builds a synthetic bun-apps/ tree (own git repo, own package.json files) so
 * the @repo/* dependency-graph discovery and reverse-BFS propagation are
 * exercised against REAL files on disk — same "as shipped" philosophy as
 * pr-finish.test.ts, no mocking of the script's own logic.
 *
 * Run: `bun test scripts/ci-changed-packages.test.ts`
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dirname, "ci-changed-packages.sh");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/**
 * Build a temp repo with bun-apps/<name>/package.json for each entry (deps is
 * its @repo/* dependency list, self-reference auto-included as the convention
 * this script strips). Returns { dir, baseSha }.
 */
function mkRepo(pkgs: Record<string, string[]>): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccp-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);

  for (const [name, deps] of Object.entries(pkgs)) {
    const pkgDir = join(dir, "bun-apps", name);
    mkdirSync(pkgDir, { recursive: true });
    const depsObj: Record<string, string> = { [`@repo/${name}`]: "workspace:*" };
    for (const d of deps) depsObj[`@repo/${d}`] = "workspace:*";
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: `@repo/${name}`, dependencies: depsObj }, null, 2),
    );
    writeFileSync(join(pkgDir, "index.ts"), `export const name = "${name}";\n`);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
  const baseSha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
  return { dir, baseSha };
}

function touch(dir: string, relPath: string, content = "// touched\n") {
  writeFileSync(join(dir, relPath), content);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "change"]);
}

function run(dir: string, baseSha: string): Record<string, boolean> {
  const stdout = execFileSync("bash", [SCRIPT, baseSha, "HEAD"], { cwd: dir }).toString();
  return JSON.parse(stdout);
}

test("--all marks every discovered package true", () => {
  const { dir } = mkRepo({ a: [], b: [] });
  const stdout = execFileSync("bash", [SCRIPT, "--all"], { cwd: dir }).toString();
  const result = JSON.parse(stdout);
  expect(result).toEqual({ a: true, b: true });
});

test("change confined to an isolated package only marks that package", () => {
  const { dir, baseSha } = mkRepo({ a: [], b: [] });
  touch(dir, "bun-apps/a/index.ts");
  expect(run(dir, baseSha)).toEqual({ a: true, b: false });
});

test("changing a dependency propagates to its direct dependent", () => {
  // flux2-analogue depends on file2md-analogue
  const { dir, baseSha } = mkRepo({ leaf: [], consumer: ["leaf"] });
  touch(dir, "bun-apps/leaf/index.ts");
  expect(run(dir, baseSha)).toEqual({ leaf: true, consumer: true });
});

test("changing a dependency propagates transitively (two hops)", () => {
  // movie-director-analogue -> flux2-analogue -> file2md-analogue
  const { dir, baseSha } = mkRepo({ base: [], mid: ["base"], top: ["mid"] });
  touch(dir, "bun-apps/base/index.ts");
  expect(run(dir, baseSha)).toEqual({ base: true, mid: true, top: true });
});

test("unrelated package stays false even when its sibling's dependency changes", () => {
  const { dir, baseSha } = mkRepo({ leaf: [], consumer: ["leaf"], bystander: [] });
  touch(dir, "bun-apps/leaf/index.ts");
  expect(run(dir, baseSha)).toEqual({ leaf: true, consumer: true, bystander: false });
});

test("a change outside any bun-apps/<pkg>/ path fails open (marks everything true)", () => {
  const { dir, baseSha } = mkRepo({ a: [], b: [] });
  writeFileSync(join(dir, "root-config.json"), "{}\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "shared config change"]);
  expect(run(dir, baseSha)).toEqual({ a: true, b: true });
});

test("self-reference in a package's own @repo/* deps does not create a cycle", () => {
  // mkRepo already injects @repo/<self> into every package's deps (the
  // typecheck/devDep convention seen across bun-apps/*); this must not make a
  // package its own dependent or hang the BFS.
  const { dir, baseSha } = mkRepo({ solo: [] });
  touch(dir, "bun-apps/solo/index.ts");
  expect(run(dir, baseSha)).toEqual({ solo: true });
});
