/**
 * pi-file2md — file→Markdown bridge for text-only agents.
 *
 * Registers the `file2md` tool: converts any PDF or image file to structured
 * Markdown that a pure-text agent can read, using a local vision-LLM subagent
 * served by LM Studio.
 *
 * Pipeline (same as the `pi-agent cli file2md` command):
 *   1. Classify kind (pdf | image)           [local, magic bytes]
 *   2. PDF → page PNGs via macOS PDFKit      [--dpi]
 *   3. Classify profile (paper|slides|...)   [VLM on page 1]
 *   4. Per page: VLM → Obsidian markdown     [frontmatter + ![[png]] + body]
 *   5. Write manifest.json + <slug>.md (MOC)
 *
 * Env:
 *   PI_MODEL         Override model (default: lm-studio/google/gemma-4-12b)
 *   PI_VLM_RETRIES   Per-page retry count (default 3)
 *   PI_VLM_RETRY_WAIT_MS  Wait between retries in ms (default 10000)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";

// ─── Gate family (wayfinder ticket 01 — reference form) ─────────────────────
// Declared ONCE by id; file2md + vision_ask both reference it via
// `gating: { gate: "file2md" }` so buildEffectiveGates groups them into one
// co-firing family gate (names[0] === "file2md"). The former per-tool verbatim
// duplication is gone — edit the family here, both tools follow.
GATE_DEFS["file2md"] = {
  id: "file2md",
  keywords: [
    "file2md",
    "vlm",
    "ocr",
    "caption",
    "to markdown",
    "轉 markdown",
    "read this image",
    "分析圖片",
    "分析圖像",
    "識別",
    "讀圖",
    "看圖",
  ],
  requires: {
    nouns: ["pdf", "document", "文件", "scan", "image", "picture", "photo", "圖片", "圖像", "照片", "相片"],
    verbs: ["read", "convert", "parse", "extract", "ocr", "describe", "caption", "讀", "轉", "解析", "分析"],
  },
  description: "File/vision → Markdown conversion",
};

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

export function missingDeps(deps: string[], from: string | undefined): string[] {
  if (!from) return [];
  // Compiled-binary mode: `from` is a $bunfs/~BUN virtual path — deps are
  // inlined into the binary at build time, and walking the REAL filesystem up
  // from a virtual path can never find node_modules (always false-alarms).
  if (from.includes("$bunfs") || from.includes("~BUN") || from.includes("%7EBUN")) return [];
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
// pi:knowledge opt-in emit (ADR-0001: NO hub import)
// ---------------------------------------------------------------------------
// When `knowledge:true`, file2md emits on the "pi:knowledge" bus so the
// knowledge-card hub can converge the conversion into the shared graph. The
// channel name + payload shape are hardcoded HERE (not imported from the hub)
// to preserve the TIER-0 no-upward-edge invariant.
const KNOWLEDGE_CHANNEL = "pi:knowledge";

export interface File2mdKnowledgeEmission {
  source: "generic";
  sourceLabel: string;
  dir: string;
}

/** Build the bus payload for a conversion's output directory. Pure. */
export function buildFile2mdEmission(slug: string, dirAbs: string): File2mdKnowledgeEmission {
  return { source: "generic", sourceLabel: `file2md:${slug}`, dir: dirAbs };
}

/** Fire-and-forget emit on pi:knowledge. Best-effort: a missing/throwing bus
 *  MUST never break the conversion. */
export function emitFile2mdKnowledge(pi: ExtensionAPI, payload: File2mdKnowledgeEmission): void {
  try {
    (pi as { events?: { emit?: (c: string, d: unknown) => void } }).events?.emit?.(KNOWLEDGE_CHANNEL, payload);
  } catch {
    // swallow — never break the conversion over a knowledge emission
  }
}

