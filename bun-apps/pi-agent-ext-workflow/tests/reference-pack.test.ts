import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../src/workflow-pack-manifest.js";
import { loadAgentRegistry } from "../src/agent-registry.js";

/**
 * `samples/reference-pack` — the living reference pack (ticket 14, T8).
 * Exercises the manifest io/agents/version contract + bundled multi-role agents
 * (including the T3 comma-string `tools` form) + a shipped .gitignore.
 */
const PACK = join(process.cwd(), "samples", "reference-pack");

describe("reference-pack", () => {
  test("has a valid manifest exercising io + agents + version", () => {
    const m = validateManifest(JSON.parse(readFileSync(join(PACK, "manifest.json"), "utf8")));
    expect(m.name).toBe("reference-pack");
    expect(m.agents).toBe("agents/*.md");
    expect(m.io?.outputs?.naming).toBe("timestamped");
    expect(m.io?.intermediate?.persist).toBe(false);
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("bundles >=2 agent roles that load + bind by name (exercises T3 comma-string tools)", () => {
    const reg = loadAgentRegistry(process.cwd(), { projectDir: join(PACK, "agents") });
    expect(reg.has("researcher")).toBe(true);
    expect(reg.has("writer")).toBe(true);
    // comma-string `tools: Read, Grep, WebSearch` must parse to an allowlist (T3 fix)
    expect(reg.get("researcher")?.tools).toEqual(["Read", "Grep", "WebSearch"]);
    expect(reg.get("writer")?.tools).toEqual(["Read", "Write"]);
  });

  test("ships a .gitignore for the ephemeral state dirs", () => {
    const gi = readFileSync(join(PACK, ".gitignore"), "utf8");
    expect(gi).toContain("outputs/");
    expect(gi).toContain("intermediate/");
    expect(gi).toContain("runs/");
  });

  test("entry.js + manifest.json both present", () => {
    expect(existsSync(join(PACK, "entry.js"))).toBe(true);
    expect(existsSync(join(PACK, "manifest.json"))).toBe(true);
  });
});
