/**
 * `file2md <inputs...>` — CLI wrapper.
 *
 * Delegates the full v2 pipeline to the pi-file2md workspace package. The CLI is
 * responsible only for arg parsing and vault env setup; all extraction/OCR/
 * vision logic lives in bun-apps/s2-agent-ext-file2md/src/pipeline.ts.
 */
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { applyVaultEnv } from "../vault-paths.ts";
import { runFile2mdPipeline } from "@repo/s2-agent-ext-file2md";
import type { DocProfile, File2mdMode, PageNoteStyle } from "@repo/s2-agent-ext-file2md";

export const file2mdCommand = {
	name: "file2md",
	summary: "convert PDF / image / office files to structured markdown (bun-only, local)",
	details: `Usage:
  s2-agent cli file2md <files...> [options]

Inputs:
  PDF, image (png/jpg/webp/gif/bmp), docx, xlsx, pptx, ipynb, txt/md/csv/html.
  Each input maps to output/<doc-slug>/ with per-page markdown (pdf/image),
  a manifest.json and a doc-level index note (office/text formats write the
  converted markdown as <slug>.md directly).

Pipeline (per input):
  1. sniff kind                        [local, magic bytes + zip family]
  2. extract text                      [pdfjs text layer / bounded office windows]
  3. thin pages → pdfium raster → OCR (vendored tesseract wasm, offline)
  4. mode vlm: vision-LLM describes images/scans (LM Studio, optional)
  5. mode smart: adaptive per page — text when usable, OCR when thin,
     figure pages vision-enhanced (skip notice when no vision server)

Options:
  --out <dir>          output root (default: ./vlm-out)
  --scale <n>          page raster scale for OCR/vision (default 2 ≈ 144dpi)
  --type <profile>     force a profile, skip the VLM classifier
                       (paper|slides|poster|diagram|image)
  --extract <mode>     pipeline mode (default auto; auto|text|ocr|vlm|smart):
                       auto/text  text layer only, no OCR/vision
                       ocr        text layer + OCR for scanned pages
                       vlm        vision-LLM describes scans; OCR degrades
                       smart      text → OCR when thin → figure pages
                                  vision-enhanced (skip notice w/o server)
  --note <style>       VLM page-note style: summary|verbatim|hybrid (default hybrid)
  --lang <lang>        OCR language: en|chi_sim|en+chi_sim (default en)
  --pages <spec>       only process these pages, e.g. "1,3-5" (1-indexed)
  --model <pattern>    provider/id[:thinking]  (default: model-tiers config, else PI_MODEL env)
  --provider <name>    provider name
  --thinking <level>   off|minimal|low|medium|high|xhigh
  --mode json          NDJSON event stream
  --vault <path>       vault path (so ![[wikilinks]] resolve in Obsidian)
  --vault-dir <name>   vault folder name under cwd (default: vault)

Examples:
  s2-agent cli file2md paper.pdf
  s2-agent cli file2md scan.jpg --extract vlm --scale 3 --pages 1-4
  s2-agent cli file2md spec.pdf --extract smart --scale 3
  s2-agent cli file2md workbook.xlsx --out ./notes`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const inputs = parsed.positionals;
		if (inputs.length === 0) {
			throw new Error("No input files given. Usage: file2md <files...>");
		}

		applyVaultEnv(parsed);

		const outRoot = resolve(cwd, parsed.out ?? "vlm-out");
		const jsonMode = parsed.mode === "json";

		await runFile2mdPipeline({
			inputs: inputs.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))),
			outRoot,
			model: parsed.model ?? process.env.PI_MODEL,
			provider: parsed.provider ?? (parsed.model ? undefined : "lm-studio"),
			thinking: parsed.thinking,
			forcedType: parsed.type as DocProfile | undefined,
			mode: parsed.extract as File2mdMode | undefined,
			note: parsed.note as PageNoteStyle | undefined,
			lang: parsed.lang,
			pages: parsed.pages,
			scale: parsed.scale ?? 2,
			emit: jsonMode
				? (o) => process.stdout.write(JSON.stringify(o) + "\n")
				: undefined,
		});
	},
};
