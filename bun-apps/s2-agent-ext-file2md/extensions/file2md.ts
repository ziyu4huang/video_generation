import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { findWorkspaceRoot, missingExtDeps } from "@repo/s2-agent-core-runtime";
import { Type } from "typebox";

// ─── Gate family (wayfinder ticket 01 — reference form) ─────────────────────
// Declared ONCE by id; file2md + vision_ask both reference it via
// `gating: { gate: "file2md" }` so buildEffectiveGates groups them into one
// co-firing family gate (names[0] === "file2md"). The former per-tool verbatim
// duplication is gone — edit the family here, both tools follow.
GATE_DEFS.file2md = {
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

// Capture extension dir at module init WITHOUT import.meta.* — the deploy
// tree bundles to ext.cjs where import.meta bakes the build-machine path
// (ADR-file2md-0001 relocatability). Specifier-based: the loader serves
// `#pi/ext-dir` in the deploy tree; the dev tree resolves the workspace
// self-link via bun's global require.
const _EXT_DIR: string | undefined = (() => {
  try {
    // Two spellings by mode (same unwrap as obsidian's shExtDir / archify's
    // shExtDir): the sh loader's injected require serves the deployed ext dir
    // as a BARE STRING; the dev tree resolves package.json's "#pi/ext-dir"
    // imports entry (src/sh-ext-dir.ts), which jiti interop hands back as a
    // namespace object `{ default: <pkg root> }`. Taking the object as the
    // dir made missingExtDeps' join() throw "paths[0] … got object" at every
    // source-mode session_start (measured 2026-08-27).
    const mod = require("#pi/ext-dir") as { default?: unknown } | string;
    if (typeof mod === "string") return mod;
    if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
      return mod.default;
    }
  } catch {
    /* dev tree without the imports entry — fall through */
  }
  const SELF = "@repo/s2-agent-ext-file2md/package.json";
  try {
    return dirname(require.resolve(SELF));
  } catch {}
  return undefined;
})();

// ---------------------------------------------------------------------------
// pi:knowledge opt-in emit (tier rule: NO hub import)
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
// `gating` object). Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts.
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
  // Self-gate: BUN_PI_FILE2MD=0 disables the entire extension — the portable
  // base-set contract (every registered extension honors its disable env).
  if (process.env.BUN_PI_FILE2MD === "0") return;
  pi.on("session_start", async (_event, ctx) => {
    const missing = missingExtDeps(["@earendil-works/pi-coding-agent"], _EXT_DIR);
    if (missing.length > 0) {
      const root = findWorkspaceRoot(_EXT_DIR);
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
    label: "File → Markdown",
    description:
      "Convert a PDF / image / docx / xlsx / pptx / ipynb / text file to structured Markdown that a text-only " +
      "agent can read. Text-first (pure-TS text layer + bounded office extraction), vendored tesseract-wasm OCR " +
      "for scans, optional vision (LM Studio) for images/scanned pages. Writes pages/*.md + manifest + index note.",
    parameters: Type.Object({
      input: Type.String({ description: "Absolute or relative path to a PDF/image/document file" }),
      out: Type.Optional(Type.String({ description: "Output root directory (default: ./vlm-out)" })),
      model: Type.Optional(
        Type.String({
          description:
            "VLM model in provider/id format (default: the vision tier config). Honors the PI_MODEL env var when omitted.",
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
      mode: Type.Optional(
        StringEnum(["auto", "text", "ocr", "vlm", "smart"] as const, {
          description:
            "Pipeline mode: auto (default, text layer + OCR for scans) | text (text layer only) | ocr (force OCR on thin pages) | vlm (vision-LLM describes thin pages; OCR degrades) | smart (adaptive: text → OCR when thin → vision-enhanced figure pages; skip notice when no vision server).",
        }),
      ),
      pages: Type.Optional(
        Type.String({
          description:
            'Pages to extract (1-indexed). Ranges: "1-3". Individual: "3,5". Mixed: "1,3-5,8". Omit for all pages.',
        }),
      ),
      scale: Type.Optional(Type.Number({ description: "Page raster scale for OCR/vision (default 2 ≈ 144 dpi)" })),
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
      lang: Type.Optional(Type.String({ description: "OCR language + note language hint (default en)." })),
      note: Type.Optional(
        Type.String({
          description: "VLM page-note style: summary | verbatim | hybrid (default hybrid).",
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
      const { runFile2mdPipeline } = await import("../src/pipeline.ts");
      const rawOut = params.out ?? "./vlm-out";
      const outRootAbs = isAbsolute(rawOut) ? rawOut : resolve(process.cwd(), rawOut);
      const slug = basename(params.input)
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .toLowerCase();
      const relpath = params.relpath ?? false;

      await runFile2mdPipeline({
        inputs: [params.input],
        outRoot: outRootAbs,
        // Honor PI_MODEL like the CLI (file2md.ts) so a global VLM override
        // applies to the tool too, not just the CLI.
        model: params.model ?? process.env.PI_MODEL,
        provider: params.provider,
        thinking: params.thinking,
        forcedType: params.type as any,
        mode: params.mode as any,
        pages: params.pages,
        scale: params.scale,
        relpath,
        concurrency: params.concurrency,
        lang: params.lang,
        note: params.note as any,
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
      const { resolveVisionLLM } = await import("../src/sessions.ts");

      const imageAbs = isAbsolute(params.image) ? params.image : resolve(process.cwd(), params.image);
      const llm = resolveVisionLLM({
        model: params.model,
        provider: params.provider,
        thinking: params.thinking,
      });

      const r = await askImage(imageAbs, params.question, {
        systemPrompt: params.systemPrompt,
        llm,
        emptyIsError: true,
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
