/**
 * `pipeline memory-to-vault` — global + project memory → Zettelkasten.
 *
 * Discovers ~16 memory files → fans out one obsidian-distill agent per file via
 * the workflow engine (concurrency-capped, retried on 429, journaled resume) →
 * deterministic mergeDuplicates + healGraph → receipt + graphHealth snapshot.
 *
 * GATE-0 resolution (findings.md § GATE-0.8a): workflow agents don't inherit
 * the CLI's baked extensions, so the orchestrator captures the obsidian
 * extension's *executable* tools via a stub-`pi` harness and injects them as
 * `WorkflowAgent({ extensionTools })`. Agents call `obsidian({action:"distill"})`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, isAbsolute, join, relative, basename } from "node:path";
import { homedir } from "node:os";
import type { ParsedArgs } from "../args.ts";
import { emptyParsed } from "../args.ts";
import type { MemoryFile } from "./memory-to-vault-discover.ts";
import { discoverMemoryFiles } from "./memory-to-vault-discover.ts";
import { generateWorkflowScript } from "./memory-to-vault-script.ts";
import { runWorkflow, WorkflowAgent } from "@repo/pi-agent-ext-workflow";
import { mergeDuplicates } from "@repo/pi-agent-ext-knowledge-card/src/merge.ts";
import { healGraph, graphHealth } from "@repo/pi-agent-ext-knowledge-card/src/retrieve.ts";
// Subpath import requires pi-agent-ext-obsidian's package.json `exports` map.
import obsidianExtension from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";

// ─── defaults ──────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_DIR = join(homedir(), ".pi", "agent", "pi-hermes-memory");
const DEFAULT_PROJECTS_DIR = join(homedir(), ".pi", "agent", "projects-memory");
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 2;
const DEFAULT_FOLDER = "Zettelkasten/knowledge-graph";
const DEFAULT_THRESHOLD = 0.9;
const MOC_PATH = "Tags/Knowledge Graph.md";
const RECEIPT_DIR = "output/memory-to-vault";

// ─── pipeline.json schema ──────────────────────────────────────────────────
export type StageStatus = "pending" | "running" | "done" | "error" | "skipped" | "partial";

export interface PerFileState {
	path: string;
	status: "pending" | "running" | "done" | "error";
	notesCreated?: number;
	error?: string;
}

export interface MemoryPipelineDoc {
	schemaVersion: 1;
	createdAt: string;
	updatedAt: string;
	status: "pending" | "running" | "done" | "partial" | "error";
	options: { concurrency: number; retries: number; folder: string; threshold: number; model?: string };
	scope: { files: MemoryFile[]; fileCount: number; excluded: number };
	stages: {
		"fan-out"?: { status: StageStatus; startedAt?: string; finishedAt?: string; perFile?: PerFileState[] };
		hygiene?: { status: StageStatus; mergedPairs?: number; deadLinksPruned?: number };
	};
	health?: { cardCount: number; deadLinks: number; mocOk: boolean };
}

const iso = () => new Date().toISOString();

export function writePipelineDoc(path: string, doc: MemoryPipelineDoc): void {
	doc.updatedAt = iso();
	writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

export function readPipelineDoc(path: string): MemoryPipelineDoc | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as MemoryPipelineDoc;
	} catch {
		return null;
	}
}

/** Paths (from scope) that still need distilling: not done, or all if --force. */
export function shouldDistill(doc: MemoryPipelineDoc, force: boolean): string[] {
	const perFile = doc.stages["fan-out"]?.perFile ?? [];
	const done = new Set(perFile.filter((f) => f.status === "done").map((f) => f.path));
	return doc.scope.files.map((f) => f.path).filter((p) => force || !done.has(p));
}

/**
 * Find the newest existing run dir under <outRoot> that has a pipeline.json, so
 * a re-run with the same --out resumes (skips files already done). The dir name
 * embeds a YYYYMMDD-HHMMSS timestamp, so lexical sort = chronological.
 */
export function findExistingRun(outRoot: string): string | null {
	if (!existsSync(outRoot)) return null;
	const candidates = readdirSync(outRoot)
		.filter((e) => e.startsWith("memory-to-vault-"))
		.filter((e) => statSync(join(outRoot, e)).isDirectory())
		.filter((e) => existsSync(join(outRoot, e, "pipeline.json")))
		.sort();
	if (candidates.length === 0) return null;
	return resolve(outRoot, candidates[candidates.length - 1]!);
}

