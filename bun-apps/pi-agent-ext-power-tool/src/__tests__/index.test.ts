/**
 * Tests for pi-agent-ext-power-tool.
 *
 * Strategy: drive the extension factory with a mock ExtensionAPI that captures
 * both registerTool() calls and the before_agent_start event handler. We then
 * fire the captured handler with a synthetic event to populate the module-level
 * snapshot, and invoke each tool's execute() directly.
 *
 * This mirrors the pattern in pi-knowledge-card/__tests__/pi-knowledge-card.test.ts.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as yaml from "js-yaml";
import extension from "../index.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

type ExecuteFn = (
  id: unknown,
  params: Record<string, unknown>,
  signal: unknown,
  onUpdate: unknown,
  ctx: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  execute: ExecuteFn;
}

interface BeforeAgentStartEvent {
  type: "before_agent_start";
  systemPrompt: string;
  systemPromptOptions: Record<string, unknown>;
}

// ─── Mock ExtensionAPI ───────────────────────────────────────────────────────

function loadExtension(tools: ToolInfoStub[]) {
  const captured: Record<string, CapturedTool> = {};
  let beforeAgentStartHandler:
    | ((event: BeforeAgentStartEvent) => void)
    | null = null;

  const mockPi: any = {
    registerTool: (def: any) => {
      captured[def.name] = {
        name: def.name,
        label: def.label,
        description: def.description,
        execute: def.execute,
      };
    },
    on: (event: string, handler: any) => {
      if (event === "before_agent_start") {
        beforeAgentStartHandler = handler;
      }
    },
    getAllTools: () => tools,
  };

  extension(mockPi);

  return {
    captured,
    fireBeforeAgentStart: (event: BeforeAgentStartEvent) => {
      if (!beforeAgentStartHandler) throw new Error("before_agent_start handler not registered");
      beforeAgentStartHandler(event);
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TOOLS: ToolInfoStub[] = [
  {
    name: "read",
    description: "Read the contents of a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    sourceInfo: {
      source: "builtin",
      scope: "user",
      origin: "top-level",
      path: "<builtin:read>",
    },
  },
  {
    name: "bash",
    description: "Execute a bash command.",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    promptGuidelines: [],
    sourceInfo: {
      source: "builtin",
      scope: "user",
      origin: "top-level",
      path: "<builtin:bash>",
    },
  },
];

function buildSnapshotOpts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    cwd: "/test/proj",
    selectedTools: ["read", "bash"],
    toolSnippets: { read: "Read a file", bash: "Run a shell command" },
    promptGuidelines: ["Be concise in your responses", "Show file paths clearly"],
    contextFiles: [
      { path: "/test/proj/CLAUDE.md", content: "# Project\nSome instructions.".padEnd(100, "x") },
    ],
    skills: [
      {
        name: "find-skills",
        description: "Helps users discover skills.",
        filePath: "/home/user/.agents/skills/find-skills/SKILL.md",
        baseDir: "/home/user/.agents/skills/find-skills",
        disableModelInvocation: false,
        sourceInfo: {
          source: "file",
          scope: "user",
          origin: "top-level",
          path: "/home/user/.agents/skills/find-skills/SKILL.md",
        },
      },
    ],
    ...overrides,
  };
}

const BASE_CTX = {
  cwd: "/test/proj",
  mode: "print",
  hasUI: false,
  isIdle: () => true,
  isProjectTrusted: () => true,
  getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
  model: {
    id: "test-model",
    name: "Test Model",
    provider: "test",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 8192,
    input: ["text"],
  },
};

// Minimal stub matching the ToolInfo shape used by the tools.
interface ToolInfoStub {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  promptGuidelines?: string[];
  sourceInfo: {
    source: string;
    scope: string;
    origin: string;
    path: string;
    baseDir?: string;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("tool registration", () => {
  test("registers exactly context_analyzer and agent_inventory", () => {
    const { captured } = loadExtension([]);
    expect(Object.keys(captured).sort()).toEqual(["agent_inventory", "context_analyzer"]);
  });

  test("each registered tool has label, description, and execute fn", () => {
    const { captured } = loadExtension([]);
    for (const name of Object.keys(captured)) {
      expect(typeof captured[name].label).toBe("string");
      expect(captured[name].label.length).toBeGreaterThan(0);
      expect(typeof captured[name].description).toBe("string");
      expect(typeof captured[name].execute).toBe("function");
    }
  });
});

describe("context_analyzer", () => {
  test("graceful message when no snapshot yet", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.context_analyzer.execute(
      undefined,
      {},
      undefined,
      undefined,
      BASE_CTX,
    );
    const text = res.content[0].text;
    expect(text).toContain("Live context window");
    expect(text).toContain("No before_agent_start snapshot");
  });

  test("reports tool breakdown after snapshot", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(1000),
      systemPromptOptions: buildSnapshotOpts(),
    });
    const res = await captured.context_analyzer.execute(
      undefined,
      {},
      undefined,
      undefined,
      BASE_CTX,
    );
    const text = res.content[0].text;
    expect(text).toContain("Token budget");
    expect(text).toContain("System prompt text");
    expect(text).toContain("API tools schema");
    expect(text).toContain("read");
    expect(text).toContain("bash");
    expect(text).toContain("Context files");
    expect(text).toContain("CLAUDE.md");
  });
});

describe("agent_inventory", () => {
  test("return_content=true returns valid parseable YAML", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(500),
      systemPromptOptions: buildSnapshotOpts(),
    });
    const res = await captured.agent_inventory.execute(
      undefined,
      { return_content: true },
      undefined,
      undefined,
      BASE_CTX,
    );
    const text = res.content[0].text;
    const parsed = yaml.load(text) as Record<string, unknown>;

    expect(parsed.agent).toBeDefined();
    expect((parsed.agent as any).app_name).toBe("pi");
    expect((parsed.agent as any).cwd).toBe("/test/proj");
    expect(parsed.model).toBeDefined();
    expect((parsed.model as any).id).toBe("test-model");
  });

  // ── Regression: the original implementation read nonexistent fields
  //    (sourceInfo.type, skill.path, skill.whenToUse) and silently produced
  //    nulls. These tests pin the correct field names. ──────────────────────
  test("REGRESSION: tool.source is populated, not null", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(500),
      systemPromptOptions: buildSnapshotOpts(),
    });
    const res = await captured.agent_inventory.execute(
      undefined,
      { return_content: true },
      undefined,
      undefined,
      BASE_CTX,
    );
    const parsed = yaml.load(res.content[0].text) as any;
    const readTool = parsed.tools.find((t: any) => t.name === "read");
    expect(readTool.source).not.toBeNull();
    expect(readTool.source.source).toBe("builtin");
    expect(readTool.source.scope).toBe("user");
    expect(readTool.source.path).toBe("<builtin:read>");
  });

  test("REGRESSION: skill.file_path is populated, not null", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(500),
      systemPromptOptions: buildSnapshotOpts(),
    });
    const res = await captured.agent_inventory.execute(
      undefined,
      { return_content: true },
      undefined,
      undefined,
      BASE_CTX,
    );
    const parsed = yaml.load(res.content[0].text) as any;
    const skill = parsed.skills[0];
    expect(skill.file_path).toBe("/home/user/.agents/skills/find-skills/SKILL.md");
    expect(skill.base_dir).toBe("/home/user/.agents/skills/find-skills");
    expect(skill.disable_model_invocation).toBe(false);
    expect(skill.source).not.toBeNull();
  });

  test("writes YAML file to output dir", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-inv-"));
    try {
      const ctx = { ...BASE_CTX, cwd: tmp };
      const { captured } = loadExtension(TOOLS);
      const res = await captured.agent_inventory.execute(
        undefined,
        { output_dir: "out", filename: "state" },
        undefined,
        undefined,
        ctx,
      );
      const text = res.content[0].text;
      expect(text).toContain("Output:");
      const written = readFileSync(join(tmp, "out", "state.yaml"), "utf-8");
      const parsed = yaml.load(written) as any;
      expect(parsed.agent.cwd).toBe(tmp);
      expect(Array.isArray(parsed.tools)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns error message on unwritable path", async () => {
    const ctx = { ...BASE_CTX, cwd: "/nonexistent-root-no-perm/xyz" };
    const { captured } = loadExtension(TOOLS);
    const res = await captured.agent_inventory.execute(
      undefined,
      { output_dir: "deep/nested", filename: "fail" },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content[0].text;
    expect(text).toContain("Error writing inventory");
  });

  test("REGRESSION: output_dir cannot escape cwd via ../ traversal", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-inv-"));
    try {
      const ctx = { ...BASE_CTX, cwd: tmp };
      const { captured } = loadExtension(TOOLS);
      const res = await captured.agent_inventory.execute(
        undefined,
        { output_dir: "../../../../tmp/pi-inv-escape", filename: "state" },
        undefined,
        undefined,
        ctx,
      );
      const text = res.content[0].text;
      expect(text).toContain("Error: output_dir must stay within");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("REGRESSION: filename cannot contain path separators", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-inv-"));
    try {
      const ctx = { ...BASE_CTX, cwd: tmp };
      const { captured } = loadExtension(TOOLS);
      const res = await captured.agent_inventory.execute(
        undefined,
        { filename: "../escape" },
        undefined,
        undefined,
        ctx,
      );
      const text = res.content[0].text;
      expect(text).toContain("Error: filename must not contain path separators");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("REGRESSION: output_dir='' falls back to the default, not the cwd root", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-inv-"));
    try {
      const ctx = { ...BASE_CTX, cwd: tmp };
      const { captured } = loadExtension(TOOLS);
      await captured.agent_inventory.execute(
        undefined,
        { output_dir: "", filename: "state" },
        undefined,
        undefined,
        ctx,
      );
      const written = readFileSync(join(tmp, "output", "pi", "state.yaml"), "utf-8");
      expect((yaml.load(written) as any).agent.cwd).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("REGRESSION: context_usage is emitted as null, not dropped, when unavailable", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(500),
      systemPromptOptions: buildSnapshotOpts(),
    });
    const ctx = { ...BASE_CTX, getContextUsage: () => undefined };
    const res = await captured.agent_inventory.execute(
      undefined,
      { return_content: true },
      undefined,
      undefined,
      ctx,
    );
    const parsed = yaml.load(res.content[0].text) as any;
    expect("context_usage" in parsed).toBe(true);
    expect(parsed.context_usage).toBeNull();
  });
});