// ---------------------------------------------------------------------------
// Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime
// `gating` object). Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts.
// Plain object: no `satisfies` / type import, so this extension never depends
// on tool-gate (avoids a circular dep); shape is enforced by tool-gate's
// drift-guard test.
//   - controls[]  carry a current keyword / satisfy requires → MUST fire.
//   - adversarial[] are keyword-free "I need this tool" phrasings → should fire
//     via the noun∧verb `requires` co-occurrence path.
// ---------------------------------------------------------------------------
export const __GATE_PROBES__ = {
  gate: "file2md",
  recallFloor: 0.9,
  adversarial: ["extract the text from this PDF", "parse the scanned document", "把這份文件讀成文字"],
  controls: ["ocr this image", "convert the pdf to markdown", "用 file2md 分析圖片"],
};

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const missing = missingDeps(["@earendil-works/pi-coding-agent"], _EXT_DIR);
    if (missing.length > 0) {
      const root = findMonorepoRoot(_EXT_DIR);
      ctx.ui.notify(`pi-file2md: missing npm packages: ${missing.join(", ")}.\nRun: bun install (in ${root})`, "error");
      return;
    }
  });

  pi.registerTool({
    name: "file2md",
    // Owner-declared gating — reference form (wayfinder ticket 01): family
    // declared once in GATE_DEFS["file2md"] above; file2md + vision_ask
    // reference it so buildEffectiveGates groups them into one co-firing gate
    // (names[0] === "file2md") — preserving the original co-fire behavior.
    gating: { gate: "file2md" },
    label: "File → Markdown (VLM)",
    description:
      "Convert a PDF or image file to structured Markdown that a text-only agent can read, " +
      "using a local vision-LLM subagent (LM Studio). Runs the full pipeline: classify kind → " +
      "rasterize PDF pages → classify profile → per-page VLM extraction → write manifest + index note.",
    parameters: Type.Object({
      input: Type.String({ description: "Absolute or relative path to a PDF or image file" }),
      out: Type.Optional(Type.String({ description: "Output root directory (default: ./vlm-out)" })),
      model: Type.Optional(
        Type.String({
          description:
            "VLM model in provider/id format (default: lm-studio/google/gemma-4-12b). Honors the PI_MODEL env var when omitted.",
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
          description: "Thinking level: off|minimal|low|medium|high|xhigh. Mirrors the CLI --thinking flag.",
        }),
      ),
      type: Type.Optional(
        Type.String({
          description: "Force document profile: paper | slides | poster | diagram | image",
        }),
      ),
      extract: Type.Optional(
        StringEnum(["vlm", "text", "hybrid"] as const, {
          description:
            "Extraction strategy: vlm (default, rasterize→VLM) | text (mupdf text-layer, no VLM, figures lost) | hybrid (mupdf text + VLM for figure-bearing pages).",
        }),
      ),
      pages: Type.Optional(
        Type.String({
          description:
            'Pages to extract (1-indexed). Ranges: "1-3". Individual: "3,5". Mixed: "1,3-5,8". Omit for all pages.',
        }),
      ),
      dpi: Type.Optional(Type.Number({ description: "Rasterization DPI for PDFs (default 150)" })),
      relpath: Type.Optional(
        Type.Boolean({
          description: "When true, display output paths as relative to cwd. Default false (absolute paths).",
        }),
      ),
      concurrency: Type.Optional(
        Type.Number({
          description:
            "Max concurrent page extractions (default 1; env PI_VLM_CONCURRENCY). >1 runs pages in parallel but disables cross-page context.",
        }),
      ),
      lang: Type.Optional(Type.String({ description: "Output language for the notes (default zh-TW)." })),
      mode: Type.Optional(
        Type.String({
          description: "Processing mode: summary | verbatim | hybrid (default hybrid).",
        }),
      ),
      knowledge: Type.Optional(
        Type.Boolean({
          description:
            "When true, emit this conversion on the pi:knowledge bus for the knowledge-card " +
            "hub to converge into the shared graph (deterministic generic ingest). Default false " +
            "(opt-in; protects graph quality).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { resolve, isAbsolute, basename } = await import("node:path");
      const { runVlmDescribePipeline } = await import("../src/pipeline.ts");
      const rawOut = params.out ?? "./vlm-out";
      const outRootAbs = isAbsolute(rawOut) ? rawOut : resolve(process.cwd(), rawOut);
      const slug = basename(params.input)
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .toLowerCase();
      const relpath = params.relpath ?? false;

      await runVlmDescribePipeline({
        inputs: [params.input],
        outRoot: outRootAbs,
        // Honor PI_MODEL like the CLI (file2md.ts) so a global VLM override
        // applies to the tool too, not just the CLI.
        model: params.model ?? process.env.PI_MODEL,
        provider: params.provider,
        thinking: params.thinking,
        forcedType: params.type as any,
        extract: params.extract,
        pages: params.pages,
        dpi: params.dpi,
        relpath,
        concurrency: params.concurrency,
        lang: params.lang,
        mode: params.mode as any,
      });

      if (params.knowledge) {
        emitFile2mdKnowledge(pi, buildFile2mdEmission(slug, resolve(outRootAbs, slug)));
      }

      const { relative } = await import("node:path");
      const displayOut = relpath ? relative(process.cwd(), outRootAbs) || outRootAbs : outRootAbs;
      return {
        content: [
          {
            type: "text" as const,
            text: `file2md complete. Output: ${displayOut}/${slug}`,
          },
        ],
        details: { input: params.input, out: outRootAbs },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // vision_ask — lightweight single-image vision-LLM Q&A (no disk pipeline).
  // Wraps the flux2-proven askImage() primitive so the agent can interrogate
  // one image inline without launching the full file2md pipeline.
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "vision_ask",
    // Owner-declared gating — reference form: same GATE_DEFS["file2md"] family
    // as file2md, so the two co-fire as one group (ticket 01).
    gating: { gate: "file2md" },
    label: "Vision Image Q&A",
    description:
      "Ask one question about one image via a local vision-LLM subagent and get the answer inline (text). " +
      "Lightweight single-image query — does NOT run the full file2md pipeline and does NOT write to disk. " +
      "Use for ad-hoc image questions (verifying content, reading text in an image, picking between candidates).",
    parameters: Type.Object({
      image: Type.String({ description: "Absolute or relative path to an image file" }),
      question: Type.String({
        description: "The question or instruction for the VLM about the image",
      }),
      systemPrompt: Type.Optional(Type.String({ description: 'Optional system prompt (e.g. "answer in one line")' })),
      model: Type.Optional(
        Type.String({
          description: "VLM model in provider/id format. Honors the PI_MODEL env var when omitted.",
        }),
      ),
      provider: Type.Optional(
        Type.String({
          description: "Provider name (e.g. lm-studio). Inferred from the model string when omitted.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: "Thinking level: off|minimal|low|medium|high|xhigh",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { resolve, isAbsolute } = await import("node:path");
      const { askImage } = await import("../src/vlm/ask.ts");
      const { resolveLLM } = await import("../src/sessions.ts");

      const imageAbs = isAbsolute(params.image) ? params.image : resolve(process.cwd(), params.image);
      const llm = resolveLLM({
        model: params.model,
        provider: params.provider,
        thinking: params.thinking,
      });

      const r = await askImage(imageAbs, params.question, {
        systemPrompt: params.systemPrompt,
        llm,
      });

      if (!r.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `vision_ask failed: ${r.error}` }],
          details: { image: imageAbs, error: r.error },
        };
      }
      return {
        content: [{ type: "text" as const, text: r.reply }],
        details: { image: imageAbs, reply: r.reply },
      };
    },
  });
}
