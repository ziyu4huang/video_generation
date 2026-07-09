/**
 * `vlm-describe <inputs...>` — CLI wrapper.
 *
 * Delegates the full pipeline to the pi-vlm workspace package. The CLI is
 * responsible only for arg parsing and vault env setup; all VLM pipeline logic
 * lives in bun-apps/pi-vlm/src/pipeline.ts.
 */
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { applyVaultEnv } from "../sessions/passthrough.ts";
import { runVlmDescribePipeline, DEFAULT_VLM_MODEL } from "@repo/pi-agent-ext-vlm";
import type { DocProfile } from "@repo/pi-agent-ext-vlm";

export const vlmDescribeCommand = {
	name: "vlm-describe",
	summary: "explain images / PDF pages into Obsidian markdown via a local VLM",
	details: `Usage:
  bun-pi-agent-cli vlm-describe <files...> [options]

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
  --pages <spec>       only process these pages, e.g. "1,3-5" (1-indexed)
  --model <pattern>    provider/id[:thinking]  (default ${DEFAULT_VLM_MODEL})
  --provider <name>    provider name
  --thinking <level>   off|minimal|low|medium|high|xhigh
  --mode json          NDJSON event stream
  --vault <path>       vault path (so ![[wikilinks]] resolve in Obsidian)
  --vault-dir <name>   vault folder name under cwd (default: vault)

Examples:
  bun-pi-agent-cli vlm-describe paper.pdf
  bun-pi-agent-cli vlm-describe paper.pdf --dpi 200 --pages 1-4
  bun-pi-agent-cli vlm-describe scan.jpg --type image
  bun-pi-agent-cli vlm-describe *.pdf --out ./notes --model ${DEFAULT_VLM_MODEL}`,

	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const inputs = parsed.positionals;
		if (inputs.length === 0) {
			throw new Error("No input files given. Usage: vlm-describe <files...>");
		}

		applyVaultEnv(parsed);

		const outRoot = resolve(cwd, parsed.out ?? "vlm-out");
		const jsonMode = parsed.mode === "json";

		await runVlmDescribePipeline({
			inputs: inputs.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))),
			outRoot,
			model: parsed.model ?? process.env.PI_MODEL ?? DEFAULT_VLM_MODEL,
			provider: parsed.provider ?? (parsed.model ? undefined : "lm-studio"),
			thinking: parsed.thinking,
			forcedType: parsed.type as DocProfile | undefined,
			pages: parsed.pages,
			dpi: parsed.dpi ?? 150,
			emit: jsonMode
				? (o) => process.stdout.write(JSON.stringify(o) + "\n")
				: undefined,
		});
	},
};
