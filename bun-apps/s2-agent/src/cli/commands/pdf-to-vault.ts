/**
 * `pipeline pdf-to-vault <pdf>` — end-to-end orchestrator.
 *
 * Combines the two leaf agents into one resumable pipeline:
 *
 *   PDF ──[file2md]──▶ markdown pages ──[distill]──▶ Zettelkasten vault
 *
 * Model selection: stage 1 (file2md) needs a dedicated `--vlm-model`
 * because it requires a vision model, which is genuinely different from the
 * text model. Stage 2 (distill) is just another text-LLM turn, so it reuses
 * the global `--model` passthrough (resolved by resolveLLMFromArgs, falling
 * back to the user default when `--model` is absent). There is deliberately
 * NO `--distill-model` flag — it would only duplicate `--model` and risk a
 * silent model fallback.
 *
 * Output layout (timestamped + slug, so re-running never collides):
 *
 *   <out>/pdf-to-vault-<YYYYMMDD-HHMMSS>-<slug>/
 *     pipeline.json                ← coordination layer (status, resume)
 *     1-pdf-to-md/<slug>/…         ← stage 1 (file2md) output
 *     2-obsidian-vault/…           ← stage 2 (distill) output
 *
 * Resume: re-run with the same `<out>` + same input → the orchestrator finds
 * the existing run dir (matched by slug) and skips finished work:
 *   - stage 1: file2md's manifest skips pages with status "done"
 *   - stage 2: skipped if pipeline.json says distill.status === "done"
 *     (override with --force-distill)
 *
 * Error pages: after stage 1, any page still in "error" is retried once more
 * (in addition to the per-page withRetry inside file2md). If pages still
 * fail, the pipeline is marked "partial" and distill proceeds with the pages
 * that succeeded.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { resolve, relative, isAbsolute, basename } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { emptyParsed } from "../args.ts";
import { file2mdCommand } from "./file2md.ts";
import { zkExtractCommand } from "./zk-extract.ts";
import { resolveLLMFromArgs } from "../sessions/passthrough.ts";
import { slugify, loadManifest, type DocLayout, layoutFor } from "@repo/s2-agent-ext-file2md";

/** Defaults. */
const DEFAULT_VLM_MODEL = "lm-studio/google/gemma-4-12b";
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_WAIT_SEC = 10;

/** Compact timestamp: YYYYMMDD-HHMMSS (local). */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ─── pipeline.json schema ────────────────────────────────────────────────

interface StageError {
	pageNumber: number;
	message: string;
	retriesUsed?: number;
}

interface StageState {
	status: "pending" | "running" | "done" | "error" | "skipped";
	outputDir?: string;
	startedAt?: string;
	finishedAt?: string;
}

interface VlmStageState extends StageState {
	model?: string;
	pagesTotal?: number;
	pagesDone?: number;
	errors?: StageError[];
}

interface DistillStageState extends StageState {
	model?: string;
	notesCreated?: number;
	linksAdded?: number;
}

interface PipelineDoc {
	schemaVersion: 1;
	createdAt: string;
	updatedAt: string;
	input: string;
	inputName: string;
	slug: string;
	status: "pending" | "running" | "done" | "partial" | "error";
	options: {
		pages?: string;
		vlmModel: string;
		retries: number;
		retryWaitSec: number;
		deletePng: boolean;
		forceDistill: boolean;
	};
	stages: {
		"file2md": VlmStageState;
		distill: DistillStageState;
	};
}

// ─── helpers ─────────────────────────────────────────────────────────────

const iso = () => new Date().toISOString();

