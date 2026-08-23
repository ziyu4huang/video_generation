/**
 * Built-in agent types (cc-parity-2 ticket 03 — map D4): lowest-precedence
 * tier, code-only (`source: "builtin"`), shadowed COMPLETELY by any
 * project/pack/user file of the same name, read-only via the
 * createReadOnlyTools allowlist + explicit denylist. Pure registry tests —
 * no session, no tools runtime.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToolPolicy, loadAgentRegistry, resolveAgentType } from "../src/agent-registry.js";
import { BUILTIN_AGENT_DEFS } from "../src/builtin-agents.js";

const READ_ONLY = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["edit", "write", "bash"];

function tmpDirs() {
  const root = mkdtempSync(join(tmpdir(), "builtin-agents-"));
  const projectDir = join(root, "project");
  const userDir = join(root, "user");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  return { root, projectDir, userDir };
}

test("builtin defs: explore/plan, source builtin, read-only allowlist + explicit denylist", () => {
  assert.deepEqual(
    BUILTIN_AGENT_DEFS.map((d) => d.name),
    ["explore", "plan"],
  );
  for (const def of BUILTIN_AGENT_DEFS) {
    assert.equal(def.source, "builtin");
    assert.ok(def.prompt.length > 0, "prompt body present");
    assert.deepEqual(def.tools, READ_ONLY, `${def.name}: allowlist = createReadOnlyTools set`);
    assert.deepEqual(def.disallowedTools, WRITE_TOOLS, `${def.name}: denylist mirrors READ_ONLY_EXCLUDED`);
    // Read-only-ness binds through a REAL applyToolPolicy pass (deny after allow).
    const codingTools = [...READ_ONLY, ...WRITE_TOOLS, "spawn_subagent"].map((name) => ({ name }));
    const surviving = applyToolPolicy(codingTools, def.tools, def.disallowedTools);
    assert.deepEqual(
      surviving.map((t) => t.name),
      READ_ONLY,
      `${def.name}: only read-only tools survive`,
    );
  }
});

test("builtin names never collide with the request_plan_approval vocabulary", () => {
  // A model typing agentType "plan" means the planner AGENT; "request_plan_approval"
  // is a TOOL name. The built-in namespace must stay disjoint from tool vocabulary
  // so guideline text cannot teach a wrong binding.
  for (const def of BUILTIN_AGENT_DEFS) {
    assert.ok(!def.name.startsWith("request_"), `${def.name} must not look like a request_* tool`);
    assert.ok(def.name !== "request_plan_approval");
  }
});

test("loadAgentRegistry falls through to built-ins when the scans miss", () => {
  const { root, projectDir, userDir } = tmpDirs();
  try {
    const registry = loadAgentRegistry(root, { projectDir, userDir });
    for (const def of BUILTIN_AGENT_DEFS) {
      assert.equal(registry.get(def.name)?.source, "builtin", `${def.name} present as builtin`);
    }
    assert.equal(resolveAgentType("explore", registry)?.source, "builtin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a user file shadows the builtin COMPLETELY (no field merge)", () => {
  const { root, projectDir, userDir } = tmpDirs();
  try {
    writeFileSync(
      join(projectDir, "explore.md"),
      "---\nname: explore\ndescription: my own explorer\ntools: read\n---\nMy custom prompt.",
    );
    const registry = loadAgentRegistry(root, { projectDir, userDir });
    const def = registry.get("explore");
    assert.equal(def?.source, "project", "project file wins");
    assert.equal(def?.prompt, "My custom prompt.", "no builtin prompt merged in");
    assert.deepEqual(def?.tools, ["read"], "no builtin allowlist merged in");
    assert.equal(def?.disallowedTools, undefined, "no builtin denylist merged in");
    // The untouched builtin sibling still resolves.
    assert.equal(registry.get("plan")?.source, "builtin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
