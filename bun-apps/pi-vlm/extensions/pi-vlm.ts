/**
 * pi-vlm — VLM document describer as a pi extension.
 *
 * Registers the `vlm_describe` tool: converts PDF or image files to structured
 * Obsidian markdown using a local Vision Language Model served by LM Studio.
 *
 * Pipeline (same as the bun-pi-agent-cli vlm-describe command):
 *   1. Classify kind (pdf | image)           [local, magic bytes]
 *   2. PDF → page PNGs via macOS PDFKit      [--dpi]
 *   3. Classify profile (paper|slides|...)   [VLM on page 1]
 *   4. Per page: VLM → Obsidian markdown     [frontmatter + ![[png]] + body]
 *   5. Write manifest.json + <slug>.md (MOC)
 *
 * Env:
 *   PI_MODEL         Override model (default: lm-studio/google/gemma-4-26b-a4b-qat)
 *   PI_VLM_RETRIES   Per-page retry count (default 3)
 *   PI_VLM_RETRY_WAIT_MS  Wait between retries in ms (default 10000)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Capture extension dir at module init. import.meta.dir is Bun-specific and may
// be undefined when loaded via non-standard mechanisms; fall back to import.meta.url.
const _EXT_DIR: string | undefined = (() => {
  try {
    const metaDir = (import.meta as any).dir;
    if (typeof metaDir === "string" && metaDir) return metaDir;
    if (typeof import.meta.url === "string") return dirname(fileURLToPath(import.meta.url));
  } catch {}
  return undefined;
})();

// ---------------------------------------------------------------------------
// Dependency detection helpers
// ---------------------------------------------------------------------------

function findMonorepoRoot(from: string | undefined): string {
  if (!from) return "(repo root)";
  let dir = from;
  while (dir !== dirname(dir)) {
    try {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.workspaces) return dir;
      }
    } catch {}
    dir = dirname(dir);
  }
  return "(repo root)";
}

function pkgBaseName(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split("/")[0];
}

function missingDeps(deps: string[], from: string | undefined): string[] {
  if (!from) return [];
  return deps.filter((dep) => {
    const pkgName = pkgBaseName(dep);
    let dir = from;
    while (true) {
      if (existsSync(join(dir, "node_modules", pkgName, "package.json"))) return false;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const missing = missingDeps(["@earendil-works/pi-coding-agent"], _EXT_DIR);
    if (missing.length > 0) {
      const root = findMonorepoRoot(_EXT_DIR);
      ctx.ui.notify(
        `pi-vlm: missing npm packages: ${missing.join(", ")}.\nRun: bun install (in ${root})`,
        "error",
      );
      return;
    }
  });

  pi.registerTool({
    name: "vlm_describe",
    label: "VLM Document Describer",
    description:
      "Convert a PDF or image file to structured Obsidian markdown using a local LM Studio VLM. " +
      "Runs the full pipeline: classify kind → rasterize PDF pages → classify profile → " +
      "per-page VLM extraction → write manifest + MOC index note.",
    promptSnippet: "Convert a PDF/image to structured Obsidian markdown via local VLM",
    parameters: Type.Object({
      input: Type.String({ description: "Absolute or relative path to a PDF or image file" }),
      out: Type.Optional(
        Type.String({ description: "Output root directory (default: ./vlm-out)" }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "VLM model in provider/id format (default: lm-studio/google/gemma-4-26b-a4b-qat). Honors the PI_MODEL env var when omitted.",
        }),
      ),
      provider: Type.Optional(
        Type.String({
          description:
            "Provider name (e.g. lm-studio, anthropic). Inferred from the model string when omitted. Mirrors the CLI --provider flag.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "Thinking level: off|minimal|low|medium|high|xhigh. Mirrors the CLI --thinking flag.",
        }),
      ),
      type: Type.Optional(
        Type.String({
          description: "Force document profile: paper | slides | poster | diagram | image",
        }),
      ),
      pages: Type.Optional(
        Type.String({
          description:
            'Pages to extract (1-indexed). Ranges: "1-3". Individual: "3,5". Mixed: "1,3-5,8". Omit for all pages.',
        }),
      ),
      dpi: Type.Optional(
        Type.Number({ description: "Rasterization DPI for PDFs (default 150)" }),
      ),
      relpath: Type.Optional(
        Type.Boolean({
          description:
            "When true, display output paths as relative to cwd. Default false (absolute paths).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { resolve, isAbsolute, basename } = await import("node:path");
      const { runVlmDescribePipeline, DEFAULT_VLM_MODEL } = await import("../src/pipeline.ts");
      const rawOut = params.out ?? "./vlm-out";
      const outRootAbs = isAbsolute(rawOut) ? rawOut : resolve(process.cwd(), rawOut);
      const slug = basename(params.input).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
      const relpath = params.relpath ?? false;

      await runVlmDescribePipeline({
        inputs: [params.input],
        outRoot: outRootAbs,
        // Honor PI_MODEL like the CLI (vlm-describe.ts) so a global VLM override
        // applies to the tool too, not just the CLI.
        model: params.model ?? process.env.PI_MODEL ?? DEFAULT_VLM_MODEL,
        provider: params.provider,
        thinking: params.thinking,
        forcedType: params.type as any,
        pages: params.pages,
        dpi: params.dpi,
        relpath,
      });

      const { relative } = await import("node:path");
      const displayOut = relpath ? relative(process.cwd(), outRootAbs) || outRootAbs : outRootAbs;
      return {
        content: [
          {
            type: "text" as const,
            text: `vlm-describe complete. Output: ${displayOut}/${slug}`,
          },
        ],
        details: { input: params.input, out: outRootAbs },
      };
    },
  });
}
