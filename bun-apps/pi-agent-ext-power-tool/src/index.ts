/**
 * pi-agent-ext-power-tool — extension factory.
 *
 * Tools provided:
 *   inspect_context   — full context window breakdown, split by token bucket:
 *     • System prompt text (skills, guidelines, context files, tool snippets)
 *     • API tools schema (description + parameters per tool — a SEPARATE budget)
 *     • Estimated conversation overhead (live total minus the two above)
 *     All tools shown sorted by cost; guidelines shown in full.
 *
 *   inspect_agent     — dump agent state to YAML: extensions, tools, skills, context files, model, cwd.
 *     Outputs to <cwd>/output/pi/inspect-agent-<timestamp>.yaml by default.
 *     Readable by humans and agents for debugging/analysis.
 *
 *   inspect_pathology  — diagnose how the agent is FAILING this session:
 *     retry loops, tool error storms, context saturation. Reads a hook-fed
 *     accumulator of recent tool calls (tool_execution_start/end) + the live
 *     context-window fill. Severity-ranked report or JSON. When a HIGH-severity
 *     loop / consecutive-error is active, a non-invasive status-line warning is
 *     surfaced proactively (Phase 1.1) — no context injection, dedup'd per loop.
 *
 * Usage:
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/src/index.ts -p "call inspect_context"
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/src/index.ts -p "call inspect_agent"
 */
