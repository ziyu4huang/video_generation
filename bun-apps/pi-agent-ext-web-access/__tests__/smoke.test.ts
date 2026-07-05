/**
 * smoke.test.ts — L0 smoke tests for pi-agent-ext-web-access.
 *
 * WHAT THIS TESTS:
 *   • Extension factory produces the expected tool set
 *   • Each tool has the required shape (name, description, parameters, execute)
 *   • Skills directory exists with valid content
 *
 * HOW TO RUN:
 *   ( cd bun-apps/pi-agent-ext-web-access && bun test )
 *   bun test --cwd bun-apps/pi-agent-ext-web-access
 */

import { test, expect } from "bun:test";

// ─── Tool shape helpers ──────────────────────────────────────────────────────

interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: object;
  execute: (...args: unknown[]) => unknown;
  promptSnippet?: string;
}

interface MockExtensionAPI {
  registerTool: (def: ToolDefinition) => void;
  getAllTools: () => ToolDefinition[];
  registerShortcut: (...args: unknown[]) => void;
  registerCommand: (...args: unknown[]) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  ctx: object;
}

function createMockAPI(): MockExtensionAPI & { tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = [];
  return {
    tools,
    registerTool: (def: ToolDefinition) => {
      tools.push(def);
    },
    getAllTools: () => tools,
    registerShortcut: () => {},
    registerCommand: () => {},
    on: () => {},
    ctx: {},
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("extension factory registers web_search, fetch_content, get_search_content", async () => {
  const api = createMockAPI();

  // Load and invoke the extension factory
  const ext = await import("../index.ts");
  const factory = ext.default || ext.extension;
  expect(factory).toBeDefined();
  expect(typeof factory).toBe("function");

  factory(api);

  // Check registered tool names
  const names = api.tools.map((t) => t.name);
  expect(names).toContain("web_search");
  expect(names).toContain("fetch_content");
  expect(names).toContain("get_search_content");
  expect(api.tools.length).toBeGreaterThanOrEqual(3);
});

test("each tool has the required shape", async () => {
  const api = createMockAPI();

  const ext = await import("../index.ts");
  const factory = ext.default || ext.extension;
  factory(api);

  for (const tool of api.tools) {
    expect(tool.name).toBeDefined();
    expect(typeof tool.name).toBe("string");
    expect(tool.name.length).toBeGreaterThan(0);

    expect(tool.description).toBeDefined();
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);

    expect(tool.parameters).toBeDefined();
    expect(typeof tool.parameters).toBe("object");

    expect(tool.execute).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  }
});

test("web_search has expected parameters", async () => {
  const api = createMockAPI();

  const ext = await import("../index.ts");
  const factory = ext.default || ext.extension;
  factory(api);

  const ws = api.tools.find((t) => t.name === "web_search");
  expect(ws).toBeDefined();

  // Check key parameter fields
  const params = ws!.parameters as Record<string, unknown>;
  expect(params).toHaveProperty("type", "object");
  expect(params).toHaveProperty("properties");

  const props = params["properties"] as Record<string, unknown>;
  expect(props).toHaveProperty("query");
  expect(props).toHaveProperty("queries");
  expect(props).toHaveProperty("provider");
  expect(props).toHaveProperty("numResults");
});

test("fetch_content has expected parameters", async () => {
  const api = createMockAPI();

  const ext = await import("../index.ts");
  const factory = ext.default || ext.extension;
  factory(api);

  const fc = api.tools.find((t) => t.name === "fetch_content");
  expect(fc).toBeDefined();

  const params = fc!.parameters as Record<string, unknown>;
  expect(params).toHaveProperty("type", "object");
  expect(params).toHaveProperty("properties");

  const props = params["properties"] as Record<string, unknown>;
  expect(props).toHaveProperty("url");
  expect(props).toHaveProperty("urls");
});

test("get_search_content has expected parameters", async () => {
  const api = createMockAPI();

  const ext = await import("../index.ts");
  const factory = ext.default || ext.extension;
  factory(api);

  const gsc = api.tools.find((t) => t.name === "get_search_content");
  expect(gsc).toBeDefined();

  const params = gsc!.parameters as Record<string, unknown>;
  expect(params).toHaveProperty("type", "object");
  expect(params).toHaveProperty("properties");
});

test("skills directory exists with expected content", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const skillsDir = path.join(import.meta.dir, "..", "skills");
  expect(fs.existsSync(skillsDir)).toBe(true);

  const entries = fs.readdirSync(skillsDir);
  expect(entries.length).toBeGreaterThan(0);
});
