/**
 * pi-agent-ext-power-tool — extension factory.
 *
 * Tools provided:
 *   context_analyzer  — breakdown of context window by component:
 *                       skills (top 3 by size), tools (top 3 by schema size),
 *                       context files (all), guidelines (all), live usage.
 *
 * Usage:
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/src/index.ts -p "call context_analyzer"
 */
import {
  type BuildSystemPromptOptions,
  type ExtensionFactory,
  type ToolInfo,
  defineTool,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Snapshot captured from before_agent_start ────────────────────────────────

interface Snapshot {
  systemPrompt: string;
  opts: BuildSystemPromptOptions;
}

let snapshot: Snapshot | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function est(chars: number): string {
  return `~${Math.round(chars / 3.7).toLocaleString()} tok`;
}

function bar(percent: number | null, width = 30): string {
  if (percent == null) return "[" + " ".repeat(width) + "] ??%";
  const filled = Math.round((percent / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + `] ${percent.toFixed(1)}%`;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

function makeContextAnalyzerTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "context_analyzer",
    label: "Context Analyzer",
    description:
      "Analyze the current context window breakdown by component. " +
      "Shows top-3 skills by token size, top-3 tools by schema size, " +
      "all context files with sizes, all guidelines, and live context usage.",
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
        const tokStr = usage.tokens != null ? usage.tokens.toLocaleString() + " tokens" : "tokens unknown";
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

      // ── System prompt total ───────────────────────────────────────────────
      const totalChars = snap.systemPrompt.length;
      lines.push(`▶ System prompt total: ${totalChars.toLocaleString()} chars  (${est(totalChars)})`);
      lines.push("");

      // ── Skills ────────────────────────────────────────────────────────────
      const skills = opts.skills ?? [];
      const skillsFormatted = formatSkillsForPrompt(skills);
      const skillsTotalChars = skillsFormatted.length;

      lines.push(`▶ Skills  (${skills.length} loaded, ${skillsTotalChars.toLocaleString()} chars total, ${est(skillsTotalChars)}):`);

      if (skills.length === 0) {
        lines.push("  none");
      } else {
        const measured = skills
          .map((s) => ({ name: s.name, chars: formatSkillsForPrompt([s]).length, desc: s.description }))
          .sort((a, b) => b.chars - a.chars);

        measured.slice(0, 3).forEach((s, i) => {
          const pct = skillsTotalChars > 0 ? ` (${((s.chars / skillsTotalChars) * 100).toFixed(0)}%)` : "";
          lines.push(`  ${i + 1}. ${s.name}  ${s.chars.toLocaleString()} chars${pct}  ${est(s.chars)}`);
          if (s.desc) {
            lines.push(`     ${s.desc.slice(0, 100)}${s.desc.length > 100 ? "…" : ""}`);
          }
        });
        if (measured.length > 3) {
          lines.push(`  … +${measured.length - 3} more (not shown)`);
        }
      }
      lines.push("");

      // ── Tools ─────────────────────────────────────────────────────────────
      const allTools = getAllTools();
      const selectedSet = new Set(opts.selectedTools ?? []);

      lines.push(`▶ Tools  (${allTools.length} total, ${selectedSet.size || allTools.length} selected):`);

      if (allTools.length === 0) {
        lines.push("  none");
      } else {
        const measuredTools = allTools
          .map((t) => {
            const schemaChars = JSON.stringify(t.parameters ?? {}).length;
            const descChars = (t.description ?? "").length;
            const guideChars = (t.promptGuidelines ?? []).join("\n").length;
            const total = schemaChars + descChars + guideChars;
            const active = selectedSet.size === 0 || selectedSet.has(t.name);
            return { name: t.name, total, schemaChars, descChars, guideChars, active };
          })
          .sort((a, b) => b.total - a.total);

        measuredTools.slice(0, 3).forEach((t, i) => {
          const activeFlag = t.active ? "" : " [inactive]";
          lines.push(
            `  ${i + 1}. ${t.name}${activeFlag}  ${t.total.toLocaleString()} chars  ${est(t.total)}`,
          );
          lines.push(`     schema=${t.schemaChars} desc=${t.descChars} guidelines=${t.guideChars}`);
        });
        if (measuredTools.length > 3) {
          lines.push(`  … +${measuredTools.length - 3} more (not shown)`);
        }
      }
      lines.push("");

      // ── Context files ─────────────────────────────────────────────────────
      const contextFiles = opts.contextFiles ?? [];
      const totalFileChars = contextFiles.reduce((s, f) => s + f.content.length, 0);

      lines.push(
        `▶ Context files  (${contextFiles.length} files, ${totalFileChars.toLocaleString()} chars total, ${est(totalFileChars)}):`,
      );

      if (contextFiles.length === 0) {
        lines.push("  none");
      } else {
        contextFiles
          .slice()
          .sort((a, b) => b.content.length - a.content.length)
          .forEach((f) => {
            const pct = totalFileChars > 0 ? ` (${((f.content.length / totalFileChars) * 100).toFixed(0)}%)` : "";
            lines.push(`  ${f.path}  ${f.content.length.toLocaleString()} chars${pct}  ${est(f.content.length)}`);
          });
      }
      lines.push("");

      // ── Guidelines ────────────────────────────────────────────────────────
      const guidelines = opts.promptGuidelines ?? [];
      const totalGuideChars = guidelines.join("\n").length;

      lines.push(
        `▶ Guidelines  (${guidelines.length} bullets, ${totalGuideChars.toLocaleString()} chars, ${est(totalGuideChars)}):`,
      );

      if (guidelines.length === 0) {
        lines.push("  none");
      } else {
        guidelines.forEach((g, i) => {
          lines.push(`  ${i + 1}. ${g.slice(0, 120)}${g.length > 120 ? "…" : ""}`);
        });
      }
      lines.push("");

      // ── Append system prompt ──────────────────────────────────────────────
      if (opts.appendSystemPrompt) {
        const chars = opts.appendSystemPrompt.length;
        lines.push(`▶ Appended system prompt:  ${chars.toLocaleString()} chars  (${est(chars)})`);
        lines.push(`  ${opts.appendSystemPrompt.slice(0, 160)}${opts.appendSystemPrompt.length > 160 ? "…" : ""}`);
        lines.push("");
      }

      // ── Custom prompt ─────────────────────────────────────────────────────
      if (opts.customPrompt) {
        const chars = opts.customPrompt.length;
        lines.push(`▶ Custom system prompt (replaces default):  ${chars.toLocaleString()} chars  (${est(chars)})`);
        lines.push("");
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
  pi.registerTool(makeContextAnalyzerTool(() => pi.getAllTools()));
};

export default extension;
