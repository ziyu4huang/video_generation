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
  type ToolInfo,
  defineTool,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as yaml from "js-yaml";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";

// ─── Snapshot captured from before_agent_start ────────────────────────────────

interface Snapshot {
  systemPrompt: string;
  opts: BuildSystemPromptOptions;
}

let snapshot: Snapshot | null = null;

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

// ─── Extension factory ────────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  // Capture system prompt breakdown before each agent turn.
  pi.on("before_agent_start", (event) => {
    snapshot = { systemPrompt: event.systemPrompt, opts: event.systemPromptOptions };
  });

  // getAllTools() is on ExtensionAPI (pi), not ExtensionContext (ctx).
  // Pass it as a closure into the tool so execute() can call it.
  const getAllTools = () => pi.getAllTools();
  pi.registerTool(makeContextAnalyzerTool(getAllTools));
  pi.registerTool(makeAgentInventoryTool(getAllTools));
};

export default extension;
