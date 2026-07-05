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
import { defineTool, formatSkillsForPrompt, parseFrontmatter, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import extension, {
  analyzeExtensions,
  formatExtensionReport,
  summarizeFindings,
  __resetSnapshotForTests,
  type AnalysisInput,
} from "../index.ts";

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

  const beforeAgentStartHandlers: Array<(event: BeforeAgentStartEvent, ctx?: Record<string, unknown>) => void> = [];

  const mockPi: any = {
    registerTool: (def: any) => {
      captured[def.name] = {
        name: def.name,
        label: def.label,
        description: def.description,
        execute: def.execute,
      };
    },
    registerCommand: (_name: string, _def: any) => {
      // no-op mock — slash commands are exercised by real e2e tests
    },
    on: (event: string, handler: any) => {
      if (event === "before_agent_start") {
        beforeAgentStartHandlers.push(handler);
      }
      // lifecycle event handlers (session_start, tool_execution_end, etc.)
      // are accepted without capture — exercised by real e2e tests
    },
    getAllTools: () => tools,
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {} },
    ui: {},
  };

  extension(mockPi);

  return {
    captured,
    fireBeforeAgentStart: (event: BeforeAgentStartEvent, mockCtx?: Record<string, unknown>) => {
      if (beforeAgentStartHandlers.length === 0) throw new Error("before_agent_start handlers not registered");
      for (const handler of beforeAgentStartHandlers) {
        handler(event, mockCtx ?? { hasUI: true });
      }
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
  test("registers all 8 tools (including goal_complete, ask_user_question, knowledge_query, graph_health, and todo)", () => {
    const { captured } = loadExtension([]);
    expect(Object.keys(captured).sort()).toEqual([
      "agent_inventory",
      "ask_user_question",
      "context_analyzer",
      "extension_analyzer",
      "goal_complete",
      "graph_health",
      "knowledge_query",
      "todo",
    ]);
  });

  test("each registered tool has label, description, and execute fn", () => {
    const { captured } = loadExtension([]);
    expect(Object.keys(captured).length).toBe(8);
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

// ─── extension_analyzer (pure checks) ────────────────────────────────────────

const HEALTHY_TOOLS = [
  {
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: ["Use `read` to inspect files."],
    sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "bun-apps/x/read.ts" },
  },
];
const SNIPPETS = (extra: Record<string, string> = {}) => ({ read: "Read a file", ...extra });

function analyzeWith(
  tools: any[],
  opts: { snippets?: Record<string, string>; skills?: any[]; contextFiles?: any[]; thresholds?: Partial<Pick<AnalysisInput, "toolTokenThreshold" | "skillCharThreshold" | "contextFileCharThreshold">> } = {},
) {
  const input: AnalysisInput = {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters,
      promptGuidelines: t.promptGuidelines,
      sourcePath: t.sourceInfo?.path ?? "(unknown)",
      source: t.sourceInfo?.source ?? "unknown",
      snippet: ((opts.snippets ?? SNIPPETS()) as Record<string, string>)[t.name],
    })),
    skills: (opts.skills ?? []).map((s: any) => ({
      name: s.name,
      filePath: s.filePath ?? "",
      formattedChars: s.formattedChars ?? 100,
    })),
    contextFiles: (opts.contextFiles ?? []).map((f: any) => ({ path: f.path, chars: f.chars })),
    toolTokenThreshold: opts.thresholds?.toolTokenThreshold ?? 1200,
    skillCharThreshold: opts.thresholds?.skillCharThreshold ?? 2000,
    contextFileCharThreshold: opts.thresholds?.contextFileCharThreshold ?? 20000,
  };
  return analyzeExtensions(input);
}

