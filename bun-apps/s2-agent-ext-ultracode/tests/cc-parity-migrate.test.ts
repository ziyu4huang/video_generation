/**
 * CC-parity B3 — migrate-in-parallel: the pattern arc-12 descoped, proven at
 * the workflow layer.
 *
 * The capability arc-12's D3/D6 assumed missing exists: workflow `agent()`
 * honors `isolation: "worktree"` (workflow-runtime.ts) — each parallel child
 * gets its own worktree (`<repoRoot>/.pi/worktrees/<runId>-<callIndex>-<label>`,
 * branch `pi/wf/<slug>`), no read-only exclusion applies, and the parent tree
 * is untouched. Worktrees are torn down per-call in `finally`, so the gate's
 * assertions on worktree CONTENT happen inside the recording runner; the
 * teardown is asserted after the run.
 *
 * No LLM in this gate: the injected runner performs the "migration" itself
 * (writes + reads back + records). Isolation, parallel dispatch, worktree
 * lifecycle, and parent-tree integrity are all REAL; only the model is fake
 * (arc-12 D2 discipline; live glm-5.3 proof rides t03's receipt).
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { AgentUsage } from "@repo/s2-agent-core-runtime";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const SAMPLES = join(import.meta.dir, "..", "samples", "cc-parity");
const script = (name: string) => readFileSync(join(SAMPLES, name), "utf8");

/** A real git repo with one commit — `git worktree add` needs a HEAD. */
function withGitRepo(fn: (base: string) => Promise<void>) {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-dw-mig-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-mig-home-"));
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "user.email=arc13@test", "-c", "user.name=arc13", ...args], {
        cwd: base,
        stdio: "pipe",
      });
    try {
      git(["init"]);
      writeFileSync(join(base, "a.txt"), "alpha\n");
      writeFileSync(join(base, "b.txt"), "beta\n");
      writeFileSync(join(base, "c.txt"), "gamma\n");
      git(["add", "-A"]);
      git(["commit", "-m", "seed"]);
      await withFakeHomeAsync(fakeHome, () => fn(base));
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

interface Migration {
  cwd: string;
  file: string;
  content: string;
}

test(
  "B3 migrate many files in parallel: isolated writers, parent tree untouched, teardown clean",
  withGitRepo(async (base) => {
    const migrations: Migration[] = [];
    const manager = new WorkflowManager({
      cwd: base,
      // The injected runner IS the migrator: it writes into the cwd the
      // runtime hands it (its worktree), reads back, and records. The
      // no-cwd call is the integration agent (runs in the main tree).
      agent: {
        async run(prompt: string, options?: { cwd?: string; onUsage?: (u: AgentUsage) => void }) {
          options?.onUsage?.({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 });
          if (prompt.startsWith("MIGRATE ") && options?.cwd) {
            const i = migrations.length;
            const file = `migrated-${i}.txt`;
            const content = `migrated content ${i}`;
            writeFileSync(join(options.cwd, file), content);
            migrations.push({
              cwd: options.cwd,
              file,
              content: readFileSync(join(options.cwd, file), "utf8"),
            });
            return `MIGRATED file ${i}`;
          }
          return "INTEGRATION REPORT: 3/3 migrations landed in isolated worktrees";
        },
      },
    });

    const result = await manager.runSync(script("migrate-in-parallel.js"), {
      files: ["a.txt", "b.txt", "c.txt"],
    });

    // The sample's own accounting: 3 files in, 3 migrated out.
    const r = result.result as { files: number; migrated: number; report: string };
    assert.equal(r.files, 3);
    assert.equal(r.migrated, 3);
    assert.equal(result.agentCount, 4, "three migrators + one integrator");

    // Isolation: every writer ran in its OWN worktree, none in the base tree.
    // (realpath: git reports the resolved root — /private/var on macOS — while
    // tmpdir hands out the symlinked /var spelling.)
    const realBase = realpathSync(base);
    const wtRoot = join(realBase, ".pi", "worktrees");
    assert.equal(migrations.length, 3);
    const cwds = new Set(migrations.map((m) => m.cwd));
    assert.equal(cwds.size, 3, "each parallel child got a distinct worktree");
    for (const m of migrations) {
      assert.ok(m.cwd.startsWith(wtRoot + sep), `worktree under the repo's worktree root: ${m.cwd}`);
      assert.match(m.content, /^migrated content \d$/);
    }
    // Parent-tree integrity: the base has the seeded files and NONE of the
    // children's writes.
    for (const seeded of ["a.txt", "b.txt", "c.txt"]) {
      assert.ok(existsSync(join(base, seeded)), `seeded file survives: ${seeded}`);
    }
    for (const f of ["migrated-0.txt", "migrated-1.txt", "migrated-2.txt"]) {
      assert.ok(!existsSync(join(base, f)), `no migration write leaked to the base tree: ${f}`);
    }

    // Lifecycle: worktrees are torn down per-call (workflow-runtime finally).
    assert.ok(!existsSync(wtRoot) || readdirSafe(wtRoot).length === 0, "worktrees removed after the run");
  }),
  60_000,
);

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test("B3 hazard pinned: a NON-REPO base silently downgrades isolation to the main tree", async () => {
  // withTempCwd-style base WITHOUT git init — createWorktree returns
  // {isolated:false, reason:"not a git repository"} and the child runs in
  // the MAIN tree. The runtime logs `isolation ignored`; this gate pins the
  // behavior loudly so the hazard stays a documented one, not a surprise.
  const base = mkdtempSync(join(tmpdir(), "pi-dw-mig-nonrepo-"));
  try {
    const writes: (string | undefined)[] = [];
    const manager = new WorkflowManager({
      cwd: base,
      agent: {
        async run(prompt: string, options?: { cwd?: string; onUsage?: (u: AgentUsage) => void }) {
          options?.onUsage?.({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 });
          if (prompt.startsWith("MIGRATE ")) {
            writes.push(options?.cwd);
            return "MIGRATED";
          }
          return "INTEGRATION REPORT";
        },
      },
    });
    const result = await manager.runSync(script("migrate-in-parallel.js"), { files: ["a.txt"] });
    assert.equal(result.agentCount, 2);
    // The downgrade is visible: cwd is the MAIN tree (the caller's base), so
    // an author who asked for isolation but skipped git-init finds out HERE.
    assert.deepEqual(writes, [undefined], "runner receives no cwd override — main tree");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
