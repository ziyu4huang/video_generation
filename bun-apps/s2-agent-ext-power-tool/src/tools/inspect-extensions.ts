import {
  type ExtensionContext,
  type ToolInfo,
  defineTool,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolApiCost } from "../cost.js";
import { type Finding, shortPath, summarizeFindings } from "../findings.js";
import { findingsSummaryLine, miniBar, reportHeader, severitySections } from "../report.js";

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

  // ℹ️ no Available-tools snippet — INFORMATIONAL, not an issue. In this repo
  // ALL custom tools are intentionally "stealth" (no promptSnippet): routing is
  // carried by the tool `description` (already in the per-request API tools[]
  // schema) + on-demand `_help` tools, and each extension package locks this in
  // via stealth-trim.test.ts. Snippet absence saves always-on system-prompt
  // tax, so surface as info rather than a defect — mirror of no-guidelines
  // below. Builtins always carry a snippet, so this never fires for them.
  for (const t of tools) {
    if (!t.snippet || t.snippet.trim().length === 0) {
      findings.push({
        severity: "info",
        check: "missing-snippet",
        message: `Tool "${t.name}" has no Available-tools snippet (often intentional — stealth design)`,
        detail: { name: t.name, source: t.sourcePath },
      });
    }
  }

  // 🟡 oversized tool schema (desc + JSON(params)) — repeats on EVERY request
  for (const t of tools) {
    const tok = toolApiCost(t).tokens;
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
    const tok = toolApiCost(t).tokens;
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
    const tok = toolApiCost(t).tokens;
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

/** Render findings as a human-readable severity-ranked report. PURE. */
export function formatExtensionReport(findings: Finding[]): string {
  const lines = reportHeader("Inspect Extensions");
  lines.push(findingsSummaryLine(findings), "");
  lines.push(...severitySections(findings, "No actionable issues — extensions look healthy."));

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

export function makeInspectExtensionsTool(getAllTools: () => ToolInfo[]) {
  return defineTool({
    name: "inspect_extensions",
    gating: { core: true }, // un-gated (ticket 06 HITL): diagnostics always-on
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
      // self_test: analyze the deterministic fixture instead of the live context, so
      // the tool is exercisable with no session — matching every sibling inspect_*.
      // The fixture carries its own deliberately-low thresholds; the params ones
      // describe live data and would make it find nothing.
      const input = params.self_test
        ? SELF_TEST_ANALYSIS_INPUT
        : deriveAnalysisInput(_ctx as ExtensionContext, getAllTools(), {
            toolTokenThreshold: params.tool_token_threshold ?? 1500,
            skillCharThreshold: params.skill_char_threshold ?? 2000,
            contextFileCharThreshold: params.context_file_char_threshold ?? 20000,
          });
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
      const report = formatExtensionReport(findings);
      return {
        content: [
          { type: "text" as const, text: params.self_test ? `self_test: true\n\n${report}` : report },
        ],
        details: null,
      };
    },
  });
}

/** Thresholds an AnalysisInput carries alongside its data. */
type Thresholds = Pick<
  AnalysisInput,
  "toolTokenThreshold" | "skillCharThreshold" | "contextFileCharThreshold"
>;

/**
 * Project the live extension context into the pure analyzer's input. The only part
 * of this tool that touches the SDK — kept out of execute() so the self_test path
 * never reaches for a session that may not exist.
 */
function deriveAnalysisInput(
  ctx: ExtensionContext,
  allTools: ToolInfo[],
  thresholds: Thresholds,
): AnalysisInput {
  const opts = ctx.getSystemPromptOptions();
  const snippets = (opts.toolSnippets ?? {}) as Record<string, string>;
  const selectedSet = new Set<string>((opts.selectedTools as string[] | undefined) ?? []);
  const activeTools = allTools.filter((t) => selectedSet.size === 0 || selectedSet.has(t.name));
  // Lazy/inactive tools: registered (getAllTools) but NOT in the active
  // selection (opts.selectedTools) → not in the per-request tools[] array,
  // costing 0 tok now. Surfaced as lazy-loaded-extension findings.
  const inactiveRaw = selectedSet.size === 0 ? [] : allTools.filter((t) => !selectedSet.has(t.name));

  const toAnalysis = (t: ToolInfo): AnalysisTool => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.parameters,
    promptGuidelines: t.promptGuidelines,
    sourcePath: t.sourceInfo?.path ?? "(unknown)",
    source: t.sourceInfo?.source ?? "unknown",
    snippet: snippets[t.name],
  });

  return {
    tools: activeTools.map(toAnalysis),
    inactiveTools: inactiveRaw.map(toAnalysis),
    skills: ((opts.skills as unknown[]) ?? []).map((s: any) => ({
      name: s.name as string,
      filePath: (s.filePath as string) ?? "",
      formattedChars: formatSkillsForPrompt([s]).length,
    })),
    contextFiles: ((opts.contextFiles as { path: string; content: string }[]) ?? []).map((f) => ({
      path: f.path,
      chars: f.content.length,
    })),
    ...thresholds,
  };
}
