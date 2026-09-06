/**
 * hard-problem-def.test.ts — contract guard for the committed project-scope
 * agent definition `.pi/agents/hard-problem.md` (the learnings-hardening
 * effort's knowledge layer). The file IS the mechanism: every s2-agent
 * session started from the repo root loads it, and the tui-drive scenarios
 * dispatch through a copy of it. If someone renames the file, drops the
 * model binding, or trims the baked-in learnings, the hard-problem routing
 * convention silently dies — this test makes that a CI failure instead.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgentRegistry, parseAgentDefinition } from "@repo/s2-agent-core-runtime";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DEF_PATH = join(REPO_ROOT, ".pi", "agents", "hard-problem.md");

describe("committed .pi/agents/hard-problem.md", () => {
  const raw = readFileSync(DEF_PATH, "utf8");

  test("parses as an agent definition with the big-model binding", () => {
    const def = parseAgentDefinition(raw, "project", "hard-problem.md");
    expect(def).not.toBeNull();
    expect(def?.name).toBe("hard-problem");
    expect(def?.model).toBe("zai/glm-5.3");
    expect(def?.source).toBe("project");
  });

  test("the operating learnings ride in the prompt (what subagents actually load)", () => {
    const def = parseAgentDefinition(raw, "project", "hard-problem.md");
    const prompt = def?.prompt ?? "";
    // One marker per learning family — trim the prompt and these die loudly.
    expect(prompt).toContain("Operating learnings");
    expect(prompt).toContain("grep the DEPLOYED BUNDLE");
    expect(prompt).toContain("eats the FIRST keypress");
    expect(prompt).toContain("TERM=xterm-256color");
    expect(prompt).toContain("frozen at process start");
  });

  test("registers through loadAgentRegistry from the repo root (project scope wins)", () => {
    const reg = loadAgentRegistry(REPO_ROOT);
    const def = reg.get("hard-problem");
    expect(def?.source).toBe("project");
    expect(def?.model).toBe("zai/glm-5.3");
  });
});
