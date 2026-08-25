/**
 * inspect_agent — dump agent state to YAML: extensions, tools, skills, context
 * files, model, cwd. Outputs to <cwd>/output/pi/agent-inventory-<timestamp>.yaml
 * by default (the `filename` param default). Readable by humans and agents for
 * debugging/analysis.
 */
import {
  type ExtensionContext,
  type ToolInfo,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as yaml from "js-yaml";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { TOKEN_RATIO, reportHeader } from "../report.js";

const SELF_TEST_AGENT_INVENTORY_OUTPUT = [
  ...reportHeader("Inspect Agent"),
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

export function makeInspectAgentTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "inspect_agent",
    gating: { core: true }, // un-gated (ticket 06 HITL): diagnostics always-on
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

      const lines = reportHeader("Inspect Agent");
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