// ─── helpers ───────────────────────────────────────────────────────────────
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function resolveVaultPath(parsed: ParsedArgs, cwd: string): string {
	const explicit = parsed.vault ?? process.env.OB_VAULT_PATH;
	if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
	const dir = parsed.vaultDir ?? "vaults_root/pi-agent-vault";
	let search = cwd;
	for (let i = 0; i < 10; i++) {
		const cand = join(search, dir);
		if (existsSync(cand)) return cand;
		const parent = resolve(search, "..");
		if (parent === search) break;
		search = parent;
	}
	return resolve(cwd, dir);
}

/**
 * Capture an extension factory's *executable* tool definitions by running it
 * against a stub `pi` that records every `registerTool(def)` call. This is the
 * GATE-0 bridge: `WorkflowAgent({extensionTools})` needs executable defs (with
 * `.execute`), but `session.getAllTools()` returns non-executable `ToolInfo`.
 */
export async function captureExtensionTools(
	factories: ((pi: any) => any)[],
): Promise<any[]> {
	const captured: any[] = [];
	const stubPi = new Proxy({} as any, {
		get: (_t: any, prop: string) =>
			prop === "registerTool"
				? (def: any) => { captured.push(def); }
				: () => {},
	});
	for (const f of factories) {
		try {
			const r = f(stubPi);
			if (r && typeof r.then === "function") await r;
		} catch { /* a factory may call pi methods the stub no-ops; ignore */ }
	}
	return captured.filter((d) => d && typeof d.name === "string" && typeof d.execute === "function");
}

