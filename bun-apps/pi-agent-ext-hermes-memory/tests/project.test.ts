import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { detectProject, detectProjectSkills, resolveProjectStoreDir } from "../src/project.js";
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
