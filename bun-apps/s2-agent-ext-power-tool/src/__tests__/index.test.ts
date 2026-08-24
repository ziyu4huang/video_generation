/**
 * Tests for s2-agent-ext-power-tool.
 *
 * Strategy: drive the extension factory with a mock ExtensionAPI that captures
 * registerTool() calls, then invoke each tool's execute() directly with a mock
 * ExtensionContext that provides the system prompt options via
 * getSystemPromptOptions().
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

// ─── Mock ExtensionAPI ───────────────────────────────────────────────────────

function loadExtension(tools: ToolInfoStub[]) {
  const captured: Record<string, CapturedTool> = {};

  const mockPi: any = {
    registerTool: (def: any) => {
      captured[def.name] = {
        name: def.name,
        label: def.label,
        description: def.description,
        execute: def.execute,
      };
    },
    on: (_event: string, _handler: any) => {
      // lifecycle event handlers (session_start, tool_execution_end, etc.)
      // are accepted without capture — exercised by real e2e tests
    },
    registerCommand: (_name: string, _def: any) => {
      // BTW commands and other slash commands — no-op in unit tests
    },
    registerShortcut: (_shortcut: string, _def: any) => {
      // Keyboard shortcuts — no-op in unit tests
    },
    registerMessageRenderer: (_type: string, _renderer: any) => {
      // Message renderer — no-op in unit tests
    },
    sendMessage: (_msg: any, _opts?: any) => {
      // Message sending — no-op in unit tests
    },
    sendUserMessage: (_content: any, _opts?: any) => {
      // User message sending — no-op in unit tests
    },
    appendEntry: (_customType: string, _data?: unknown) => {
      // Session entry appending — no-op in unit tests
    },
    getThinkingLevel: () => "off",
    getAllTools: () => tools,
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {} },
    ui: {},
  };

  extension(mockPi);

  return { captured };
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
  // Non-optional on the real ExtensionContext; the inspect_pathology tool keys
  // its accumulator read by session id (optimization #3 / ticket #16).
  sessionManager: { getSessionId: () => "test-session" },
  getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
  getSystemPrompt: () => "x".repeat(1000),
  getSystemPromptOptions: () => buildSnapshotOpts(),
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
  test("registers all 6 inspect_* tools plus browser", () => {
    const { captured } = loadExtension([]);
    // ask_user_question -> s2-agent-ext-ask-user (A2, merged into
    // s2-agent-ext-task 2026-07-18); goal+todo -> s2-agent-ext-task
    // (A3); knowledge_query + graph_health -> knowledge-graph hub.
    // power-tool is now self-contained diagnostics: inspect_* only, plus
    // inspect_pathology (F v1) for failure-pattern detection, plus
    // inspect_tui for above-editor widget debugging, plus the gated browser
    // tool (power_browser gate) for on-demand headless-Chrome browsing.
    // The gated `webui` audit tool moved to s2-agent-ext-webui (user
    // directive 2026-08-25) — it audits that package's server.
    expect(Object.keys(captured).sort()).toEqual([
      "browser",
      "inspect_agent",
      "inspect_context",
      "inspect_extensions",
      "inspect_hooks",
      "inspect_pathology",
      "inspect_tui",
    ]);
  });

  test("each registered tool has label, description, and execute fn", () => {
    const { captured } = loadExtension([]);
    expect(Object.keys(captured).length).toBe(7);
    for (const name of Object.keys(captured)) {
      expect(typeof captured[name].label).toBe("string");
      expect(captured[name].label.length).toBeGreaterThan(0);
      expect(typeof captured[name].description).toBe("string");
      expect(typeof captured[name].execute).toBe("function");
    }
  });
});

describe("inspect_context", () => {
  test("reports tool breakdown from ctx API", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_context.execute(
      undefined,
      {},
      undefined,
      undefined,
      BASE_CTX,
    );
    const text = res.content[0].text;
    expect(text).toContain("Live context window");
    expect(text).toContain("Token budget");
    expect(text).toContain("System prompt text");
    expect(text).toContain("API tools schema");
    expect(text).toContain("read");
    expect(text).toContain("bash");
    expect(text).toContain("Context files");
    expect(text).toContain("CLAUDE.md");
    // No snapshot message — ctx.getSystemPromptOptions() is always available
    expect(text).not.toContain("No before_agent_start snapshot");
  });
});

describe("inspect_agent", () => {
  test("return_content=true returns valid parseable YAML", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_agent.execute(
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
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_agent.execute(
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
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_agent.execute(
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
      const res = await captured.inspect_agent.execute(
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
    const res = await captured.inspect_agent.execute(
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
      const res = await captured.inspect_agent.execute(
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
      const res = await captured.inspect_agent.execute(
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
      await captured.inspect_agent.execute(
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
    const { captured } = loadExtension(TOOLS);
    const ctx = { ...BASE_CTX, getContextUsage: () => undefined };
    const res = await captured.inspect_agent.execute(
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

describe("inspect_pathology", () => {
  test("empty accumulator + low context → healthy report", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_pathology.execute(
      undefined,
      {},
      undefined,
      undefined,
      BASE_CTX,
    );
    const text = res.content[0].text;
    expect(text).toContain("Inspect Pathology");
    expect(text).toContain("0 patholog");
    expect(text).toContain("No pathologies detected");
  });

  test("return_json returns {findings}", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_pathology.execute(
      undefined,
      { return_json: true },
      undefined,
      undefined,
      BASE_CTX,
    );
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed.findings)).toBe(true);
    // info session-stats is always present
    expect(parsed.findings.some((f: any) => f.check === "session-stats")).toBe(true);
  });

  test("self_test returns deterministic mock output", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_pathology.execute(
      undefined,
      { self_test: true },
      undefined,
      undefined,
      BASE_CTX,
    );
    expect(res.content[0].text).toContain("inspect_pathology");
    expect(res.content[0].text).toContain("self_test: true");
  });
});

// ─── inspect_extensions (pure checks) ────────────────────────────────────────

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

function mapTool(t: any, snippets: Record<string, string>) {
  return {
    name: t.name,
    description: t.description ?? "",
    parameters: t.parameters,
    promptGuidelines: t.promptGuidelines,
    sourcePath: t.sourceInfo?.path ?? "(unknown)",
    source: t.sourceInfo?.source ?? "unknown",
    snippet: snippets[t.name],
  };
}

function analyzeWith(
  tools: any[],
  opts: { snippets?: Record<string, string>; skills?: any[]; contextFiles?: any[]; inactiveTools?: any[]; thresholds?: Partial<Pick<AnalysisInput, "toolTokenThreshold" | "skillCharThreshold" | "contextFileCharThreshold">> } = {},
) {
  const snippets = (opts.snippets ?? SNIPPETS()) as Record<string, string>;
  const input: AnalysisInput = {
    tools: tools.map((t) => mapTool(t, snippets)),
    inactiveTools: (opts.inactiveTools ?? []).map((t) => mapTool(t, snippets)),
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

  test("missing snippet → info (stealth is valid by design; not actionable)", () => {
    const f = analyzeWith(HEALTHY_TOOLS, { snippets: {} }).filter((x) => x.check === "missing-snippet");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("info"); // not counted in summary.total
    // it must NOT inflate the actionable issue count vs the snippet-present baseline
    const forced = analyzeWith(HEALTHY_TOOLS, { snippets: {} });
    const baseline = analyzeWith(HEALTHY_TOOLS);
    expect(summarizeFindings(forced).total).toBe(summarizeFindings(baseline).total);
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

describe("analyzeExtensions — lazy-loaded extensions", () => {
  test("inactiveTools surface as lazy-loaded-extension findings grouped by source", () => {
    const active = [
      { name: "a", description: "d", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "active.ts" } },
    ];
    const inactive = [
      { name: "flux2", description: "dd", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "bun-apps/s2-agent-ext-flux2/extensions/flux2.ts" } },
      { name: "flux2_help", description: "dd", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "bun-apps/s2-agent-ext-flux2/extensions/flux2.ts" } },
      { name: "ltx", description: "dd", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "bun-apps/s2-agent-ext-ltx/extensions/ltx.ts" } },
    ];
    const findings = analyzeWith(active, { inactiveTools: inactive });
    const lazy = findings.filter((x) => x.check === "lazy-loaded-extension");
    // grouped by source: flux2 (2 tools), ltx (1 tool)
    expect(lazy).toHaveLength(2);
    const flux2 = lazy.find((x) => (x.detail as any).path.includes("flux2"));
    expect(flux2).toBeDefined();
    expect((flux2!.detail as any).count).toBe(2);
    expect((flux2!.detail as any).tools).toEqual(["flux2", "flux2_help"]);
    expect((flux2!.detail as any).tokens).toBeGreaterThan(0);
    // severity is info — not actionable
    for (const x of lazy) expect(x.severity).toBe("info");
  });

  test("inactive builtin tools are skipped (same rule as active tax)", () => {
    const inactive = [
      { name: "ls", description: "d", parameters: {}, promptGuidelines: [], sourceInfo: { source: "builtin", scope: "user", origin: "top-level", path: "<builtin:ls>" } },
    ];
    const findings = analyzeWith([], { inactiveTools: inactive });
    expect(findings.filter((x) => x.check === "lazy-loaded-extension")).toHaveLength(0);
    expect(findings.filter((x) => x.check === "total-lazy-tax")).toHaveLength(0);
  });

  test("total-lazy-tax finding is emitted only when lazy tools exist", () => {
    // no inactive tools → no total-lazy-tax
    expect(analyzeWith(HEALTHY_TOOLS).filter((x) => x.check === "total-lazy-tax")).toHaveLength(0);
    // with inactive tools → total-lazy-tax present and sums all sources
    const inactive = [
      { name: "x", description: "dd", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "extA.ts" } },
      { name: "y", description: "dd", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "extB.ts" } },
    ];
    const tot = analyzeWith(HEALTHY_TOOLS, { inactiveTools: inactive }).find((x) => x.check === "total-lazy-tax");
    expect(tot).toBeDefined();
    expect((tot!.detail as any).sources).toBe(2);
    expect((tot!.detail as any).total).toBeGreaterThan(0);
  });

  test("lazy findings do NOT inflate the actionable issue count", () => {
    const inactive = [
      { name: "x", description: "dd", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "extA.ts" } },
    ];
    const withLazy = analyzeWith(HEALTHY_TOOLS, { inactiveTools: inactive });
    const withoutLazy = analyzeWith(HEALTHY_TOOLS);
    expect(summarizeFindings(withLazy).total).toBe(summarizeFindings(withoutLazy).total);
  });

  test("formatExtensionReport renders a lazy-loaded section", () => {
    const inactive = [
      { name: "flux2", description: "dd", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "bun-apps/s2-agent-ext-flux2/extensions/flux2.ts" } },
    ];
    const text = formatExtensionReport(analyzeWith(HEALTHY_TOOLS, { inactiveTools: inactive }));
    expect(text).toContain("Lazy-loaded extensions");
    expect(text).toContain("flux2");
    expect(text).toContain("tok/req if activated");
  });
});

describe("formatExtensionReport", () => {
  test("clean report shows the healthy line + tax table", () => {
    const text = formatExtensionReport(analyzeWith(HEALTHY_TOOLS));
    expect(text).toContain("Inspect Extensions");
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

describe("inspect_extensions (tool end-to-end)", () => {
  test("text report from ctx API", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_extensions.execute(undefined, {}, undefined, undefined, BASE_CTX);
    const text = res.content[0].text;
    expect(text).toContain("Inspect Extensions");
    expect(text).toContain("issue(s)");
    expect(text).toContain("Extension token tax");
    // No snapshot message — ctx.getSystemPromptOptions() is always available
    expect(text).not.toContain("No before_agent_start snapshot");
  });

  test("return_json returns parseable {findings, summary, total_extension_tokens}", async () => {
    const { captured } = loadExtension(TOOLS);
    const res = await captured.inspect_extensions.execute(
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
    const { captured } = loadExtension(TOOLS);
    // Tiny context-file threshold so CLAUDE.md (100 chars in fixture) trips it.
    const res = await captured.inspect_extensions.execute(
      undefined,
      { return_json: true, context_file_char_threshold: 10 },
      undefined,
      undefined,
      BASE_CTX,
    );
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.findings.some((f: any) => f.check === "oversized-context-file")).toBe(true);
  });

  test("registered-but-not-selected tools surface as lazy-loaded (end-to-end)", async () => {
    // getAllTools returns read+bash+flux2+ltx, but selectedTools = [read, bash]
    // → flux2 & ltx are registered-but-inactive (the lazy-loading case).
    const allTools = [
      ...TOOLS,
      {
        name: "flux2",
        description: "Generate images with Flux2.",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
        promptGuidelines: [],
        sourceInfo: { source: "cli", scope: "user", origin: "top-level", path: "bun-apps/s2-agent-ext-flux2/extensions/flux2.ts" },
      },
      {
        name: "ltx",
        description: "Generate video with LTX.",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
        promptGuidelines: [],
        sourceInfo: { source: "cli", scope: "user", origin: "top-level", path: "bun-apps/s2-agent-ext-ltx/extensions/ltx.ts" },
      },
    ];
    const { captured } = loadExtension(allTools);
    const ctx = {
      ...BASE_CTX,
      getSystemPromptOptions: () =>
        buildSnapshotOpts({ selectedTools: ["read", "bash"], toolSnippets: { read: "r", bash: "b" } }),
    };

    // JSON path: lazy findings + total_lazy_tokens present
    const res = await captured.inspect_extensions.execute(undefined, { return_json: true }, undefined, undefined, ctx);
    const parsed = JSON.parse(res.content[0].text);
    const lazy = parsed.findings.filter((f: any) => f.check === "lazy-loaded-extension");
    expect(lazy.length).toBe(2); // flux2 + ltx, grouped by source
    expect(parsed.findings.some((f: any) => f.check === "total-lazy-tax")).toBe(true);
    expect(typeof parsed.total_lazy_tokens).toBe("number");
    expect(parsed.total_lazy_tokens).toBeGreaterThan(0);
    // active tax must NOT include the lazy tools
    const activeTax = parsed.findings.filter((f: any) => f.check === "extension-token-tax");
    expect(activeTax.every((f: any) => !f.detail.path.includes("flux2") && !f.detail.path.includes("ltx"))).toBe(true);

    // Text path: lazy section rendered
    const textRes = await captured.inspect_extensions.execute(undefined, {}, undefined, undefined, ctx);
    const text = textRes.content[0].text;
    expect(text).toContain("Lazy-loaded extensions");
    expect(text).toContain("flux2");
    expect(text).toContain("ltx");
    expect(text).toContain("tok/req if activated");
  });

  test("when selectedTools is unset, every registered tool is active (no lazy)", async () => {
    const { captured } = loadExtension(TOOLS);
    const ctx = {
      ...BASE_CTX,
      getSystemPromptOptions: () => buildSnapshotOpts({ selectedTools: undefined }),
    };
    const res = await captured.inspect_extensions.execute(undefined, { return_json: true }, undefined, undefined, ctx);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.findings.filter((f: any) => f.check === "lazy-loaded-extension")).toHaveLength(0);
    expect(parsed.total_lazy_tokens).toBe(0);
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
// silently degrade to "all tools allowed" (s2-agent-ext-ultracode' parser returns
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
    expect(tools).toContain("inspect_extensions");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("edit");
  });
});

describe("inspect_tui", () => {
  const BASE_CTX: Record<string, unknown> = {
    cwd: "/tmp/test",
    mode: "cli",
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getContextUsage: () => null,
  };

  test("self_test returns deterministic mock", async () => {
    const { captured } = loadExtension([]);
    const res = await captured.inspect_tui.execute(undefined, { self_test: true }, undefined, undefined, BASE_CTX);
    expect(res.content[0].text).toContain("self_test: true");
    expect(res.content[0].text).toContain("Inspect TUI");
  });

  test("reports NOT FOUND when globalThis has no widget singleton", async () => {
    const g = globalThis as Record<string, unknown>;
    const orig = g.__piCoreTaskStatusWidget;
    delete g.__piCoreTaskStatusWidget;
    try {
      const { captured } = loadExtension([]);
      const res = await captured.inspect_tui.execute(undefined, {}, undefined, undefined, BASE_CTX);
      expect(res.content[0].text).toContain("NOT FOUND");
      expect(res.content[0].text).toContain("s2-agent-ext-task");
    } finally {
      if (orig !== undefined) g.__piCoreTaskStatusWidget = orig;
    }
  });

  test("formats widget snapshot when singleton has inspect()", async () => {
    const g = globalThis as Record<string, unknown>;
    const orig = g.__piCoreTaskStatusWidget;
    g.__piCoreTaskStatusWidget = {
      inspect: () => ({
        widgetKey: "pi-core-task",
        registered: true,
        sections: [
          { id: "goal", order: 0 },
          {
            id: "todo", order: 1,
            detail: {
              totalTasks: 9,
              visibleTasks: 2,
              hiddenCompletedTaskIds: [3, 4, 5, 6, 7, 8, 9],
              pendingHideIds: [],
              fullTaskList: [
                { id: 1, subject: "Task A", status: "pending" },
                { id: 2, subject: "Task B", status: "pending" },
                { id: 3, subject: "Task C", status: "completed" },
              ],
            },
          },
        ],
        renderedLines: ["● Todos (7/9)", "├─ ○ #1 Task A", "├─ ○ #2 Task B"],
      }),
    };
    try {
      const { captured } = loadExtension([]);
      const res = await captured.inspect_tui.execute(undefined, {}, undefined, undefined, BASE_CTX);
      const text = res.content[0].text;
      expect(text).toContain("pi-core-task");
      expect(text).toContain("registered: true");
      expect(text).toContain("[0] goal");
      expect(text).toContain("[1] todo (inspectable)");
      expect(text).toContain("Todos (7/9)");
      expect(text).toContain("total: 9 (2 pending, 0 in-progress, 1 completed)");
      expect(text).toContain("hidden completed: #3, #4, #5, #6, #7, #8, #9");
      expect(text).toContain("(hidden)");
    } finally {
      if (orig !== undefined) g.__piCoreTaskStatusWidget = orig;
      else delete g.__piCoreTaskStatusWidget;
    }
  });

  test("return_json returns machine-readable snapshot", async () => {
    const g = globalThis as Record<string, unknown>;
    const orig = g.__piCoreTaskStatusWidget;
    g.__piCoreTaskStatusWidget = {
      inspect: () => ({
        widgetKey: "pi-core-task",
        registered: false,
        sections: [],
        renderedLines: [],
      }),
    };
    try {
      const { captured } = loadExtension([]);
      const res = await captured.inspect_tui.execute(undefined, { return_json: true }, undefined, undefined, BASE_CTX);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.widget.widgetKey).toBe("pi-core-task");
      expect(parsed.widget.registered).toBe(false);
      expect(parsed.seams).toBeDefined();
    } finally {
      if (orig !== undefined) g.__piCoreTaskStatusWidget = orig;
      else delete g.__piCoreTaskStatusWidget;
    }
  });
});