// ─── command ───────────────────────────────────────────────────────────────
export const memoryToVaultCommand = {
	name: "memory-to-vault",
	summary: "global + project memory → Zettelkasten (workflow-fanned LLM distill, rate-limit-safe)",
	details: `Usage:
  pi-agent cli pipeline memory-to-vault [options]

Distills pi memory (global hermes + real project MEMORY.md) into the shared
Zettelkasten as atomic, cross-linked cards. Fans out one obsidian-distill agent
per file via the workflow engine (concurrency-capped, retried on 429, journaled
resume), then runs deterministic merge-duplicates + heal-graph.

Options:
  --out <dir>            pipeline root (default ./tmp)
  --memory-dir <path>    global hermes dir (default ~/.pi/agent/pi-hermes-memory)
  --projects-dir <path>  project memory dir (default ~/.pi/agent/projects-memory)
  --only <glob>          restrict projects, e.g. "video_generation__*"
  --files <a,b,c>        explicit file list (overrides discovery)
  --folder <name>        convergence folder (default Zettelkasten/knowledge-graph)
  --vault <path>         absolute vault path (sets OB_VAULT_PATH)
  --concurrency N        max parallel distill agents (default 4)
  --retries N            recoverable-failure retries incl. 429 (default 2)
  --retry-wait <sec>     backoff spacing (default 10)
  --max-notes N          per-file note cap (cost control)
  --model <id>           distill model override
  --threshold <0..1>     merge similarity threshold (default 0.9)
  --verify               run sample zk_ask queries after build
  --force                re-distill files already done
  --dry-run              print plan + file list, write nothing
  --json                 machine-readable output

Examples:
  pi-agent cli pipeline memory-to-vault --dry-run
  pi-agent cli pipeline memory-to-vault --concurrency 2 --retries 4
  pi-agent cli pipeline memory-to-vault --only video_generation__* --verify`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const memoryDir = parsed.memoryDir ?? DEFAULT_MEMORY_DIR;
		const projectsDir = parsed.projectsDir ?? DEFAULT_PROJECTS_DIR;
		const folder = parsed.folder ?? DEFAULT_FOLDER;
		const concurrency = parsed.concurrency ?? DEFAULT_CONCURRENCY;
		const retries = parsed.retries ?? DEFAULT_RETRIES;
		const threshold = parsed.threshold ?? DEFAULT_THRESHOLD;
		const force = parsed.force ?? false;
		const dryRun = parsed.dryRun ?? false;
		const json = parsed.json === true || parsed.mode === "json";

		// 1. SCOPE
		let scope: { files: MemoryFile[]; excluded: number };
		if (parsed.filesCsv) {
			const files = parsed.filesCsv.split(",").map((s) => s.trim()).filter(Boolean)
				.map((p) => ({ path: isAbsolute(p) ? p : resolve(cwd, p), source: `explicit:${basename(p)}` }));
			scope = { files, excluded: 0 };
		} else {
			scope = discoverMemoryFiles({ memoryDir, projectsDir, only: parsed.only });
		}
		if (scope.files.length === 0) {
			console.log(json ? JSON.stringify({ error: "no memory files discovered" }) : "No memory files discovered.");
			return;
		}

		// 2. RUN DIR + VAULT + pipeline.json (resume: reuse an existing run dir)
		const outRoot = resolve(cwd, parsed.out ?? "tmp");
		const existing = dryRun ? null : findExistingRun(outRoot);
		const runDir = existing ?? resolve(outRoot, `memory-to-vault-${timestamp()}`);
		const isResume = !!existing;
		if (!dryRun) mkdirSync(runDir, { recursive: true });
		const pipelinePath = join(runDir, "pipeline.json");
		const vaultPath = resolveVaultPath(parsed, cwd);
		process.env.OB_VAULT_PATH = vaultPath;

		// Load the existing doc on resume (keeps perFile states → shouldDistill skips
		// done files); refresh options + scope in case flags changed.
		let doc: MemoryPipelineDoc = readPipelineDoc(pipelinePath) ?? {
			schemaVersion: 1, createdAt: iso(), updatedAt: iso(), status: "running",
			options: { concurrency, retries, folder, threshold, model: parsed.model },
			scope: { files: scope.files, fileCount: scope.files.length, excluded: scope.excluded },
			stages: { "fan-out": { status: "pending" }, hygiene: { status: "pending" } },
		};
		doc.options = { concurrency, retries, folder, threshold, model: parsed.model };
		doc.scope = { files: scope.files, fileCount: scope.files.length, excluded: scope.excluded };
		doc.status = "running";

		// 3. --dry-run: plan only.
		if (dryRun) {
			const plan = {
				files: scope.files.length, excluded: scope.excluded, concurrency, retries,
				folder, vaultPath, model: parsed.model ?? "(default)",
				wouldRun: "workflow fan-out (1 obsidian-distill/file) → mergeDuplicates → healGraph",
			};
			console.log(JSON.stringify(plan, null, 2));
			return;
		}
		if (!dryRun) writePipelineDoc(pipelinePath, doc);

		console.error(`memory-to-vault  (run: ${relative(cwd, runDir) || runDir})`);
		console.error(`  files: ${scope.files.length} (+${scope.excluded} excluded)  vault: ${vaultPath}`);
		console.error(`  concurrency: ${concurrency}  retries: ${retries}  folder: ${folder}${isResume ? "  (resuming)" : ""}`);

		// 4. STAGE A — fan-out via runWorkflow (in-process) + capture-harness agent.
		const toDistill = shouldDistill(doc, force);
		if (toDistill.length === 0) {
			console.error("▶ STAGE A: distill (skipped — all files already done; use --force to redo)");
		} else {
			console.error(`▶ STAGE A: distill ${toDistill.length}/${scope.files.length} file(s)`);
			doc.stages["fan-out"] = { status: "running", startedAt: iso() };
			writePipelineDoc(pipelinePath, doc);

			const extensionTools = await captureExtensionTools([obsidianExtension]);
			if (extensionTools.length === 0) {
				throw new Error("captureExtensionTools yielded 0 obsidian tools — the obsidian factory did not register against the stub pi (see findings.md § GATE-0.8a).");
			}
			const agent = new WorkflowAgent({ cwd, extensionTools });

			const scriptText = generateWorkflowScript({
				files: toDistill, folder,
				...(parsed.maxNotes ? { maxNotes: parsed.maxNotes } : {}),
			});
			const perFile: PerFileState[] = scope.files
				.filter((f) => toDistill.includes(f.path))
				.map((f) => ({ path: f.path, status: "running" as const }));

			await runWorkflow(scriptText, {
				concurrency,
				agentRetries: retries,
				mainModel: parsed.model,
				cwd,
				agent,
				onPhase: (title: string) => console.error(`  [phase] ${title}`),
				onAgentEnd: (ev: { label?: string; result?: unknown; error?: string }) => {
					const pf = perFile.find((p) => p.path === ev.label);
					if (pf) {
						pf.status = ev.error ? "error" : "done";
						if (ev.error) pf.error = ev.error;
						if (typeof ev.result === "string") {
							const m = ev.result.match(/(\d+)/);
							if (m) pf.notesCreated = Number(m[1]);
						}
					}
					console.error(`    ${ev.error ? "✗" : "✓"} ${ev.label}${ev.error ? " — " + ev.error : ""}`);
				},
			});

			doc.stages["fan-out"] = {
				status: perFile.every((p) => p.status === "done") ? "done" : "partial",
				startedAt: doc.stages["fan-out"]?.startedAt,
				finishedAt: iso(),
				perFile,
			};
			writePipelineDoc(pipelinePath, doc);
			const done = perFile.filter((p) => p.status === "done").length;
			console.error(`✓ STAGE A: ${done}/${perFile.length} files distilled`);
		}

		// 5. STAGE B — deterministic hygiene (no LLM).
		console.error("▶ STAGE B: merge-duplicates + heal-graph");
		doc.stages.hygiene = { status: "running" };
		writePipelineDoc(pipelinePath, doc);
		const merge = await mergeDuplicates({ vaultPath, folder, threshold, dryRun: false });
		const heal = await healGraph({ vaultPath, folder, mocPath: MOC_PATH });
		const health = await graphHealth({ vaultPath, folder, mocPath: MOC_PATH });
		doc.stages.hygiene = {
			status: "done", mergedPairs: merge.pairs.length, deadLinksPruned: heal.deadLinksPruned,
		};
		doc.health = {
			cardCount: health.cardCount, deadLinks: health.deadLinks.length,
			mocOk: !health.mocMissing && !health.mocStale,
		};
		doc.status = "done";
		writePipelineDoc(pipelinePath, doc);

		// 6. RECEIPT (audit record; pipeline.json is the resume state in the run dir).
		const receiptDir = resolve(cwd, RECEIPT_DIR);
		mkdirSync(receiptDir, { recursive: true });
		const receiptPath = join(receiptDir, `run-${iso().replace(/[:.]/g, "-")}.json`);
		writeFileSync(receiptPath, JSON.stringify({
			timestamp: iso(), mode: "run", vaultPath, memoryDir, projectsDir,
			options: doc.options, scope: { files: scope.files.length, excluded: scope.excluded },
			fanOut: doc.stages["fan-out"], hygiene: doc.stages.hygiene, health: doc.health,
		}, null, 2), "utf8");

		console.error(`\n━━━ memory-to-vault ${doc.status.toUpperCase()} ━━━`);
		console.error(`  cards: ${health.cardCount}  merged: ${merge.pairs.length}  dead-links pruned: ${heal.deadLinksPruned}  graph: ${health.ok ? "✓" : "✗"}`);
		console.error(`  receipt: ${relative(cwd, receiptPath)}`);
		if (json) {
			console.log(JSON.stringify({
				files: scope.files.length, mergedPairs: merge.pairs.length,
				deadLinksPruned: heal.deadLinksPruned, cards: health.cardCount, graphOk: health.ok,
			}, null, 2));
		}

		// 7. --verify: prove queryability with sample probes.
		if (parsed.verify) {
			console.error("▶ VERIFY: sample zk_ask probes");
			const { zkAskCommand } = await import("./zk-ask.ts");
			const probes = [
				"What did I learn about gh pr merge racing on video_generation?",
				"What is this machine's ffmpeg drawtext limitation?",
			];
			let ok = 0;
			for (const q of probes) {
				try {
					await zkAskCommand.run({ ...emptyParsed(), positionals: [q], retrieveOnly: true });
					ok++;
					console.error(`  ✓ "${q}"`);
				} catch (e) {
					console.error(`  ✗ "${q}" — ${(e as Error).message}`);
				}
			}
			console.error(`  verify: ${ok}/${probes.length} probes returned context`);
		}
	},
};
