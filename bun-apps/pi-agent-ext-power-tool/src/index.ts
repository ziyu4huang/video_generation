/**
 * pi-agent-ext-power-tool — extension factory.
 *
 * Tools provided:
 *   context_analyzer  — full context window breakdown, split by token bucket:
 *     • System prompt text (skills, guidelines, context files, tool snippets)
 *     • API tools schema (description + parameters per tool — a SEPARATE budget)
 *     • Estimated conversation overhead (live total minus the two above)
 *     All tools shown sorted by cost; guidelines shown in full.
 *
 *   agent_inventory    — dump agent state to YAML: extensions, tools, skills, context files, model, cwd.
 *     Outputs to <cwd>/output/pi/agent-inventory-<timestamp>.yaml by default.
 *     Readable by humans and agents for debugging/analysis.
 *
 * Usage:
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/src/index.ts -p "call context_analyzer"
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/src/index.ts -p "call agent_inventory"
 */
import {
  type BuildSystemPromptOptions,
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
import {
  retrieveRecords,
  graphHealth,
  healGraph,
  formatHealth,
  type RetrieveOptions,
  type GraphHealthOptions,
  type GraphHealthResult,
} from "pi-knowledge-card/src/retrieve.ts";
import { registerTodoTool, registerTodosCommand } from "./todo/todo";
import { TodoOverlay } from "./todo/overlay";
import { replayFromBranch } from "./todo/state/replay";
import { replaceState } from "./todo/state/store";
import { TOOL_NAME } from "./todo/tool/types";

// ─── Snapshot captured from before_agent_start ────────────────────────────────

interface Snapshot {
  systemPrompt: string;
  opts: BuildSystemPromptOptions;
}

let snapshot: Snapshot | null = null;

/**
 * Test-only: clear the module-level snapshot singleton. The power-tool captures
 * `before_agent_start` state in a closure (like pi-obsidian's getVault cache),
 * so it persists across tests in one file — tests that exercise the no-snapshot
 * graceful path must reset it first.
 */
export function __resetSnapshotForTests(): void {
  snapshot = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Rough chars→token estimate. Both tools share this ratio.
const TOKEN_RATIO = 3.7;

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

function makeContextAnalyzerTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "context_analyzer",
    label: "Context Analyzer",
    description:
      "Full context window breakdown split by token bucket: system prompt text " +
      "(skills, guidelines, context files, tool snippets) vs API tools schema " +
      "(description + parameters — a separate cost not in the system prompt text). " +
      "Shows all tools sorted by cost, estimated conversation overhead, and live usage.",
    promptSnippet: "Analyze and report context window usage by component",
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const usage = ctx.getContextUsage();
      const snap = snapshot;
      const lines: string[] = [];

      // ── Header ────────────────────────────────────────────────────────────
      lines.push("╔══════════════════════════════════════╗");
      lines.push("║         Context Analyzer             ║");
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

      if (!snap) {
        lines.push("  No before_agent_start snapshot yet — run this after a prompt.");
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
      }

      const opts = snap.opts;

      // ── Measure both token buckets ────────────────────────────────────────
      // Bucket A: system prompt text (what buildSystemPrompt() returns)
      const sysPromptChars = snap.systemPrompt.length;
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

// ─── Agent Inventory Tool ───────────────────────────────────────────────────

function makeAgentInventoryTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "agent_inventory",
    label: "Agent Inventory",
    description:
      "Dump agent state (extensions, tools, skills, context files, model, cwd) to YAML " +
      "for human and machine readability. Outputs to <cwd>/output/pi/ by default.",
    promptSnippet: "Dump agent configuration and state to YAML",
    parameters: Type.Object({
      output_dir: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      return_content: Type.Optional(Type.Boolean()),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
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
      const opts = snapshot?.opts;
      if (opts) {
        // Skills
        inventory.skills = (opts.skills ?? []).map((skill) => ({
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
        inventory.context_files = (opts.contextFiles ?? []).map((file) => ({
          path: file.path,
          chars: file.content.length,
          estimated_tokens: Math.round(file.content.length / TOKEN_RATIO),
        }));

        // Guidelines
        inventory.guidelines = opts.promptGuidelines ?? [];

        // Tool snippets
        inventory.tool_snippets = Object.fromEntries(
          Object.entries(opts.toolSnippets ?? {}).map(([k, v]) => [k, v.substring(0, 200)])
        );
      } else {
        inventory.skills = [];
        inventory.context_files = [];
        inventory.guidelines = [];
        inventory.tool_snippets = {};
      }

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
      lines.push("║        Agent Inventory               ║");
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

// ─── Extension Analyzer Tool ─────────────────────────────────────────────────

/**
 * extension_analyzer — lint loaded extensions/tools/skills/guidelines for
 * POTENTIAL ISSUES (the worktree's goal). Unlike context_analyzer (which
 * measures token distribution) and agent_inventory (which dumps state), this
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
  tools: AnalysisTool[];
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
 * (info) + total (info).
 */
export function analyzeExtensions(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const { tools, skills, contextFiles, toolTokenThreshold, skillCharThreshold, contextFileCharThreshold } = input;

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
  lines.push("║        Extension Analyzer            ║");
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
  return lines.join("\n");
}

function makeExtensionAnalyzerTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "extension_analyzer",
    label: "Extension Analyzer",
    description:
      "Lint loaded extensions, tools, skills and prompt-guidelines for potential issues: " +
      "duplicate tool names, missing descriptions/Available-tools snippets, oversized schemas/skills/context files, " +
      "stale guideline references, missing guidelines, and per-extension token cost. " +
      "Returns a severity-ranked report (or JSON).",
    promptSnippet: "Analyze extensions/tools/guidelines for potential issues",
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
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const snap = snapshot;
      if (!snap) {
        return {
          content: [{ type: "text" as const, text: "No before_agent_start snapshot yet — run this after a prompt." }],
          details: null,
        };
      }
      const opts = snap.opts;
      const snippets = (opts.toolSnippets ?? {}) as Record<string, string>;
      const selectedSet = new Set<string>((opts.selectedTools as string[] | undefined) ?? []);
      const allTools = getAllTools();
      const activeTools = allTools.filter((t) => selectedSet.size === 0 || selectedSet.has(t.name));

      const tools: AnalysisTool[] = activeTools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters,
        promptGuidelines: t.promptGuidelines,
        sourcePath: t.sourceInfo?.path ?? "(unknown)",
        source: t.sourceInfo?.source ?? "unknown",
        snippet: snippets[t.name],
      }));
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
        skills,
        contextFiles,
        toolTokenThreshold: params.tool_token_threshold ?? 1500,
        skillCharThreshold: params.skill_char_threshold ?? 2000,
        contextFileCharThreshold: params.context_file_char_threshold ?? 20000,
      };
      const findings = analyzeExtensions(input);

      if (params.return_json) {
        const total = (findings.find((f) => f.check === "total-extension-tax")?.detail?.total ?? 0) as number;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { findings, summary: summarizeFindings(findings), total_extension_tokens: total },
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

// ─── knowledge_query tool ──────────────────────────────────────────────────

/** Resolve vault path: env, then default under cwd. */
function resolveKnowledgeVault(): string | null {
  const explicit = process.env.OB_VAULT_PATH;
  if (explicit) return explicit;
  const dir = process.env.OB_VAULT_DIR ?? "vault";
  const abs = resolve(process.cwd(), dir);
  return existsSync(abs) ? abs : null;
}

function makeKnowledgeQueryTool() {
  return defineTool({
    name: "knowledge_query",
    label: "Knowledge Query",
    description:
      "Query the project's Zettelkasten knowledge graph for cards matching given tags " +
      "or a natural-language question. Returns a compact digest of relevant stored " +
      "knowledge (gotchas, patterns, levers, avoid, false_positive, metric cards). " +
      "Call this BEFORE answering a question that may benefit from past workflow " +
      "lessons.",
    promptSnippet: "Query knowledge graph for relevant cards",
    parameters: Type.Object({
      tags: Type.Optional(Type.Array(Type.String(), {
        description: "Tags to match (ANY semantics). e.g. [\"argparse\", \"lora\"]",
      })),
      query: Type.Optional(Type.String({
        description: "Natural language query. If provided without tags, tags are inferred.",
      })),
      topK: Type.Optional(Type.Number({
        description: "Max cards to return (default 10)",
        default: 10,
      })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const vaultPath = resolveKnowledgeVault();
      if (!vaultPath) {
        return {
          content: [{ type: "text" as const, text: "Error: Cannot resolve vault path. Set OB_VAULT_PATH." }],
          details: null,
        };
      }

      const tags: string[] = params.tags ?? [];
      const query: string = params.query ?? "";
      const topK: number = params.topK ?? 10;

      if (tags.length === 0 && !query) {
        return {
          content: [{ type: "text" as const, text: "Provide tags[], a query string, or both." }],
          details: null,
        };
      }

      // If no tags but a query is provided, split the query into word tokens as tags.
      const effectiveTags = tags.length > 0 ? tags : (
        query
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, " ")
          .trim()
          .split(/\s+/)
          .filter((t) => t.length >= 3 && t.length <= 30)
          .slice(0, 10)
      );

      const opts: RetrieveOptions = {
        vaultPath,
        folder: "Zettelkasten/knowledge-graph",
        tags: effectiveTags,
        topK,
      };

      const result = await retrieveRecords(opts);

      if (result.count === 0) {
        return {
          content: [{ type: "text" as const, text: `No knowledge cards matched tags [${effectiveTags.join(", ")}].` }],
          details: result,
        };
      }

      const lines = [
        `Knowledge graph: ${result.count} card(s) matched (scanned ${result.scanned}, excluded ${result.excluded})`,
        "",
        result.digest,
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: result,
      };
    },
  });
}

// ─── graphHealth tool ───────────────────────────────────────────────────────

function makeGraphHealthTool() {
  return defineTool({
    name: "graph_health",
    label: "Graph Health",
    description:
      "Audit the knowledge graph's structural health: dead wiki-links, MOC drift " +
      "(stale/missing Tags/Knowledge Graph.md), and orphan cards. Supports --fix " +
      "(auto-heal: regenerate MOC + prune dead links, scoped to the convergence " +
      "folder — never touches human-authored cards).",
    promptSnippet: "Audit graph health of the knowledge vault",
    parameters: Type.Object({
      fix: Type.Optional(Type.Boolean({
        description: "Auto-heal drift: regenerate MOC + prune dead links",
        default: false,
      })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const vaultPath = resolveKnowledgeVault();
      if (!vaultPath) {
        return {
          content: [{ type: "text" as const, text: "Error: Cannot resolve vault path. Set OB_VAULT_PATH." }],
          details: null,
        };
      }

      const folder = "Zettelkasten/knowledge-graph";
      const mocPath = "Tags/Knowledge Graph.md";
      const hOpts: GraphHealthOptions = { vaultPath, folder, mocPath };

      if (params.fix) {
        const healed = await healGraph(hOpts);
        const healMsg = `heal: MOC ${healed.mocRegenerated ? "regenerated" : "no change"}, ` +
          `${healed.deadLinksPruned} dead link(s) pruned in ${healed.cardsTouched.length} card(s)`;
        console.error(healMsg);
      }

      const h: GraphHealthResult = await graphHealth(hOpts);
      const report = formatHealth(h);

      return {
        content: [{ type: "text" as const, text: report }],
        details: h,
      };
    },
  });
}

// ─── Extension factory ────────────────────────────────────────────────────────

// ─── Stale-ctx error guard (matches pi-core's throw phrase) ─────────────────
function isStaleCtxError(e: unknown): boolean {
  return /stale after session replacement/.test(String(e));
}

// ─── Extension factory ────────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Capture system prompt breakdown before each agent turn.
  pi.on("before_agent_start", (event) => {
    snapshot = { systemPrompt: event.systemPrompt, opts: event.systemPromptOptions };
  });

  // getAllTools() is on ExtensionAPI (pi), not ExtensionContext (ctx).
  // Pass it as a closure into the tool so execute() can call it.
  const getAllTools = () => pi.getAllTools();
  pi.registerTool(makeContextAnalyzerTool(getAllTools));
  pi.registerTool(makeAgentInventoryTool(getAllTools));
  pi.registerTool(makeExtensionAnalyzerTool(getAllTools));
  pi.registerTool(makeKnowledgeQueryTool());
  pi.registerTool(makeGraphHealthTool());

  // ── Todo tool + /todos command ────────────────────────────────────────
  let todoOverlay: TodoOverlay | undefined;

  registerTodoTool(pi);
  registerTodosCommand(pi);

  pi.on("session_start", async (_event, ctx) => {
    replaceState(replayFromBranch(ctx));
    if (ctx.hasUI) {
      todoOverlay ??= new TodoOverlay();
      todoOverlay.setUICtx(ctx.ui);
      todoOverlay.resetCompletedDisplayState();
      todoOverlay.update();
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    try {
      replaceState(replayFromBranch(ctx));
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
    todoOverlay?.resetCompletedDisplayState();
    todoOverlay?.update();
  });

  pi.on("session_tree", async (_event, ctx) => {
    try {
      replaceState(replayFromBranch(ctx));
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
    todoOverlay?.resetCompletedDisplayState();
    todoOverlay?.update();
  });

  pi.on("session_shutdown", async () => {
    todoOverlay?.dispose();
    todoOverlay = undefined;
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) return;
    todoOverlay?.update();
  });

  pi.on("agent_start", async () => {
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
  });
};

export default extension;
