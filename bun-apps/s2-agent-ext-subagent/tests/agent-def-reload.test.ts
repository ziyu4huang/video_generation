/**
 * agent-def-reload.test.ts — pin the LIVE-RELOAD guarantee: agent definitions
 * (.pi/agents/*.md) are re-read from disk on EVERY spawn, not cached at
 * session start. This is what makes the /agents manager (and any hand edit)
 * take effect on the next dispatch without restarting the session — the
 * CC-parity behavior. If someone "optimizes" the tool into holding a
 * session-scoped registry, edits silently stop applying and these pins fail.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agent-definition live reload (source pins)", () => {
  test("spawn_subagent re-loads the registry per call (no session cache)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "subagent-tool.ts"), "utf8");
    // The per-call load — options.agentRegistry stays an opt-in override for
    // tests/workflows, but the interactive path MUST hit the disk.
    expect(src).toContain("options.agentRegistry ?? loadAgentRegistry(runCwd)");
  });

  test("the batch tool re-loads the registry per batch when any task names an agentType", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "subagents-tool.ts"), "utf8");
    expect(src).toContain("options.agentRegistry ?? loadAgentRegistry(defaultCwd)");
  });

  test("the /agents manager reloads after every CRUD action (no stale dialog)", () => {
    const cmd = readFileSync(join(import.meta.dir, "..", "src", "agents-command.ts"), "utf8");
    // The command hands the viewer an onReload that re-runs loadAgentRegistry;
    // the viewer calls it after every successful create/edit/delete.
    expect(cmd).toContain("onReload: load");
    const viewer = readFileSync(join(import.meta.dir, "..", "src", "agents-viewer.ts"), "utf8");
    expect(viewer).toContain("private reload(): void");
    expect(viewer).toContain("this.registry = this.onReload()");
  });
});