describe("analyzeExtensions — checks", () => {
  test("duplicate tool name from distinct sources → high", () => {
    const tools = [
      { name: "dup", description: "a", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "a.ts" } },
      { name: "dup", description: "b", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "b.ts" } },
    ];
    const f = analyzeWith(tools).filter((x) => x.check === "duplicate-tool-name");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect((f[0].detail as any).sources).toEqual(["a.ts", "b.ts"]);
  });

  test("same source path twice is NOT a duplicate-name conflict", () => {
    const tools = [
      { name: "dup", description: "a", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "a.ts" } },
      { name: "dup", description: "b", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "a.ts" } },
    ];
    expect(analyzeWith(tools).filter((x) => x.check === "duplicate-tool-name")).toHaveLength(0);
  });

  test("empty/missing description → high", () => {
    const tools = [
      { name: "blank", description: "   ", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "x.ts" } },
      { name: "none", description: "", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "x.ts" } },
    ];
    const f = analyzeWith(tools).filter((x) => x.check === "missing-description");
    expect(f).toHaveLength(2);
    for (const x of f) expect(x.severity).toBe("high");
  });

  test("missing snippet → medium", () => {
    const f = analyzeWith(HEALTHY_TOOLS, { snippets: {} }).filter((x) => x.check === "missing-snippet");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
  });

  test("oversized tool schema → medium (respects threshold)", () => {
    const big = { name: "big", description: "d".repeat(5000), parameters: { type: "object", properties: { a: { type: "string", description: "z".repeat(3000) } } }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "big.ts" } };
    expect(analyzeWith([big]).filter((x) => x.check === "oversized-tool-schema")).toHaveLength(1);
    // raising the threshold above its size clears it
    expect(analyzeWith([big], { thresholds: { toolTokenThreshold: 99999 } }).filter((x) => x.check === "oversized-tool-schema")).toHaveLength(0);
  });

  test("oversized skill / context-file → medium (respective thresholds)", () => {
    const f = analyzeWith(HEALTHY_TOOLS, {
      skills: [{ name: "huge", filePath: "s.md", formattedChars: 5000 }],
      contextFiles: [{ path: "CLAUDE.md", chars: 30000 }],
    });
    expect(f.filter((x) => x.check === "oversized-skill")).toHaveLength(1);
    expect(f.filter((x) => x.check === "oversized-context-file")).toHaveLength(1);
  });

  test("stale backticked guideline reference → low", () => {
    const tools = [{
      name: "t", description: "d", parameters: {}, snippet: "s",
      promptGuidelines: ["Use `t` for things, and `ghost_tool` for the rest."],
      sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "x.ts" },
    }];
    const f = analyzeWith(tools).filter((x) => x.check === "stale-guideline-ref");
    expect(f).toHaveLength(1);
    expect((f[0].detail as any).ref).toBe("ghost_tool");
  });

  test("no-guidelines is informational (info, not actionable) and skipped for builtin", () => {
    const tools = [
      { name: "b", description: "d", parameters: {}, promptGuidelines: [], sourceInfo: { source: "builtin", scope: "user", origin: "top-level", path: "<builtin:b>" } },
      { name: "e", description: "d", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "e.ts" } },
    ];
    const f = analyzeWith(tools, { snippets: { b: "s", e: "s" } }).filter((x) => x.check === "no-guidelines");
    expect(f).toHaveLength(1);
    expect((f[0].detail as any).name).toBe("e");
    expect(f[0].severity).toBe("info"); // not counted in summary.total
    // it must NOT inflate the actionable issue count
    const withE = analyzeWith(tools, { snippets: { b: "s", e: "s" } });
    const onlyE = analyzeWith([tools[1]], { snippets: { e: "s" } });
    expect(summarizeFindings(withE).total).toBe(summarizeFindings(onlyE).total);
  });

  test("healthy config → zero actionable findings", () => {
    const f = analyzeWith(HEALTHY_TOOLS);
    expect(summarizeFindings(f).total).toBe(0);
    expect(f.some((x) => x.check === "total-extension-tax")).toBe(true); // info still present
  });

  test("extension token tax groups non-builtin tools by source + sums tokens", () => {
    const tools = [
      { name: "a", description: "d", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "ext1.ts" } },
      { name: "b", description: "d", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "ext1.ts" } },
      { name: "c", description: "d", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "builtin", scope: "user", origin: "top-level", path: "<builtin:c>" } },
    ];
    const tax = analyzeWith(tools, { snippets: { a: "s", b: "s", c: "s" } }).filter((x) => x.check === "extension-token-tax");
    // grouped: ext1.ts (a+b), builtin c excluded
    expect(tax).toHaveLength(1);
    expect((tax[0].detail as any).path).toBe("ext1.ts");
    expect((tax[0].detail as any).tools).toBe(2);
  });
});

describe("formatExtensionReport", () => {
  test("clean report shows the healthy line + tax table", () => {
    const text = formatExtensionReport(analyzeWith(HEALTHY_TOOLS));
    expect(text).toContain("Extension Analyzer");
    expect(text).toContain("0 issue(s)");
    expect(text).toContain("No actionable issues");
    expect(text).toContain("Extension token tax");
  });

  test("findings are rendered under their severity section", () => {
    const text = formatExtensionReport(
      analyzeWith([
        { name: "blank", description: "", parameters: {}, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "x.ts" } },
      ]),
    );
    expect(text).toContain("High");
    expect(text).toContain('Tool "blank" has no description');
  });
});

