import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canHoldProjectStore, detectProject, detectProjectSkills, resolveProjectStoreDir } from "../src/project.js";
import { AGENT_ROOT } from "../src/paths.js";
import type { ProjectInfo } from "../src/project.js";

describe("project detection", () => {
  it("detectProject returns null outside a project", () => {
    const result = detectProject("projects-memory", os.homedir());
    assert.deepStrictEqual(result, { name: null, memoryDir: null });
  });

  it("detectProject resolves the project memory directory from cwd", () => {
    const cwd = "/tmp/demo-repo";
    const result = detectProject("projects-memory", cwd);

    assert.strictEqual(result.name, "demo-repo");
    assert.strictEqual(
      result.memoryDir,
      path.join(AGENT_ROOT, "projects-memory", "demo-repo"),
    );
  });

  it("detectProjectSkills appends the skills directory for dynamic discovery", () => {
    const cwd = "/tmp/demo-repo";
    const result = detectProjectSkills("projects-memory", cwd);

    assert.strictEqual(result.name, "demo-repo");
    assert.strictEqual(
      result.skillsDir,
      path.join(AGENT_ROOT, "projects-memory", "demo-repo", "skills"),
    );
  });

  it("detectProject uses the projectName override when given (ticket 09 — cross-worktree coherence)", () => {
    const cwd = "/tmp/video_generation__superpowers";
    const result = detectProject("projects-memory", cwd, "video_generation");
    assert.strictEqual(result.name, "video_generation", "override wins over the cwd basename");
    assert.strictEqual(
      result.memoryDir,
      path.join(AGENT_ROOT, "projects-memory", "video_generation"),
      "memoryDir uses the override name",
    );
  });

  it("detectProject falls back to the cwd basename when no override (current behavior preserved)", () => {
    const cwd = "/tmp/video_generation__superpowers";
    const result = detectProject("projects-memory", cwd);
    assert.strictEqual(result.name, "video_generation__superpowers");
  });
});

describe("resolveProjectStoreDir (ticket 04 — project memory location)", () => {
  const detected: ProjectInfo = {
    name: "demo-repo",
    memoryDir: path.join(AGENT_ROOT, "projects-memory", "demo-repo"),
  };
  const cwd = "/tmp/demo-repo";

  it("default (undefined) + project detected → <cwd>/.agents/memory/ (in-repo)", () => {
    assert.strictEqual(
      resolveProjectStoreDir(undefined, detected, cwd),
      path.join(cwd, ".agents", "memory"),
    );
  });

  it("default (undefined) + no project → null (don't create ~/.planning/ from home)", () => {
    const noProject: ProjectInfo = { name: null, memoryDir: null };
    assert.strictEqual(resolveProjectStoreDir(undefined, noProject, os.homedir()), null);
  });

  it("explicit null → opt-out → legacy global location (detected.memoryDir)", () => {
    assert.strictEqual(resolveProjectStoreDir(null, detected, cwd), detected.memoryDir);
  });

  it("explicit absolute path → that path unchanged", () => {
    const abs = "/var/lib/project-mem";
    assert.strictEqual(resolveProjectStoreDir(abs, detected, cwd), abs);
  });

  it("explicit relative path → resolved cwd-relative", () => {
    assert.strictEqual(
      resolveProjectStoreDir("./custom-mem", detected, cwd),
      path.resolve(cwd, "custom-mem"),
    );
  });
});

describe("canHoldProjectStore", () => {
  it("creates and accepts a writable dir", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-proj-")), ".agents", "memory");
    assert.equal(canHoldProjectStore(dir), true);
    assert.equal(fs.existsSync(dir), true);
  });

  it("rejects a dir under a read-only parent instead of throwing", () => {
    // The deployed-binary case: the sh deploy chmod's its whole tree a-w, and
    // detectProject calls every directory that is not $HOME a project. Before
    // this, the store's mkdir threw straight out of session_start as
    // `Extension error (<inline:hermes-memory>): EACCES`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-frozen-"));
    fs.chmodSync(root, 0o555);
    try {
      assert.equal(canHoldProjectStore(path.join(root, ".agents", "memory")), false);
    } finally {
      fs.chmodSync(root, 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
