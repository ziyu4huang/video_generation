/**
 * `file2md <inputs...>` — CLI wrapper.
 *
 * Delegates the full pipeline to the pi-file2md workspace package. The CLI is
 * responsible only for arg parsing and vault env setup; all VLM pipeline logic
 * lives in bun-apps/pi-agent-ext-file2md/src/pipeline.ts.
 */
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { applyVaultEnv } from "../sessions/passthrough.ts";
import { runVlmDescribePipeline } from "@repo/pi-agent-ext-file2md";
import type { DocProfile, ExtractStrategy } from "@repo/pi-agent-ext-file2md";

export const file2mdCommand = {
	name: "file2md",
	summary: "explain images / PDF pages into Obsidian markdown via a local VLM",
	details: `Usage:
  pi-agent cli file2md <files...> [options]

Inputs:
  One or more PDF or image files (png/jpg/webp/gif/bmp). Each input maps to
  output/<doc-slug>/ with rasterized page PNGs + per-page Obsidian markdown +
  a manifest.json + a doc-level index note.

Pipeline (per input):
  1. classify kind (pdf | image)            [local, magic-number sniff]
  2. PDF → page PNGs (macOS PDFKit)         [--dpi]
  3. classify profile (paper|slides|...)    [VLM subagent on page 1]
  4. per page: VLM → Obsidian markdown      [frontmatter + ![[png]] + body]
  5. write manifest.json + <slug>.md (MOC)

Options:
  --out <dir>          output root (default: ./vlm-out)
  --dpi <n>            rasterization DPI for PDFs (default 150)
  --type <profile>     force a profile, skip the VLM classifier
                       (paper|slides|poster|diagram|image)
  --extract <mode>     extraction strategy (default vlm = rasterize→VLM):
                       vlm    current path (every page → VLM)
                       text   mupdf text-layer only (fast, no VLM, figures lost)
                       hybrid mupdf text + VLM for figure-bearing pages
  --pages <spec>       only process these pages, e.g. "1,3-5" (1-indexed)
  --model <pattern>    provider/id[:thinking]  (default: model-tiers config, else PI_MODEL env)
  --provider <name>    provider name
  --thinking <level>   off|minimal|low|medium|high|xhigh
  --mode json          NDJSON event stream
  --vault <path>       vault path (so ![[wikilinks]] resolve in Obsidian)
  --vault-dir <name>   vault folder name under cwd (default: vault)

Examples:
  pi-agent cli file2md paper.pdf
  pi-agent cli file2md paper.pdf --dpi 200 --pages 1-4
  pi-agent cli file2md scan.jpg --type image
  pi-agent cli file2md *.pdf --out ./notes`,

	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const inputs = parsed.positionals;
		if (inputs.length === 0) {
			throw new Error("No input files given. Usage: file2md <files...>");
		}

		applyVaultEnv(parsed);

		const outRoot = resolve(cwd, parsed.out ?? "vlm-out");
		const jsonMode = parsed.mode === "json";

		await runVlmDescribePipeline({
			inputs: inputs.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))),
			outRoot,
			model: parsed.model ?? process.env.PI_MODEL,
			provider: parsed.provider ?? (parsed.model ? undefined : "lm-studio"),
			thinking: parsed.thinking,
			forcedType: parsed.type as DocProfile | undefined,
			extract: parsed.extract as ExtractStrategy | undefined,
			pages: parsed.pages,
			dpi: parsed.dpi ?? 150,
			emit: jsonMode
				? (o) => process.stdout.write(JSON.stringify(o) + "\n")
				: undefined,
		});
	},
};