describe("extension_analyzer (tool end-to-end)", () => {
  test("graceful message when no snapshot yet", async () => {
    __resetSnapshotForTests();
    const { captured } = loadExtension(TOOLS);
    const res = await captured.extension_analyzer.execute(undefined, {}, undefined, undefined, BASE_CTX);
    expect(res.content[0].text).toContain("No before_agent_start snapshot");
  });

  test("text report after snapshot", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(500),
      systemPromptOptions: buildSnapshotOpts(),
    });
    const res = await captured.extension_analyzer.execute(undefined, {}, undefined, undefined, BASE_CTX);
    const text = res.content[0].text;
    expect(text).toContain("Extension Analyzer");
    expect(text).toContain("issue(s)");
    expect(text).toContain("Extension token tax");
  });

  test("return_json returns parseable {findings, summary, total_extension_tokens}", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(500),
      systemPromptOptions: buildSnapshotOpts(),
    });
    const res = await captured.extension_analyzer.execute(
      undefined,
      { return_json: true },
      undefined,
      undefined,
      BASE_CTX,
    );
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.summary).toBeDefined();
    expect(typeof parsed.total_extension_tokens).toBe("number");
  });

  test("custom thresholds flow through params into the analysis", async () => {
    const { captured, fireBeforeAgentStart } = loadExtension(TOOLS);
    fireBeforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "x".repeat(500),
      systemPromptOptions: buildSnapshotOpts(),
    });
    // Tiny context-file threshold so CLAUDE.md (100 chars in fixture) trips it.
    const res = await captured.extension_analyzer.execute(
      undefined,
      { return_json: true, context_file_char_threshold: 10 },
      undefined,
      undefined,
      BASE_CTX,
    );
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.findings.some((f: any) => f.check === "oversized-context-file")).toBe(true);
  });
});

// ─── real-SDK contract (catch shape drift without spawning a CLI) ────────────
// These tests import the REAL pi-coding-agent helpers/types (no mock) so that
// if the SDK renames defineTool / formatSkillsForPrompt / ExtensionFactory or
// shifts the ToolInfo shape the analyzer depends on, this fails fast in
// `bun test` — no `-p` CLI subprocess or LLM turn required.

describe("real-SDK contract", () => {
  test("the extension satisfies the SDK's ExtensionFactory type", () => {
    // Compile-time: `extension` must be assignable to ExtensionFactory.
    // Runtime: it's a function taking the ExtensionAPI.
    const fn: ExtensionFactory = extension;
    expect(typeof fn).toBe("function");
  });

  test("a tool built with the real defineTool produces the shape analyzeExtensions expects", () => {
    const t = defineTool({
      name: "probe",
      label: "Probe",
      description: "A probe tool.",
      promptSnippet: "probe snippet",
      promptGuidelines: ["Use `probe` for probes."],
      parameters: Type.Object({ x: Type.Optional(Type.String()) }),
      async execute() {
        return { content: [], details: null };
      },
    });
    // ToolInfo (per SDK) = Pick<ToolDefinition, name|description|parameters|promptGuidelines> & { sourceInfo }.
    // Build exactly that shape and feed the analyzer — a well-specified tool must come out clean.
    const toolInfo = {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      promptGuidelines: t.promptGuidelines,
      sourceInfo: { source: "extension", scope: "user" as const, origin: "top-level" as const, path: "probe.ts" },
    };
    const findings = analyzeWith([toolInfo], { snippets: { probe: "probe snippet" } });
    expect(summarizeFindings(findings).total).toBe(0); // healthy: desc + snippet + guideline present
  });

  test("the real formatSkillsForPrompt (used to size skills) is callable and returns a string", () => {
    const formatted = formatSkillsForPrompt([
      {
        name: "probe-skill",
        description: "A probe skill.",
        filePath: "/probe/SKILL.md",
        baseDir: "/probe",
        disableModelInvocation: false,
        sourceInfo: { source: "file", scope: "user", origin: "top-level", path: "/probe/SKILL.md" },
      },
    ]);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });
});

// ─── extension-auditor subagent definition ───────────────────────────────────
// The .pi/agents/extension-auditor.md is the judgment layer over this tool's
// findings. Guard its frontmatter shape so a malformed tools field doesn't
// silently degrade to "all tools allowed" (pi-dynamic-workflows' parser returns
// tools=undefined for comma-strings — must use YAML list syntax). We parse via
// the SDK's parseFrontmatter (the same primitive parseAgentDefinition uses).

describe("extension-auditor subagent definition", () => {
  // Resolve from this test file (src/__tests__/) → ../../.pi/agents/ = the package's .pi/agents/.
  const agentPath = join(import.meta.dir, "..", "..", ".pi", "agents", "extension-auditor.md");
  function parsed() {
    return parseFrontmatter(readFileSync(agentPath, "utf8"));
  }

  test("frontmatter has the expected name + a non-empty description + real body", () => {
    const { frontmatter, body } = parsed();
    expect(frontmatter.name).toBe("extension-auditor");
    expect(String(frontmatter.description).length).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(500); // real role guidance, not empty
  });

  test("tools allowlist is a YAML LIST (enforces read-only; comma-strings would parse to undefined = all tools)", () => {
    const { frontmatter } = parsed();
    expect(Array.isArray(frontmatter.tools)).toBe(true);
    const tools = frontmatter.tools as unknown[];
    expect(tools.length).toBeGreaterThan(0);
    // read-only: analyzers + inspection tools, never write/edit
    expect(tools).toContain("extension_analyzer");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("edit");
  });
});
