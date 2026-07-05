/**
 * `tools-metrics` — measure token cost of each registered tool.
 *
 * Computes two token buckets per tool:
 *   1. **System prompt snippet** — the "Available tools" entry in the system
 *      prompt text (tool name + description + promptSnippet). These are
 *      included in the system prompt text budget.
 *   2. **API schema** — the tool's description + JSON Schema parameters sent in
 *      the `tools[]` array of every API request. These are NOT in the system
 *      prompt text — they are a separate token cost paid per request.
 *
 * The token estimate uses the same ratio as context_analyzer: 3.7 chars/tok.
 * Output modes: table (default) | json | baseline (saves JSON + reports).
 *
 * Usage:
 *   bun-pi-agent-cli tools-metrics                  (table)
 *   bun-pi-agent-cli tools-metrics --json           (JSON to stdout)
 *   bun-pi-agent-cli tools-metrics --baseline       (save + table)
 *   bun-pi-agent-cli tools-metrics --baseline --baseline-out <path>
 */
import type { ParsedArgs } from "../args.ts";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─── Token estimation (same ratio as context_analyzer tool) ───────────────────

const TOKEN_RATIO = 3.7;

function estTok(chars: number): number {
  return Math.round(chars / TOKEN_RATIO);
}

function est(chars: number): string {
  return `~${Math.round(chars / TOKEN_RATIO).toLocaleString()} tok`;
}

// ─── Data types ───────────────────────────────────────────────────────────────

export interface ToolTokenMetrics {
  name: string;
  source: string;
  /** System prompt snippet: the tool's "Available tools" entry chars. */
  snippetChars: number;
  /** API schema: description chars. */
  descChars: number;
  /** API schema: JSON Schema parameters chars. */
  paramsChars: number;
  /** API schema total: descChars + paramsChars. */
  apiChars: number;
  /** System prompt snippet token estimate. */
  snippetTok: number;
  /** API schema token estimate. */
  apiTok: number;
  /** Total token estimate (snippet + api). */
  totalTok: number;
}

export interface ToolsMetricsReport {
  generated: string;
  totalTools: number;
  totalSnippetChars: number;
  totalApiChars: number;
  totalSnippetTok: number;
  totalApiTok: number;
  totalTok: number;
  tools: ToolTokenMetrics[];
}

// ─── Core: measure tools from the session ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function countToolTokens(tools: any[]): ToolsMetricsReport {
  const measured: ToolTokenMetrics[] = tools
    .map((t: any) => {
      const name = String(t?.name ?? "");
      const source = String(t?.source ?? t?.extensionName ?? t?.packageName ?? "(builtin)");
      const desc = String(t?.description ?? "");
      const params = t?.parameters ? JSON.stringify(t.parameters) : "";

      const descChars = desc.length;
      const paramsChars = params.length;
      const apiChars = descChars + paramsChars;

      // System prompt snippet: name + description + promptSnippet (~150 chars per tool)
      const promptSnippet = String(t?.promptSnippet ?? "");
      const snippetChars = name.length + 2 + desc.length + (promptSnippet ? 2 + promptSnippet.length : 0);

      const snippetTok = estTok(snippetChars);
      const apiTok = estTok(apiChars);
      return {
        name,
        source,
        snippetChars,
        descChars,
        paramsChars,
        apiChars,
        snippetTok,
        apiTok,
        totalTok: snippetTok + apiTok,
      };
    })
    .filter((t) => t.name)
    .sort((a, b) => b.totalTok - a.totalTok); // descending by total token cost

  const totalSnippetChars = measured.reduce((s, t) => s + t.snippetChars, 0);
  const totalApiChars = measured.reduce((s, t) => s + t.apiChars, 0);

  return {
    generated: new Date().toISOString(),
    totalTools: measured.length,
    totalSnippetChars,
    totalApiChars,
    totalSnippetTok: estTok(totalSnippetChars),
    totalApiTok: estTok(totalApiChars),
    totalTok: estTok(totalSnippetChars) + estTok(totalApiChars),
    tools: measured,
  };
}

// ─── Output formatters ────────────────────────────────────────────────────────

function printTable(report: ToolsMetricsReport): void {
  console.log(`Tool Token Metrics — ${report.totalTools} tools`);
  console.log(`Generated: ${report.generated}`);
  console.log("");
  console.log(
    "Tool".padEnd(30) +
      "Source".padEnd(14) +
      "Snippet".padStart(9) +
      "API-desc".padStart(10) +
      "API-params".padStart(12) +
      "API-tot".padStart(9) +
      "Est Tok".padStart(9),
  );
  console.log("-".repeat(93));

  for (const t of report.tools) {
    console.log(
      t.name.slice(0, 29).padEnd(30) +
        t.source.slice(0, 13).padEnd(14) +
        est(t.snippetChars).padStart(9) +
        est(t.descChars).padStart(10) +
        est(t.paramsChars).padStart(12) +
        est(t.apiChars).padStart(9) +
        t.totalTok.toLocaleString().padStart(9),
    );
  }

  console.log("-".repeat(93));
  console.log(
    "TOTAL".padEnd(30) +
      "".padEnd(14) +
      est(report.totalSnippetChars).padStart(9) +
      "".padStart(10) +
      "".padStart(12) +
      est(report.totalApiChars).padStart(9) +
      report.totalTok.toLocaleString().padStart(9),
  );
  console.log("");
  console.log(`System prompt snippets: ${report.totalSnippetTok.toLocaleString()} tok  (tools listed in system prompt)`);
  console.log(`API tools schema:       ${report.totalApiTok.toLocaleString()} tok  (tools[] array per request)`);
  console.log(`Combined total:         ${report.totalTok.toLocaleString()} tok`);
}

