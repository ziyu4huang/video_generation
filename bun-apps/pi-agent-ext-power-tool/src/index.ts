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

function estTok(chars: number): number {
  return Math.round(chars / 3.7);
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