import {
  type BuildSystemPromptOptions,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionAPI,
  type ToolInfo,
  defineTool,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as yaml from "js-yaml";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { ensureGetSystemPromptOptions } from "./sdk-patch.js";
import { DEFAULT_CHARS_PER_TOKEN } from "./schema-cost";
import {
  makeInspectPathologyTool,
  recordCallStart,
  recordCallEnd,
  recordTurnEnd,
  resetAccumulator,
  getCalls,
  surfacePathologyWarning,
  resetWarning,
} from "./pathology/index.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Rough chars→token estimate. Sourced from schema-cost's canonical default so
// the live instrument (inspect_context) and the static instrument (schema-cost /
// inspect_extensions) can NEVER drift apart. Previously this was a hardcoded 3.7
// while schema-cost used 4.0 — a diagnostics tool must agree with itself.
const TOKEN_RATIO = DEFAULT_CHARS_PER_TOKEN;

function est(chars: number): string {
  return `~${Math.round(chars / TOKEN_RATIO).toLocaleString()} tok`;
}

function estTok(chars: number): number {
  return Math.round(chars / TOKEN_RATIO);
}

function bar(percent: number | null, width = 28): string {
  if (percent == null) return "[" + " ".repeat(width) + "] ??%";
  const filled = Math.round((percent / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + `] ${percent.toFixed(1)}%`;
}

function miniBar(fraction: number, width = 12): string {
  const filled = Math.round(Math.min(1, fraction) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Tool definition ──────────────────────────────────────────────────────────

// ─── Self-test deterministic output constants ──────────────────────────────

const SELF_TEST_CONTEXT_ANALYZER_OUTPUT = [
  '"self_test": true',
  'Deterministic mock output — no live session required',
  'inspect_context',
  '▶ Live context window:',
  '  unavailable (no LLM turn completed yet)',
  '▶ Token budget  (where tokens go):',
  'System prompt text',
  'API tools schema',
  '▶ System prompt text',
  'Skills',
  'Context files',
  'Tool snippets',
  'Guidelines',
  '▶ API tools schema',
].join("\n");

const SELF_TEST_AGENT_INVENTORY_OUTPUT = [
  '╔══════════════════════════════════════╗',
  '║        Inspect Agent                ║',
  '╚══════════════════════════════════════╝',
  '',
  'Output: output/pi/inspect-agent-self-test.yaml',
  '',
  'Summary:',
  '  - Tools: 4',
  '  - Skills: 0',
  '  - Context files: 0',
  '  - CWD: /tmp/self-test',
  '  - Model: none (self-test)',
  '',
  'self_test: true',
  'Deterministic mock output — no live session required',
].join("\n");

const SELF_TEST_ANALYSIS_INPUT: AnalysisInput = {
  tools: [
    {
      name: "test_tool_a",
      description: "A test tool with a medium-length description that exercises the analyzer",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      promptGuidelines: ["Use `test_tool_a` for testing purposes"],
      sourcePath: "/tmp/test-extension-a.ts",
      source: "extension",
      snippet: "Test A: short snippet",
    },
    {
      name: "test_tool_b",
      description: "",
      parameters: { type: "object", properties: {} },
      promptGuidelines: [],
      sourcePath: "/tmp/test-extension-b.ts",
      source: "extension",
      snippet: "",
    },
    {
      name: "bash",
      description: "Execute a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      promptGuidelines: [],
      sourcePath: "builtin",
      source: "builtin",
      snippet: "Execute bash commands",
    },
  ],
  skills: [
    {
      name: "oversized-skill",
      filePath: "/tmp/skills/oversized.md",
      formattedChars: 5000,
    },
  ],
  contextFiles: [
    {
      path: "/tmp/context/large-file.md",
      chars: 30000,
    },
  ],
  toolTokenThreshold: 100,
  skillCharThreshold: 2000,
  contextFileCharThreshold: 20000,
};

function makeInspectContextTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "inspect_context",
    label: "Inspect Context",
    description:
      "Break down the live context window by component — system-prompt text " +
      "(skills/guidelines/context-files/snippets) vs API tools-schema (a separate " +
      "per-request cost) vs conversation overhead. All tools sorted by token cost. " +
      "For issue-finding use inspect_extensions instead.",
    parameters: Type.Object({
      self_test: Type.Optional(
        Type.Boolean({
          description: "When true, return a deterministic mock report without requiring a live LLM session",
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.self_test) {
        return {
          content: [
            { type: "text" as const, text: SELF_TEST_CONTEXT_ANALYZER_OUTPUT },
          ],
          details: null,
        };
      }
      const usage = ctx.getContextUsage();
      const opts = (ctx as ExtensionContext).getSystemPromptOptions();
      const fullSystemPrompt = (ctx as ExtensionContext).getSystemPrompt();
      const lines: string[] = [];

      // ── Header ────────────────────────────────────────────────────────────
      lines.push("╔══════════════════════════════════════╗");
      lines.push("║         Inspect Context              ║");
      lines.push("╚══════════════════════════════════════╝");
      lines.push("");

      // ── Live context window ───────────────────────────────────────────────
      lines.push("▶ Live context window:");
      if (usage) {
        const tokStr = usage.tokens != null ? usage.tokens.toLocaleString() + " tok" : "tok unknown";
        const winStr = usage.contextWindow.toLocaleString();
        lines.push(`  ${bar(usage.percent)}  ${tokStr} / ${winStr}`);
      } else {
        lines.push("  unavailable (no LLM turn completed yet)");
      }
      lines.push("");


      // ── Measure both token buckets ────────────────────────────────────────
      // Bucket A: system prompt text (what buildSystemPrompt() returns)
      const sysPromptChars = fullSystemPrompt.length;
      const sysPromptTok = estTok(sysPromptChars);

      // Bucket B: API tools schema (desc + params per tool) — NOT in system prompt text.
      // This is sent in the tools[] array of every API request separately.
      const allTools = getAllTools();
      const selectedSet = new Set(opts.selectedTools ?? []);
      const activeTools = allTools.filter((t) => selectedSet.size === 0 || selectedSet.has(t.name));

      const toolApiMeasured = activeTools.map((t) => {
        const descChars = (t.description ?? "").length;
        const paramsChars = JSON.stringify(t.parameters ?? {}).length;
        const apiChars = descChars + paramsChars;
        const guideChars = (t.promptGuidelines ?? []).join("\n").length;
        const snippetChars = (opts.toolSnippets?.[t.name] ?? "").length;
        return { name: t.name, descChars, paramsChars, apiChars, guideChars, snippetChars };
      });

      const totalApiChars = toolApiMeasured.reduce((s, t) => s + t.apiChars, 0);
      const totalApiTok = estTok(totalApiChars);

      // Bucket C: conversation + other (live total minus the two estimated buckets)
      const liveTok = usage?.tokens ?? null;
      const conversationTok = liveTok != null ? Math.max(0, liveTok - sysPromptTok - totalApiTok) : null;
      const grandTotal = liveTok ?? sysPromptTok + totalApiTok;

      // ── Token budget summary ──────────────────────────────────────────────
      lines.push("▶ Token budget  (where tokens go):");
      lines.push("  ┌─────────────────────────────────────────────────────────────┐");

      const renderBucket = (label: string, tok: number | null, note: string) => {
        const t = tok ?? 0;
        const pct = grandTotal > 0 ? t / grandTotal : 0;
        const mb = miniBar(pct);
        const tokStr = tok != null ? t.toLocaleString() + " tok" : "???";
        lines.push(`  │  ${label.padEnd(24)} ${mb}  ${tokStr.padStart(12)}  ${note}`);
      };

      renderBucket("System prompt text", sysPromptTok, "(measured)");
      renderBucket("API tools schema", totalApiTok, "(estimated)");
      renderBucket("Conversation + other", conversationTok, liveTok != null ? "(live − above)" : "(no live data)");

      lines.push("  └─────────────────────────────────────────────────────────────┘");
      lines.push("  Note: API tools schema goes in tools[] per request, NOT in system prompt text.");
      lines.push("");

      // ── System prompt text breakdown ──────────────────────────────────────
      lines.push(`▶ System prompt text  (${sysPromptChars.toLocaleString()} chars, ${est(sysPromptChars)}):`);
      lines.push("");

      // Skills
      const skills = opts.skills ?? [];
      const skillsFormatted = formatSkillsForPrompt(skills);
      const skillsTotalChars = skillsFormatted.length;
      lines.push(`  Skills  (${skills.length} loaded, ${est(skillsTotalChars)}):`);
      if (skills.length === 0) {
        lines.push("    none");
      } else {
        const measured = skills
          .map((s) => ({ name: s.name, chars: formatSkillsForPrompt([s]).length, desc: s.description }))
          .sort((a, b) => b.chars - a.chars);
        measured.forEach((s) => {
          lines.push(`    ${s.name.padEnd(28)} ${s.chars.toLocaleString().padStart(6)} ch  ${est(s.chars)}`);
        });
      }
      lines.push("");

      // Context files
      const contextFiles = opts.contextFiles ?? [];
      const totalFileChars = contextFiles.reduce((s, f) => s + f.content.length, 0);
      lines.push(`  Context files  (${contextFiles.length} files, ${est(totalFileChars)}):`);
      if (contextFiles.length === 0) {
        lines.push("    none");
      } else {
        contextFiles
          .slice()
          .sort((a, b) => b.content.length - a.content.length)
          .forEach((f) => {
            lines.push(`    ${f.path.padEnd(40)} ${f.content.length.toLocaleString().padStart(6)} ch  ${est(f.content.length)}`);
          });
      }
      lines.push("");

      // Tool snippets (Available tools section of system prompt)
      const snippetEntries = Object.entries(opts.toolSnippets ?? {});
      const totalSnippetChars = snippetEntries.reduce((s, [, v]) => s + v.length, 0);
      lines.push(`  Tool snippets in Available-tools list  (${snippetEntries.length} tools, ${est(totalSnippetChars)}):`);
      if (snippetEntries.length === 0) {
        lines.push("    none");
      } else {
        snippetEntries.sort((a, b) => b[1].length - a[1].length).slice(0, 5).forEach(([name, snippet]) => {
          lines.push(`    ${name.padEnd(28)} "${snippet.slice(0, 60)}${snippet.length > 60 ? "…" : ""}"`);
        });
        if (snippetEntries.length > 5) lines.push(`    … +${snippetEntries.length - 5} more`);
      }
      lines.push("");

      // Guidelines (from all tools' promptGuidelines + extension-level)
      const allGuideChars = toolApiMeasured.reduce((s, t) => s + t.guideChars, 0);
      const extGuidelines = opts.promptGuidelines ?? [];
      const extGuideChars = extGuidelines.join("\n").length;
      const totalGuideChars = allGuideChars + extGuideChars;
      lines.push(`  Guidelines  (${extGuidelines.length} bullets, ${est(totalGuideChars)} total):`);
      if (extGuidelines.length === 0) {
        lines.push("    none");
      } else {
        extGuidelines.forEach((g, i) => {
          lines.push(`    ${i + 1}. ${g.slice(0, 110)}${g.length > 110 ? "…" : ""}`);
        });
      }
      lines.push("");

      // Appended system prompt
      if (opts.appendSystemPrompt) {
        const chars = opts.appendSystemPrompt.length;
        lines.push(`  Appended system prompt:  ${chars.toLocaleString()} chars  (${est(chars)})`);
        lines.push(`    ${opts.appendSystemPrompt.slice(0, 140)}${opts.appendSystemPrompt.length > 140 ? "…" : ""}`);
        lines.push("");
      }

      // ── API tools schema breakdown ────────────────────────────────────────
      lines.push(`▶ API tools schema  (${activeTools.length} active / ${allTools.length} total, ~${totalApiTok.toLocaleString()} tok estimated):`);
      lines.push("  (description + parameters → tools[] array; cost repeats every API request)");
      lines.push("");

      if (toolApiMeasured.length === 0) {
        lines.push("  none");
      } else {
        const sorted = [...toolApiMeasured].sort((a, b) => b.apiChars - a.apiChars);
        lines.push(
          "  " +
            "Tool".padEnd(30) +
            "desc".padStart(6) +
            "params".padStart(8) +
            "est-tok".padStart(9) +
            "  guidelines",
        );
        lines.push("  " + "─".repeat(70));
        sorted.forEach((t) => {
          const tok = estTok(t.apiChars);
          const guideNote = t.guideChars > 0 ? `+${est(t.guideChars)} sys` : "";
          lines.push(
            "  " +
              t.name.padEnd(30) +
              String(t.descChars).padStart(6) +
              String(t.paramsChars).padStart(8) +
              String(tok).padStart(8) +
              "  " +
              guideNote,
          );
        });
        lines.push("  " + "─".repeat(70));
        const totalDesc = sorted.reduce((s, t) => s + t.descChars, 0);
        const totalParams = sorted.reduce((s, t) => s + t.paramsChars, 0);
        lines.push(
          "  " +
            "TOTAL".padEnd(30) +
            String(totalDesc).padStart(6) +
            String(totalParams).padStart(8) +
            String(totalApiTok).padStart(8),
        );
      }
      lines.push("");

      if (opts.customPrompt) {
        const chars = opts.customPrompt.length;
        lines.push(`▶ Custom system prompt (replaces default):  ${chars.toLocaleString()} chars  (${est(chars)})`);
        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
    },
  });
}

// ─── Inspect Agent Tool ─────────────────────────────────────────────────────

function makeInspectAgentTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "inspect_agent",
    label: "Inspect Agent",
    description:
      "Snapshot the full agent state — extensions, tools, skills, context files, " +
      "model, cwd — to YAML (file or inline). Use for debugging, replay, or auditing " +
      "what is loaded. For token-distribution only, use inspect_context.",
    parameters: Type.Object({
      output_dir: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      return_content: Type.Optional(Type.Boolean()),
      self_test: Type.Optional(
        Type.Boolean({
          description: "When true, return a deterministic mock inventory without requiring a live LLM session",
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.self_test) {
        return {
          content: [{ type: "text" as const, text: SELF_TEST_AGENT_INVENTORY_OUTPUT }],
          details: null,
        };
      }
      const outputDir =
        params.output_dir === undefined || params.output_dir === "" ? "output/pi" : params.output_dir;
      const filename =
        params.filename === undefined || params.filename === ""
          ? `agent-inventory-${Date.now()}`
          : params.filename;
      const returnContent = params.return_content ?? false;

      // Build inventory data structure
      const inventory: Record<string, unknown> = {
        agent: {
          app_name: "pi",
          cwd: ctx.cwd,
          timestamp: new Date().toISOString(),
          mode: ctx.mode,
          has_ui: ctx.hasUI,
          is_idle: ctx.isIdle(),
          is_project_trusted: ctx.isProjectTrusted(),
        },
        model: ctx.model
          ? {
              id: ctx.model.id,
              name: ctx.model.name,
              provider: ctx.model.provider,
              reasoning: ctx.model.reasoning,
              context_window: ctx.model.contextWindow,
              max_tokens: ctx.model.maxTokens,
              input_types: ctx.model.input,
            }
          : null,
        context_usage: ctx.getContextUsage() ?? null,
      };

      // Get tools with full details
      const allTools = getAllTools();
      inventory.tools = allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        prompt_guidelines: tool.promptGuidelines ?? [],
        source: tool.sourceInfo
          ? {
              source: tool.sourceInfo.source,
              scope: tool.sourceInfo.scope,
              origin: tool.sourceInfo.origin,
              path: tool.sourceInfo.path,
              base_dir: tool.sourceInfo.baseDir ?? null,
            }
          : null,
      }));

      // Get system prompt options for skills and context files
      const opts = (ctx as ExtensionContext).getSystemPromptOptions();
      // Skills
      inventory.skills = (opts.skills ?? []).map((skill: any) => ({
        name: skill.name,
        description: skill.description,
        file_path: skill.filePath,
        base_dir: skill.baseDir,
        disable_model_invocation: skill.disableModelInvocation,
        source: skill.sourceInfo
          ? {
              source: skill.sourceInfo.source,
              scope: skill.sourceInfo.scope,
              origin: skill.sourceInfo.origin,
            }
          : null,
      }));

      // Context files
      inventory.context_files = (opts.contextFiles ?? []).map((file: { path: string; content: string }) => ({
        path: file.path,
        chars: file.content.length,
        estimated_tokens: Math.round(file.content.length / TOKEN_RATIO),
      }));

      // Guidelines
      inventory.guidelines = opts.promptGuidelines ?? [];

      // Tool snippets
      inventory.tool_snippets = Object.fromEntries(
        Object.entries(opts.toolSnippets ?? {}).map(([k, v]) => [k, (v as string).substring(0, 200)])
      );

      // Convert to YAML
      const yamlContent = yaml.dump(inventory, {
        indent: 2,
        lineWidth: -1, // No line wrapping
        noRefs: true,
        sortKeys: false,
      });

      if (returnContent) {
        return {
          content: [{ type: "text" as const, text: yamlContent }],
          details: null,
        };
      }

      // Write to file — keep both the output dir and filename contained under cwd.
      const resolvedCwd = resolve(ctx.cwd);
      const fullOutputDir = resolve(resolvedCwd, outputDir);
      if (fullOutputDir !== resolvedCwd && !fullOutputDir.startsWith(resolvedCwd + sep)) {
        return {
          content: [
            { type: "text" as const, text: `Error: output_dir must stay within ${resolvedCwd}, got "${outputDir}"` },
          ],
          details: null,
        };
      }
      if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
        return {
          content: [{ type: "text" as const, text: `Error: filename must not contain path separators, got "${filename}"` }],
          details: null,
        };
      }
      const outputPath = join(fullOutputDir, `${filename}.yaml`);

      try {
        if (!existsSync(fullOutputDir)) {
          mkdirSync(fullOutputDir, { recursive: true });
        }
        writeFileSync(outputPath, yamlContent, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error writing inventory to ${outputPath}: ${msg}` }],
          details: null,
        };
      }

      const lines: string[] = [];
      lines.push("╔══════════════════════════════════════╗");
      lines.push("║        Inspect Agent                ║");
      lines.push("╚══════════════════════════════════════╝");
      lines.push("");
      lines.push(`Output: ${outputPath}`);
      lines.push("");
      lines.push(`Summary:`);
      lines.push(`  - Tools: ${allTools.length}`);
      lines.push(`  - Skills: ${(inventory.skills as unknown[]).length}`);
      lines.push(`  - Context files: ${(inventory.context_files as unknown[]).length}`);
      lines.push(`  - CWD: ${ctx.cwd}`);
      if (ctx.model) {
        lines.push(`  - Model: ${ctx.model.name} (${ctx.model.id})`);
        lines.push(`  - Context window: ${ctx.model.contextWindow.toLocaleString()} tokens`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
    },
  });
}

// ─── Inspect Extensions Tool ─────────────────────────────────────────────────

/**
 * inspect_extensions — lint loaded extensions/tools/skills/guidelines for
 * POTENTIAL ISSUES (the worktree's goal). Unlike inspect_context (which
 * measures token distribution) and inspect_agent (which dumps state), this
 * surfaces problems an extension author or maintainer should act on.
 *
 * The check logic is PURE (analyzeExtensions over a typed AnalysisInput) so it
 * is unit-testable without the SDK; execute() just derives the input from the
 * captured snapshot + getAllTools() and formats the findings.
 */

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  /** machine id, e.g. "duplicate-tool-name" */
  check: string;
  /** one human-readable line */
  message: string;
  /** structured payload (for JSON mode / assertions) */
  detail?: Record<string, unknown>;
}

export interface AnalysisTool {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  /** sourceInfo.path — the extension file that registered the tool */
  sourcePath: string;
  /** sourceInfo.source — "builtin" | "extension" | "file" | ... */
  source: string;
  /** rendered Available-tools snippet (from opts.toolSnippets[name]); absent = none */
  snippet?: string;
}

export interface AnalysisSkill {
  name: string;
  filePath: string;
  /** formatSkillsForPrompt([skill]).length — the on-wire size */
  formattedChars: number;
}

export interface AnalysisContextFile {
  path: string;
  chars: number;
}

export interface AnalysisInput {
  /** Active tools — currently in the per-request tools[] array (selectedTools). */
  tools: AnalysisTool[];
  /**
   * Registered-but-inactive tools (getAllTools() minus selectedTools). These cost
   * 0 tok/req now but would if activated. OPTIONAL so existing callers/tests that
   * omit it keep their old behavior (no lazy findings).
   */
  inactiveTools?: AnalysisTool[];
  skills: AnalysisSkill[];
  contextFiles: AnalysisContextFile[];
  toolTokenThreshold: number;
  skillCharThreshold: number;
  contextFileCharThreshold: number;
}

/** Compact a source path for table display: prefer the bun-apps/... tail. */
function shortPath(p: string): string {
  const i = p.indexOf("bun-apps/");
  if (i >= 0) return p.slice(i);
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}

/**
 * Run all extension-health checks against a fully-derived input. PURE — no SDK,
 * no fs, no snapshot. Order of returned findings is: duplicate-name, missing-
 * description, missing-snippet, oversized-tool, oversized-skill, oversized-
 * context-file, stale-guideline-ref, no-guidelines, then per-extension tax
 * (info) + total (info), then lazy-loaded extensions (info) + lazy total (info).
 */
export function analyzeExtensions(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const { tools, inactiveTools, skills, contextFiles, toolTokenThreshold, skillCharThreshold, contextFileCharThreshold } = input;

  // 🔴 duplicate tool name (same name from ≥2 distinct sources → silent override)
  const sourcesByName = new Map<string, Set<string>>();
  for (const t of tools) {
    const set = sourcesByName.get(t.name) ?? new Set<string>();
    set.add(t.sourcePath);
    sourcesByName.set(t.name, set);
  }
  for (const [name, srcs] of sourcesByName) {
    if (srcs.size > 1) {
      findings.push({
        severity: "high",
        check: "duplicate-tool-name",
        message: `Tool "${name}" registered from ${srcs.size} sources → silent override / "Tool '${name}' conflicts"`,
        detail: { name, sources: [...srcs] },
      });
    }
  }

  // 🔴 missing/empty description (model can't discover or aim the tool)
  for (const t of tools) {
    if (!t.description || t.description.trim().length === 0) {
      findings.push({
        severity: "high",
        check: "missing-description",
        message: `Tool "${t.name}" has no description — the model can't discover when to call it`,
        detail: { name: t.name, source: t.sourcePath },
      });
    }
  }

  // 🟡 missing Available-tools snippet (custom tools are omitted from that list
  // when promptSnippet is unset → discovery cost). Detect via absence from
  // opts.toolSnippets, surfaced here as t.snippet being empty.
  for (const t of tools) {
    if (!t.snippet || t.snippet.trim().length === 0) {
      findings.push({
        severity: "medium",
        check: "missing-snippet",
        message: `Tool "${t.name}" has no Available-tools snippet`,
        detail: { name: t.name, source: t.sourcePath },
      });
    }
  }

  // 🟡 oversized tool schema (desc + JSON(params)) — repeats on EVERY request
  for (const t of tools) {
    const apiChars = (t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length;
    const tok = estTok(apiChars);
    if (tok > toolTokenThreshold) {
      findings.push({
        severity: "medium",
        check: "oversized-tool-schema",
        message: `Tool "${t.name}" schema ~${tok} tok/req (threshold ${toolTokenThreshold})`,
        detail: { name: t.name, tokens: tok, source: t.sourcePath },
      });
    }
  }

  // 🟡 oversized skill
  for (const s of skills) {
    if (s.formattedChars > skillCharThreshold) {
      findings.push({
        severity: "medium",
        check: "oversized-skill",
        message: `Skill "${s.name}" ${s.formattedChars.toLocaleString()} ch (threshold ${skillCharThreshold.toLocaleString()})`,
        detail: { name: s.name, chars: s.formattedChars, file: s.filePath },
      });
    }
  }

  // 🟡 oversized context file
  for (const f of contextFiles) {
    if (f.chars > contextFileCharThreshold) {
      findings.push({
        severity: "medium",
        check: "oversized-context-file",
        message: `Context file "${f.path}" ${f.chars.toLocaleString()} ch (threshold ${contextFileCharThreshold.toLocaleString()})`,
        detail: { path: f.path, chars: f.chars },
      });
    }
  }

  // 🟢 stale guideline reference — a backticked `tool_name` that isn't registered
  const names = new Set(tools.map((t) => t.name));
  for (const t of tools) {
    for (const g of t.promptGuidelines ?? []) {
      const refs = [...g.matchAll(/`([a-z][a-z0-9_-]+)`/g)].map((m) => m[1]!);
      for (const ref of refs) {
        if (!names.has(ref)) {
          findings.push({
            severity: "low",
            check: "stale-guideline-ref",
            message: `Tool "${t.name}" guideline references unknown tool \`${ref}\``,
            detail: { tool: t.name, ref },
          });
        }
      }
    }
  }

  // ℹ️ no promptGuidelines — INFORMATIONAL, not an issue. promptGuidelines is
  // OPTIONAL in the SDK, and guidelines are a context COST (this repo's own
  // 53 bullets = ~3,259 tok). Absence is often a virtue, so we surface it as
  // info rather than flagging it as a problem. Skip builtins.
  for (const t of tools) {
    if (t.source === "builtin") continue;
    if (!t.promptGuidelines || t.promptGuidelines.length === 0) {
      findings.push({
        severity: "info",
        check: "no-guidelines",
        message: `Tool "${t.name}" has no promptGuidelines (optional — listed for awareness, not a defect)`,
        detail: { name: t.name, source: t.sourcePath },
      });
    }
  }

  // ℹ️ per-extension token tax (non-builtin tools grouped by sourcePath)
  const tax = new Map<string, { tools: number; tokens: number }>();
  for (const t of tools) {
    if (t.source === "builtin") continue;
    const tok = estTok((t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length);
    const e = tax.get(t.sourcePath) ?? { tools: 0, tokens: 0 };
    e.tools += 1;
    e.tokens += tok;
    tax.set(t.sourcePath, e);
  }
  const totalTax = [...tax.values()].reduce((s, e) => s + e.tokens, 0);
  for (const [path, e] of tax) {
    findings.push({
      severity: "info",
      check: "extension-token-tax",
      message: `${shortPath(path)}: ${e.tools} tool(s), ~${e.tokens} tok/req`,
      detail: { path, tools: e.tools, tokens: e.tokens, total: totalTax },
    });
  }
  findings.push({
    severity: "info",
    check: "total-extension-tax",
    message: `Extensions add ~${totalTax.toLocaleString()} tok/req across ${tax.size} source(s)`,
    detail: { total: totalTax, sources: tax.size },
  });

  // ℹ️ lazy-loaded extensions: registered (getAllTools) but NOT active (not in
  // selectedTools → absent from the per-request tools[] array → 0 tok now).
  // They WOULD cost tokens if activated. Surfaced so authors see the FULL
  // inventory, not just what is currently loaded — and can judge the potential
  // tax of activating them. Builtins are skipped (same rule as the active tax).
  const lazyTax = new Map<string, { tools: string[]; tokens: number }>();
  for (const t of inactiveTools ?? []) {
    if (t.source === "builtin") continue;
    const tok = estTok((t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length);
    const e = lazyTax.get(t.sourcePath) ?? { tools: [], tokens: 0 };
    e.tools.push(t.name);
    e.tokens += tok;
    lazyTax.set(t.sourcePath, e);
  }
  const lazyTotal = [...lazyTax.values()].reduce((s, e) => s + e.tokens, 0);
  for (const [path, e] of lazyTax) {
    findings.push({
      severity: "info",
      check: "lazy-loaded-extension",
      message: `${shortPath(path)}: ${e.tools.length} tool(s) registered but not active (lazy) — ~${e.tokens} tok/req if loaded`,
      detail: { path, tools: e.tools, count: e.tools.length, tokens: e.tokens, total: lazyTotal },
    });
  }
  if (lazyTax.size > 0) {
    findings.push({
      severity: "info",
      check: "total-lazy-tax",
      message: `Lazy extensions add ~${lazyTotal.toLocaleString()} tok/req if activated across ${lazyTax.size} source(s)`,
      detail: { total: lazyTotal, sources: lazyTax.size },
    });
  }

  return findings;
}

/** Count actionable issues (excluding info) by severity. PURE. */
export function summarizeFindings(findings: Finding[]): {
  total: number;
  high: number;
  medium: number;
  low: number;
} {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === "info") continue;
    counts[f.severity as "high" | "medium" | "low"] += 1;
  }
  return { total: counts.high + counts.medium + counts.low, ...counts };
}

/** Render findings as a human-readable severity-ranked report. PURE. */
export function formatExtensionReport(findings: Finding[]): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════╗");
  lines.push("║        Inspect Extensions           ║");
  lines.push("╚══════════════════════════════════════╝");
  lines.push("");

  const summary = summarizeFindings(findings);
  lines.push(
    `▶ ${summary.total} issue(s): 🔴 ${summary.high} high · 🟡 ${summary.medium} medium · 🟢 ${summary.low} low`,
  );
  lines.push("");

  const section = (sev: Severity, icon: string, label: string) => {
    const items = findings.filter((f) => f.severity === sev);
    if (items.length === 0) return;
    lines.push(`▶ ${icon} ${label} (${items.length}):`);
    for (const f of items) lines.push(`  • ${f.message}`);
    lines.push("");
  };

  if (summary.total === 0) {
    lines.push("✓ No actionable issues — extensions look healthy.");
    lines.push("");
  } else {
    section("high", "🔴", "High");
    section("medium", "🟡", "Medium");
    section("low", "🟢", "Low");
  }

  // Extension token tax table (sorted by tokens desc)
  const tax = findings
    .filter((f) => f.check === "extension-token-tax")
    .sort((a, b) => ((b.detail?.tokens as number) ?? 0) - ((a.detail?.tokens as number) ?? 0));
  const grand = (findings.find((f) => f.check === "total-extension-tax")?.detail?.total ?? 0) as number;
  lines.push("▶ Extension token tax (est. tok/req, non-builtin tools):");
  if (tax.length === 0) {
    lines.push("  none");
  } else {
    for (const f of tax) {
      const tok = (f.detail?.tokens as number) ?? 0;
      const pct = grand > 0 ? tok / grand : 0;
      const name = shortPath((f.detail?.path as string) ?? "");
      lines.push(
        `  ${name.padEnd(42)} ${String(f.detail?.tools).padStart(3)} tool(s)  ~${String(tok).padStart(5)} tok  ${miniBar(pct)} ${Math.round(pct * 100)}%`,
      );
    }
    lines.push("  " + "─".repeat(42));
    lines.push(`  TOTAL${"".padEnd(37)} ~${grand.toLocaleString()} tok/req`);
  }
  lines.push("");

  // Lazy-loaded extensions (registered, not active — 0 tok now, cost shown if activated)
  const lazy = findings
    .filter((f) => f.check === "lazy-loaded-extension")
    .sort((a, b) => ((b.detail?.tokens as number) ?? 0) - ((a.detail?.tokens as number) ?? 0));
  const lazyGrand = (findings.find((f) => f.check === "total-lazy-tax")?.detail?.total ?? 0) as number;
  if (lazy.length > 0) {
    lines.push("▶ Lazy-loaded extensions (registered, not active — 0 tok now, cost shown if activated):");
    for (const f of lazy) {
      const tok = (f.detail?.tokens as number) ?? 0;
      const pct = lazyGrand > 0 ? tok / lazyGrand : 0;
      const name = shortPath((f.detail?.path as string) ?? "");
      const toolList = ((f.detail?.tools as string[]) ?? []).join(", ");
      lines.push(
        `  ${name.padEnd(42)} ${String((f.detail?.count as number) ?? 0).padStart(3)} tool(s)  ~${String(tok).padStart(5)} tok  ${miniBar(pct)} ${Math.round(pct * 100)}%`,
      );
      lines.push(`  ${"".padEnd(42)} tools: ${toolList}`);
    }
    lines.push("  " + "─".repeat(42));
    lines.push(`  TOTAL${"".padEnd(37)} ~${lazyGrand.toLocaleString()} tok/req if activated`);
    lines.push("");
  }
  return lines.join("\n");
}

function makeInspectExtensionsTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "inspect_extensions",
    label: "Inspect Extensions",
    description:
      "Lint loaded extensions, tools, skills, and guidelines for health issues: " +
      "duplicate names, missing descriptions/snippets, oversized schemas, stale " +
      "references, per-extension token tax, and lazy-loaded extensions " +
      "(registered but not active). Severity-ranked report or JSON. " +
      "For pure token measurement use inspect_context.",
    parameters: Type.Object({
      return_json: Type.Optional(
        Type.Boolean({ description: "Return machine-readable {findings, summary, total_extension_tokens} JSON instead of a text report" }),
      ),
      tool_token_threshold: Type.Optional(
        Type.Number({ description: "Flag tools whose API schema exceeds this many tokens (default 1500)" }),
      ),
      skill_char_threshold: Type.Optional(
        Type.Number({ description: "Flag skills whose formatted size exceeds this many chars (default 2000)" }),
      ),
      context_file_char_threshold: Type.Optional(
        Type.Number({ description: "Flag context files exceeding this many chars (default 20000)" }),
      ),
      self_test: Type.Optional(
        Type.Boolean({
          description: "When true, run against deterministic test data instead of live ctx",
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const opts = (_ctx as ExtensionContext).getSystemPromptOptions();
      const snippets = (opts.toolSnippets ?? {}) as Record<string, string>;
      const selectedSet = new Set<string>((opts.selectedTools as string[] | undefined) ?? []);
      const allTools = getAllTools();
      const activeTools = allTools.filter((t) => selectedSet.size === 0 || selectedSet.has(t.name));
      // Lazy/inactive tools: registered (getAllTools) but NOT in the active
      // selection (opts.selectedTools) → not in the per-request tools[] array,
      // costing 0 tok now. Surfaced as lazy-loaded-extension findings.
      const inactiveRaw =
        selectedSet.size === 0 ? [] : allTools.filter((t) => !selectedSet.has(t.name));

      const toAnalysis = (t: (typeof allTools)[number]): AnalysisTool => ({
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters,
        promptGuidelines: t.promptGuidelines,
        sourcePath: t.sourceInfo?.path ?? "(unknown)",
        source: t.sourceInfo?.source ?? "unknown",
        snippet: snippets[t.name],
      });
      const tools: AnalysisTool[] = activeTools.map(toAnalysis);
      const inactiveAnalysisTools: AnalysisTool[] = inactiveRaw.map(toAnalysis);
      const skills: AnalysisSkill[] = ((opts.skills as unknown[]) ?? []).map((s: any) => ({
        name: s.name as string,
        filePath: (s.filePath as string) ?? "",
        formattedChars: formatSkillsForPrompt([s]).length,
      }));
      const contextFiles: AnalysisContextFile[] = ((opts.contextFiles as { path: string; content: string }[]) ?? []).map(
        (f) => ({ path: f.path, chars: f.content.length }),
      );

      const input: AnalysisInput = {
        tools,
        inactiveTools: inactiveAnalysisTools,
        skills,
        contextFiles,
        toolTokenThreshold: params.tool_token_threshold ?? 1500,
        skillCharThreshold: params.skill_char_threshold ?? 2000,
        contextFileCharThreshold: params.context_file_char_threshold ?? 20000,
      };
      const findings = analyzeExtensions(input);

      if (params.return_json) {
        const total = (findings.find((f) => f.check === "total-extension-tax")?.detail?.total ?? 0) as number;
        const lazyTotal = (findings.find((f) => f.check === "total-lazy-tax")?.detail?.total ?? 0) as number;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  findings,
                  summary: summarizeFindings(findings),
                  total_extension_tokens: total,
                  total_lazy_tokens: lazyTotal,
                },
                null,
                2,
              ),
            },
          ],
          details: null,
        };
      }
      return { content: [{ type: "text" as const, text: formatExtensionReport(findings) }], details: null };
    },
  });
}