function writePipelineDoc(path: string, doc: PipelineDoc): void {
	doc.updatedAt = iso();
	writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

export function readPipelineDoc(path: string): PipelineDoc | null {
	if (!existsSync(path)) return null;
	try {
		const doc = JSON.parse(readFileSync(path, "utf8")) as PipelineDoc;
		// Backward-compat (D5): migrate the legacy stage key "vlm-describe" →
		// "file2md" so a pipeline.json written before the rename resumes cleanly.
		// New runs write "file2md" directly.
		const stages = doc.stages as unknown as { [k: string]: unknown };
		if (stages["vlm-describe"] && !stages["file2md"]) {
			stages["file2md"] = stages["vlm-describe"];
			delete stages["vlm-describe"];
		}
		return doc;
	} catch {
		return null;
	}
}

/**
 * Find an existing run dir under <out> whose slug matches.
 * Returns the absolute run-dir path, or null if none.
 */
function findExistingRun(outRoot: string, slug: string): string | null {
	if (!existsSync(outRoot)) return null;
	for (const entry of readdirSync(outRoot)) {
		// dir name pattern: pdf-to-vault-<ts>-<slug>
		if (entry.endsWith(`-${slug}`) && entry.startsWith("pdf-to-vault-")) {
			const full = resolve(outRoot, entry);
			if (statSync(full).isDirectory()) return full;
		}
	}
	return null;
}

/** Count PNG + MD files in a stage-1 layout to summarise progress. */
function summarizeVlmStage(
	outRoot: string,
	slug: string,
): {
	layout: DocLayout;
	pagesTotal: number;
	pagesDone: number;
	errors: StageError[];
} | null {
	// layout width may vary; probe for manifest in <slug>/ dir
	const dir = resolve(outRoot, slug);
	if (!existsSync(dir)) return null;
	// find pageCount from a likely manifest (try a wide layout)
	const probe = layoutFor(outRoot, slug, 9999);
	const manifest = loadManifest(probe);
	if (!manifest) return null;
	const layout = layoutFor(outRoot, slug, manifest.pageCount);
	const m = loadManifest(layout) ?? manifest;
	const errors: StageError[] = [];
	let pagesDone = 0;
	for (const p of m.pages) {
		if (p.status === "done") pagesDone++;
		else if (p.status === "error")
			errors.push({ pageNumber: p.page, message: p.error ?? "unknown error" });
	}
	return { layout, pagesTotal: m.pageCount, pagesDone, errors };
}

/** Recursively delete all *.png under a directory. */
function deletePngs(dir: string): number {
	let n = 0;
	if (!existsSync(dir)) return 0;
	const walk = (d: string) => {
		for (const entry of readdirSync(d)) {
			const full = resolve(d, entry);
			const s = statSync(full);
			if (s.isDirectory()) walk(full);
			else if (/\.png$/i.test(entry)) {
				rmSync(full);
				n++;
			}
		}
	};
	walk(dir);
	return n;
}

// ─── orchestrator ────────────────────────────────────────────────────────

export const pdfToVaultCommand = {
	name: "pdf-to-vault",
	summary:
		"PDF → markdown → Zettelkasten vault (resumable end-to-end pipeline)",
	details: `Usage:
  s2-agent cli pipeline pdf-to-vault <pdf> [options]

Runs two stages in sequence:
  1. file2md  — rasterize PDF, VLM explains each page → Obsidian markdown
  2. distill       — decompose the page markdown into atomic Zettelkasten notes

Output (timestamped + slug, re-runs never collide):
  <out>/pdf-to-vault-<YYYYMMDD-HHMMSS>-<slug>/
    pipeline.json              ← status + resume state
    1-pdf-to-md/<slug>/…       ← stage 1 output
    2-obsidian-vault/…         ← stage 2 output (openable Obsidian vault)

Resume:
  Re-run with the same <out> and input PDF. The orchestrator reuses the
  existing run dir: stage 1 skips pages already "done"; stage 2 is skipped
  unless --force-distill.

Options:
  --out <dir>            pipeline root (default: ./tmp)
  --pages <spec>         only process these pages, e.g. "1,3-5"
  --vlm-model <id>       stage 1 model (default: ${DEFAULT_VLM_MODEL})
  --model <id>           stage 2 (distill) model — global flag; defaults to the
                         CLI's default model when omitted (NOT a separate flag)
  --retries <n>          VLM retries on 429/transient errors (default 3)
  --retry-wait <sec>     seconds to wait between retries (default 10)
  --delete-png           delete page PNGs after distill (default: keep)
  --force-distill        re-run stage 2 even if already done

Examples:
  s2-agent cli pipeline pdf-to-vault paper.pdf
  s2-agent cli pipeline pdf-to-vault paper.pdf --pages 1-3   # smoke test
  s2-agent cli pipeline pdf-to-vault paper.pdf --delete-png --retries 5`,

	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const inputs = parsed.positionals;
		if (inputs.length === 0) {
			throw new Error("No input PDF given. Usage: pipeline pdf-to-vault <pdf>");
		}
		const inputAbs = isAbsolute(inputs[0]!)
			? inputs[0]!
			: resolve(cwd, inputs[0]!);
		if (!existsSync(inputAbs)) {
			throw new Error(`Input not found: ${inputs[0]} (resolved: ${inputAbs})`);
		}
		const inputName = basename(inputAbs);
		const slug = slugify(inputName);

		// options
		const outRoot = resolve(cwd, parsed.out ?? "tmp");
		const pages = parsed.pages;
		const vlmModel =
			parsed.vlmModel ?? process.env.PI_VLM_MODEL ?? DEFAULT_VLM_MODEL;
		// Stage 2 (distill) reuses the global --model, with PI_DISTILL_MODEL as a
		// dedicated fallback; resolveLLMFromArgs supplies the CLI default when neither
		// is set. distillModel (raw spec) is passed through to zk-extract; the resolved
		// distillModelLabel is what we record in pipeline.json for auditability.
		const distillModel = parsed.model ?? process.env.PI_DISTILL_MODEL;
		// Resolve the actual stage 2 target (provider/id) the same way zk-extract
		// does, so the log line shows the concrete model instead of "(default)".
		const distillLLM = await resolveLLMFromArgs(parsed);
		const distillModelLabel = `${distillLLM.provider}/${distillLLM.modelId}`;
		const retries = parsed.retries ?? DEFAULT_RETRIES;
		const retryWaitSec = parsed.retryWaitSec ?? DEFAULT_RETRY_WAIT_SEC;
		const deletePng = parsed.deletePng ?? false;
		const forceDistill = parsed.forceDistill ?? false;

		// expose retry config to file2md (which reads env)
		process.env.PI_VLM_RETRIES = String(retries);
		process.env.PI_VLM_RETRY_WAIT_MS = String(retryWaitSec * 1000);

		// --dry-run: print the plan (stages + resolved models + options) and stop
		// before creating the run dir or executing any stage. pdf-to-vault has direct
		// fs writes (pipeline.json, run dir) AND agent-driven writes (distill stage),
		// so dry-run short-circuits at the orchestration level.
		if (parsed.dryRun) {
			console.error("[dry-run] pdf-to-vault — no files written, no stages executed\n");
			console.error(`  input:        ${inputAbs}`);
			console.error(`  out root:     ${outRoot}`);
			console.error(`  pages:        ${pages ?? "(all)"}`);
			console.error(`  stage 1 vlm:  ${vlmModel}`);
			console.error(`  stage 2 dist: ${distillModelLabel}${distillModel ? ` (from ${distillModel})` : " (default)"}`);
			console.error(`  retries:      ${retries} (wait ${retryWaitSec}s)  delete-png: ${deletePng}  force-distill: ${forceDistill}`);
			console.error("\n  would run: STAGE 1 file2md → STAGE 2 zk-extract (distill)");
			return;
		}

		mkdirSync(outRoot, { recursive: true });

		// locate or create the run dir (resume support)
		const existing = findExistingRun(outRoot, slug);
		const isNew = !existing;
		let runDir: string;
		if (isNew) {
			runDir = resolve(outRoot, `pdf-to-vault-${timestamp()}-${slug}`);
			mkdirSync(runDir, { recursive: true });
		} else {
			runDir = existing!;
		}
		const stage1Out = resolve(runDir, "1-pdf-to-md");
		const stage2Out = resolve(runDir, "2-obsidian-vault");
		mkdirSync(stage1Out, { recursive: true });
		mkdirSync(stage2Out, { recursive: true });

		const pipelinePath = resolve(runDir, "pipeline.json");

		// load or init pipeline doc
		const pdoc =
			readPipelineDoc(pipelinePath) ??
			({
				schemaVersion: 1,
				createdAt: iso(),
				updatedAt: iso(),
				input: inputAbs,
				inputName,
				slug,
				status: "running",
				options: {
					pages,
					vlmModel,
					retries,
					retryWaitSec,
					deletePng,
					forceDistill,
				},
				stages: {
					"file2md": { status: "pending" },
					distill: { status: "pending" },
				},
			} satisfies PipelineDoc);

		// refresh options on resume (flags may have changed)
		pdoc.options = {
			pages,
			vlmModel,
			retries,
			retryWaitSec,
			deletePng,
			forceDistill,
		};
		pdoc.status = "running";
		pdoc.stages["file2md"].status =
			pdoc.stages["file2md"].status === "done" ? "done" : "running";
		pdoc.stages["file2md"].startedAt ??= iso();
		pdoc.stages["file2md"].model = vlmModel;
		writePipelineDoc(pipelinePath, pdoc);

		console.error(`pdf-to-vault`);
		console.error(`  run:   ${relative(cwd, runDir) || runDir}`);
		console.error(`  input: ${relative(cwd, inputAbs) || inputAbs}`);
		console.error(`  slug:  ${slug}`);
		console.error(
			`  stage1 model: ${vlmModel}  (retries ${retries}×${retryWaitSec}s)`,
		);
		console.error(
			`  stage2 model: ${distillModelLabel}  (thinking: ${distillLLM.thinkingLevel}${distillModel ? `` : ` — default`})`,
		);
		if (isNew) console.error(`  (new run)`);
		else console.error(`  (resuming existing run)`);
		console.error();

		// ─── STAGE 1: file2md ───────────────────────────────────────────
		console.error(`▶ STAGE 1/2: file2md`);
		const s1: ParsedArgs = {
			...emptyParsed(),
			positionals: [inputAbs],
			out: stage1Out,
			model: vlmModel,
			pages,
			// keep DPI default
		};
		try {
			await file2mdCommand.run(s1);
		} catch (e) {
			pdoc.stages["file2md"].status = "error";
			pdoc.stages["file2md"].finishedAt = iso();
			pdoc.status = "error";
			writePipelineDoc(pipelinePath, pdoc);
			throw e;
		}

		// summarize stage 1 + retry error pages once more
		let summary = summarizeVlmStage(stage1Out, slug);
		if (summary && summary.errors.length > 0) {
			console.error(
				`\n▶ stage 1 extra retry: ${summary.errors.length} error page(s)`,
			);
			const retrySpec = summary.errors.map((e) => e.pageNumber).join(",");
			const s1r: ParsedArgs = {
				...emptyParsed(),
				positionals: [inputAbs],
				out: stage1Out,
				model: vlmModel,
				pages: retrySpec,
			};
			try {
				await file2mdCommand.run(s1r);
			} catch (e) {
				console.error(`  ! extra retry failed: ${(e as Error).message}`);
			}
			summary = summarizeVlmStage(stage1Out, slug);
		}

		const pagesTotal = summary?.pagesTotal ?? 0;
		const pagesDone = summary?.pagesDone ?? 0;
		pdoc.stages["file2md"] = {
			...pdoc.stages["file2md"],
			status:
				pagesDone === pagesTotal ? "done" : pagesDone > 0 ? "done" : "error",
			outputDir: relative(runDir, stage1Out),
			finishedAt: iso(),
			model: vlmModel,
			pagesTotal,
			pagesDone,
			errors: summary?.errors ?? [],
		};
		writePipelineDoc(pipelinePath, pdoc);
		console.error(
			`\n✓ STAGE 1: ${pagesDone}/${pagesTotal} pages` +
				(summary && summary.errors.length
					? ` (${summary.errors.length} still in error)`
					: ""),
		);

		// proceed to distill only if we got at least some pages
		if (pagesDone === 0) {
			pdoc.status = "error";
			writePipelineDoc(pipelinePath, pdoc);
			console.error(`\n✗ no pages succeeded — aborting stage 2`);
			process.exit(1);
		}

		// ─── STAGE 2: distill ───────────────────────────────────────────────
		const skipDistill =
			!forceDistill &&
			pdoc.stages.distill.status === "done" &&
			pdoc.stages.distill.notesCreated !== undefined;

		if (skipDistill) {
			console.error(
				`\n▶ STAGE 2/2: distill (skipped — already done; use --force-distill to redo)`,
			);
			pdoc.stages.distill.status = "skipped";
		} else {
			console.error(`\n▶ STAGE 2/2: distill`);
			pdoc.stages.distill.status = "running";
			pdoc.stages.distill.startedAt ??= iso();
			pdoc.stages.distill.model = distillModelLabel;
			writePipelineDoc(pipelinePath, pdoc);

			// distill reads markdown from the pages dir
			const pagesDir = summary!.layout.pagesDir;
			const s2: ParsedArgs = {
				...emptyParsed(),
				positionals: [pagesDir],
				vault: stage2Out,
				folder: "Zettelkasten",
				model: distillModel,
			};
			try {
				await zkExtractCommand.run(s2);
				// count produced notes
				const zkDir = resolve(stage2Out, "Zettelkasten");
				let notesCreated = 0;
				if (existsSync(zkDir))
					notesCreated = readdirSync(zkDir).filter((f) =>
						f.endsWith(".md"),
					).length;
				// Retry once if the model wrote 0 notes (hallucinated tool execution).
				if (notesCreated === 0) {
					console.error(
						`\n⚠ stage 2 produced 0 notes — retrying with explicit tool-call directive`,
					);
					// Name the tool the session ACTUALLY has. Stage 2 runs through
					// zkExtractCommand, whose allowlist is DISTILL_TOOLS
					// (read / obsidian / obsidian_help) — `obsidian_distill` stopped
					// being a registered tool when pi-obsidian collapsed its 18
					// `obsidian_*` tools into one action-dispatched facade. So this
					// recovery prompt, written to fix hallucinated tool calls, was
					// itself instructing a hallucinated tool call.
					const s2retry: ParsedArgs = {
						...s2,
						appendSystemPrompt: [
							'CRITICAL: Your ONLY valid action is to call the `obsidian` tool with action: "distill" NOW. ' +
								"Do NOT write any text before making the tool call. " +
								"Invoke it immediately as your first action.",
						],
					};
					await zkExtractCommand.run(s2retry);
					notesCreated = existsSync(zkDir)
						? readdirSync(zkDir).filter((f) => f.endsWith(".md")).length
						: 0;
					console.error(`\n  retry stage 2: ${notesCreated} notes`);
				}
				pdoc.stages.distill = {
					status: "done",
					outputDir: relative(runDir, stage2Out),
					startedAt: pdoc.stages.distill.startedAt,
					finishedAt: iso(),
					model: distillModelLabel,
					notesCreated,
					linksAdded: pdoc.stages.distill.linksAdded,
				};
				console.error(`\n✓ STAGE 2: ${notesCreated} notes`);
			} catch (e) {
				pdoc.stages.distill.status = "error";
				pdoc.stages.distill.finishedAt = iso();
				pdoc.status = "error";
				writePipelineDoc(pipelinePath, pdoc);
				throw e;
			}
		}

		// ─── optional PNG cleanup ───────────────────────────────────────────
		if (deletePng) {
			const removed = deletePngs(stage1Out);
			console.error(`\n🗑  deleted ${removed} PNG(s) from stage 1`);
		}

		// ─── finalize ───────────────────────────────────────────────────────
		const vlmErrors = pdoc.stages["file2md"].errors ?? [];
		pdoc.status = vlmErrors.length > 0 ? "partial" : "done";
		writePipelineDoc(pipelinePath, pdoc);

		console.error(`\n━━━ pdf-to-vault ${pdoc.status.toUpperCase()} ━━━`);
		console.error(`  ${runDir}`);
		console.error(
			`  stage 1: ${pdoc.stages["file2md"].pagesDone}/${pagesTotal} pages`,
		);
		console.error(
			`  stage 2: ${pdoc.stages.distill.notesCreated ?? 0} notes` +
				(pdoc.stages.distill.status === "skipped" ? " (skipped)" : ""),
		);
		if (vlmErrors.length) {
			console.error(
				`  ⚠ ${vlmErrors.length} page(s) failed (pipeline marked partial):`,
			);
			for (const e of vlmErrors)
				console.error(`      page ${e.pageNumber}: ${e.message}`);
		}
		console.error(`\n--- pipeline done ---`);
	},
};
