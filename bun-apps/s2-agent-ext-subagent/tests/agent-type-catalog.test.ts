/**
 * agent-type-catalog tests (self-arc-8) — the parent router must SEE the
 * agentType catalog the way Claude Code's Task description lists subagent
 * types. Deterministic: same directory state ⇒ same catalog string (the
 * schema-cost baseline depends on it).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentDefinition } from "@repo/s2-agent-core-runtime";
import {
  buildAgentTypeCatalog,
  CATALOG_HEADER,
  DEFAULT_CATALOG_MAX_CHARS,
  DEFAULT_CATALOG_MAX_ENTRIES,
  formatCatalogEntry,
  withAgentTypeCatalog,
} from "../src/agent-type-catalog.js";
import { createSubagentTool } from "../src/subagent-tool.js";
import { createSubagentsTool } from "../src/subagents-tool.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s2-catalog-"));
  return () => rmSync(home, { recursive: true, force: true });
});

/** Seed project agentTypes under <home>/.pi/agents (the spawn loader's dir). */
function seed(name: string, description?: string) {
  writeAgentDefinition(join(home, ".pi", "agents"), {
    name,
    description,
    prompt: `You are ${name}.`,
  } as never);
}

describe("formatCatalogEntry", () => {
  test("name only when no description; whitespace collapsed", () => {
    expect(formatCatalogEntry("explorer", undefined)).toBe("explorer");
    expect(formatCatalogEntry("explorer", "")).toBe("explorer");
    expect(formatCatalogEntry("explorer", "  does\n\tthings  ")).toBe("explorer — does things");
  });

  test("long entries truncate with an ellipsis, never mid-name", () => {
    const row = formatCatalogEntry("ab", "x".repeat(300), 40);
    expect(row.length).toBe(40);
    expect(row.endsWith("…")).toBe(true);
    expect(row.startsWith("ab — ")).toBe(true);
  });
});

describe("buildAgentTypeCatalog", () => {
  test("lists project types with descriptions, then builtins (registry order)", () => {
    seed("hard-problem", "Deep analysis on a fresh context");
    seed("plain");
    const catalog = buildAgentTypeCatalog(home);
    expect(catalog.startsWith(`${CATALOG_HEADER}: `)).toBe(true);
    const body = catalog.slice(CATALOG_HEADER.length + 2);
    const entries = body.split("; ").map((e) => e.trim());
    // project defs first, in definition order; builtins after (registry precedence fill)
    expect(entries[0]).toContain("hard-problem — Deep analysis on a fresh context");
    expect(entries[1]).toBe("plain");
    expect(entries.join("; ")).toContain("explore");
    expect(entries.join("; ")).toContain("plan");
  });

  test("caps entries and total chars (schema-cost budget)", () => {
    for (let i = 0; i < DEFAULT_CATALOG_MAX_ENTRIES + 5; i++) {
      seed(`type-${i}`, "d".repeat(200));
    }
    const catalog = buildAgentTypeCatalog(home, { entryMaxChars: 200 });
    const entries = catalog.slice(CATALOG_HEADER.length + 2).split("; ").length;
    expect(entries).toBeLessThanOrEqual(DEFAULT_CATALOG_MAX_ENTRIES);
    expect(catalog.length).toBeLessThanOrEqual(CATALOG_HEADER.length + 2 + DEFAULT_CATALOG_MAX_CHARS);
  });

  test("deterministic for a given directory state", () => {
    seed("hard-problem", "Deep analysis");
    expect(buildAgentTypeCatalog(home)).toBe(buildAgentTypeCatalog(home));
  });
});

describe("description wiring (spawn + batch tools)", () => {
  test("createSubagentTool appends the catalog computed from cwd", () => {
    seed("hard-problem", "Deep analysis on a fresh context");
    const tool = createSubagentTool({ cwd: home, agentRegistry: new Map() as never });
    expect(tool.description).toContain(`${CATALOG_HEADER}: hard-problem — Deep analysis on a fresh context`);
  });

  test("createSubagentsTool (batch) carries the catalog too", () => {
    seed("hard-problem", "Deep analysis on a fresh context");
    const tool = createSubagentsTool({ cwd: home });
    expect(tool.description).toContain("hard-problem");
    expect(tool.description).toContain(CATALOG_HEADER);
  });

  test("an injected catalog overrides the cwd computation (tests/embedders)", () => {
    const tool = createSubagentTool({ cwd: home, agentTypeCatalog: "Available agentTypes: pinned — only" });
    expect(tool.description.endsWith("Available agentTypes: pinned — only")).toBe(true);
  });
});

test("withAgentTypeCatalog: empty catalog leaves the description untouched", () => {
  expect(withAgentTypeCatalog("Base.", "")).toBe("Base.");
  expect(withAgentTypeCatalog("Base.", "Available agentTypes: x")).toBe("Base. Available agentTypes: x");
});

// F-actor (self-arc-8): a TYPED singular dispatch must carry its agentType
// name into the in-flight entry — the row actor used to fall back to
// "general-purpose" while the def's prompt was visibly running, making
// catalog-routed children indistinguishable from default ones. Source pin:
// the entry builder must prefer the explicit role label, then the type name.
test("F-actor — typed singular dispatches render their agentType as the row actor (source pin)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "subagent-tool.ts"), "utf8");
  // biome wraps the assignment across lines — pin the formatting-stable core.
  expect(src).toContain(
    'params.agent ??\n                  (typeof params.agentType === "string" && params.agentType ? params.agentType : undefined)',
  );
});