// ─── Extension factory ────────────────────────────────────────────────────────

// ─── Stale-ctx error guard (matches pi-core's throw phrase) ─────────────────
// ─── Extension factory ────────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Apply SDK compatibility shim: ensures getSystemPromptOptions() is available
  // on the tool execution context (ExtensionContext). This is a memory-only
  // monkey-patch — no filesystem writes. Safe to call multiple times.
  ensureGetSystemPromptOptions();

  // getAllTools() is on ExtensionAPI (pi), not ExtensionContext (ctx).
  // Pass it as a closure into the tool so execute() can call it.
  const getAllTools = () => pi.getAllTools();
  pi.registerTool(makeInspectContextTool(getAllTools));
  pi.registerTool(makeInspectAgentTool(getAllTools));
  pi.registerTool(makeInspectExtensionsTool(getAllTools));
  pi.registerTool(makeInspectPathologyTool());

  // Feed the pathology accumulator: observe every tool call's args + outcome so
  // inspect_pathology can detect retry loops / error storms this session.
  // After each call, surface a non-invasive status warning if a HIGH-severity
  // loop / consecutive-error is active (Phase 1.1). session_start resets
  // per-session state (diagnostics are self-contained).
  pi.on("tool_execution_start", recordCallStart);
  pi.on("tool_execution_end", (event, ctx) => {
    recordCallEnd(event);
    surfacePathologyWarning(ctx, getCalls());
  });
  pi.on("turn_end", recordTurnEnd);
  pi.on("session_start", () => {
    resetAccumulator();
    resetWarning();
  });
};

export default extension;
