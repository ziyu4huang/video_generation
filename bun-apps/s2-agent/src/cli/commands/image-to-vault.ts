/**
 * `pipeline image-to-vault <image>` — image → markdown → Zettelkasten vault.
 *
 * This is the image counterpart of `pdf-to-vault`. The `file2md` leaf
 * already accepts images (magic-number sniff → `kind: image`), so this
 * pipeline reuses the SAME two-stage orchestration (file2md → distill)
 * with image-appropriate defaults and labels.
 *
 * Why a separate command and not just "use pdf-to-vault with an image"?
 * Discoverability: `pipeline image-to-vault scan.jpg` is self-documenting in
 * shell history and scripts, whereas `pipeline pdf-to-vault scan.jpg` reads as
 * a mistake. The underlying machinery is identical.
 *
 * The run-dir prefix is still `pdf-to-vault-…` because the orchestrator is
 * shared (pdf-to-vault's `run()`). This is a cosmetic wart, not a functional
 * issue — the pipeline.json inside records the real input kind.
 */
import type { ParsedArgs } from "../args.ts";
import { emptyParsed } from "../args.ts";
import { pdfToVaultCommand } from "./pdf-to-vault.ts";
import { DEFAULT_MODEL_TIER_CONFIG } from "../../pre-load-providers.ts";

export const imageToVaultCommand = {
	name: "image-to-vault",
	summary: "image → markdown → Zettelkasten vault (VLM describe + distill)",
	details: `Usage:
  s2-agent cli pipeline image-to-vault <image> [options]

Runs two stages in sequence (same engine as pdf-to-vault, specialised for images):
  1. file2md  — VLM explains the image → Obsidian markdown page
  2. distill       — decompose the page markdown into atomic Zettelkasten notes

Accepts: png, jpg, jpeg, webp, gif, bmp.

Output (timestamped + slug, re-runs never collide):
  <out>/pdf-to-vault-<YYYYMMDD-HHMMSS>-<slug>/   (shared engine; prefix is cosmetic)
    pipeline.json              ← status + resume state
    1-pdf-to-md/<slug>/…       ← stage 1 output
    2-obsidian-vault/…         ← stage 2 output (openable Obsidian vault)

Resume: re-run with the same <out> and input image to reuse the run dir.

Options:
  --out <dir>            pipeline root (default: ./tmp)
  --vlm-model <id>       stage 1 model (default: ${DEFAULT_MODEL_TIER_CONFIG.capabilities.vision} — the baked §3 vision lane)
  --model <id>           stage 2 (distill) model — global flag; defaults to CLI default
  --retries <n>          VLM retries on 429/transient errors (default 3)
  --retry-wait <sec>     seconds to wait between retries (default 10)
  --delete-png           delete the image PNG after distill (default: keep)
  --force-distill        re-run stage 2 even if already done

Examples:
  s2-agent cli pipeline image-to-vault scan.jpg
  s2-agent cli pipeline image-to-vault diagram.png --delete-png
  s2-agent cli pipeline image-to-vault photo.webp --vlm-model lm-studio/google/gemma-4-12b`,

	async run(parsed: ParsedArgs): Promise<void> {
		// Delegate to the shared pdf-to-vault orchestrator. file2md's
		// magic-number sniff detects the image kind automatically; no --type
		// force is needed (the classifier would run on the image directly).
		const delegated: ParsedArgs = {
			...emptyParsed(),
			...parsed,
			// Ensure stage-1 model / output flags flow through.
			positionals: parsed.positionals,
			out: parsed.out,
			vlmModel: parsed.vlmModel,
			model: parsed.model,
			retries: parsed.retries,
			retryWaitSec: parsed.retryWaitSec,
			deletePng: parsed.deletePng,
			forceDistill: parsed.forceDistill,
			mode: parsed.mode,
			verbose: parsed.verbose,
		};
		await pdfToVaultCommand.run(delegated);
	},
};