function printJson(report: ToolsMetricsReport): void {
  console.log(JSON.stringify(report, null, 2));
}

const DEFAULT_BASELINE_PATH = "tool-metrics-baseline.json";

// ─── Command ──────────────────────────────────────────────────────────────────

/**
 * Load extension factories from run-dir manifest paths.
 * Each entry in the manifest's "extensions" array is resolved relative to
 * bun-apps/ in the repo root. Returns an array of imported module objects.
 */
async function loadManifestExtensions(): Promise<unknown[]> {
  // Find repo root: walk up from cwd to find bun-apps/
  let dir = resolve(process.cwd());
  let repoRoot = "";
  for (;;) {
    if (existsSync(resolve(dir, "bun-apps"))) {
      repoRoot = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }

  const manifestPath = resolve(repoRoot, "bun-apps", "pi-agent", "run-dir", "manifest.json");
  if (!existsSync(manifestPath)) return [];

  let manifest: { extensions?: string[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }

  const factories: unknown[] = [];
  for (const rel of manifest.extensions ?? []) {
    const absPath = resolve(repoRoot, "bun-apps", rel);
    if (!existsSync(absPath)) {
      // Check if it's a TypeScript file that may not exist on disk (bundled in)
      if (!absPath.endsWith(".ts")) continue;
    }
    try {
      // Dynamic import of extension factories — each extension exports a default
      // factory function or a named export.
      const mod = await import(absPath);
      const factory = mod.default ?? mod.extensionFactory ?? mod;
      if (typeof factory === "function") {
        factories.push(factory);
      }
    } catch (e: any) {
      console.error(`Warning: failed to import extension ${rel}: ${e?.message ?? String(e)}`);
    }
  }
  return factories;
}

export const toolsMetricsCommand = {
  name: "tools-metrics",
  summary: "meta: measure token cost of each registered tool",
  details: `Usage:
  bun-pi-agent-cli tools-metrics [--json] [--baseline] [--baseline-out <path>]
                             [--full] [-e <extension-path>...]

Measures the token cost of every registered tool:
  • System prompt snippet — tool name + description in the "Available tools" list
  • API schema — description + JSON Schema parameters in the tools[] array

Output modes:
  table      Default — pretty-printed table sorted by cost (descending)
  --json     Machine-readable JSON to stdout
  --baseline Save JSON to tool-metrics-baseline.json (or --baseline-out path)
             and also print the table.

Extension loading:
  --full     Load all extensions from the run-dir manifest (full baseline)
  -e <path>  Load a specific extension (repeatable for multiple)

Estimation uses 3.7 chars/tok (same as context_analyzer tool).`,
  async run(parsed: ParsedArgs): Promise<void> {
    const json = parsed.rest.includes("--json");
    const baseline = parsed.rest.includes("--baseline");
    const full = parsed.rest.includes("--full");

    let baselineOut = DEFAULT_BASELINE_PATH;
    const boIdx = parsed.rest.indexOf("--baseline-out");
    if (boIdx !== -1 && boIdx + 1 < parsed.rest.length) {
      const val = parsed.rest[boIdx + 1];
      if (val && !val.startsWith("--")) {
        baselineOut = val;
      }
    }

    // Load extra extension factories from -e flags and/or --full manifest.
    const extraFactories: unknown[] = [];
    if (full) {
      const manifestExts = await loadManifestExtensions();
      extraFactories.push(...manifestExts);
    }
    if (parsed.extensionPaths.length > 0) {
      for (const extPath of parsed.extensionPaths) {
        try {
          const mod = await import(extPath);
          const factory = (mod as any).default ?? (mod as any).extensionFactory ?? mod;
          if (typeof factory === "function") {
            extraFactories.push(factory);
          }
        } catch (e: any) {
          console.error(`Warning: failed to import extension ${extPath}: ${e?.message ?? String(e)}`);
        }
      }
    }

    // Load tools via the shared session (same as list-tools).
    const { listRegisteredTools } = await import("../sessions/shared.ts");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: any[];
    try {
      tools = await listRegisteredTools(
        extraFactories.length > 0 ? extraFactories : undefined,
      );
    } catch (e: any) {
      console.error(`Failed to enumerate tools: ${e?.message ?? String(e)}`);
      process.exit(1);
    }

    if (tools.length === 0) {
      console.log("No tools registered.");
      return;
    }

    const report = countToolTokens(tools);

    if (baseline) {
      try {
        mkdirSync(dirname(baselineOut), { recursive: true });
        writeFileSync(baselineOut, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.error(`Baseline saved to ${baselineOut}`);
      } catch (e: any) {
        console.error(`Failed to write baseline: ${e?.message ?? String(e)}`);
        process.exit(1);
      }
    }

    if (json) {
      printJson(report);
    } else {
      printTable(report);
    }
  },
};
