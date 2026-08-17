/**
 * `pipeline status|run|dry-run|lint` — the knowledge pipeline operational surface.
 *
 * One command to run + inspect the memory → knowledge-card → obsidian flow:
 *
 *   pipeline status    recent captures, last-converge, pending (unconverged)
 *                      entries, graph-health snapshot.
 *   pipeline run       converge hermes memory → merge duplicates → heal graph,
 *                      in one command (the manual lever). Writes a receipt.
 *   pipeline dry-run   preview what converge + merge would change (no writes).
 *   pipeline lint      merge-duplicates + heal only (the periodic hygiene sweep).
 *
 * Convergence is wiki-aware (reuses ONE canonical card per lesson instead of
 * minting parallel duplicates across the 10+ id namespaces). Hygiene uses the
 * same token-Jaccard duplicate scanner as `zk-query --merge-duplicates`.
 *
 * Flags:
 *   --memory-dir <path>   hermes memory dir (default ~/.pi/agent/pi-hermes-memory)
 *   --vault <path>        absolute vault path (sets OB_VAULT_PATH)
 *   --vault-dir <name>    vault folder under cwd (default vaults_root/pi-agent-vault)
 *   --folder <name>       convergence folder (default Zettelkasten/knowledge-graph)
 *   --threshold <0..1>    merge similarity threshold (default 0.9)
 *   --fix                 with lint: apply merges (default dry-run)
 *   --reconverge          with run: reset convergence state → re-converge everything
 *   --json                machine-readable output
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, isAbsolute, join, basename } from "node:path";
import { homedir } from "node:os";
import type { ParsedArgs } from "../args.ts";
import { ingestRecords } from "@repo/pi-agent-ext-knowledge-card/src/ingest.ts";
import { adaptHermesMarkdown } from "@repo/pi-agent-ext-knowledge-card/src/adapters.ts";
import type { KnowledgeRecord, IngestSummary } from "@repo/pi-agent-ext-knowledge-card/src/types.ts";
import { graphHealth, healGraph, type GraphHealthResult, type HealResult } from "@repo/pi-agent-ext-knowledge-card/src/retrieve.ts";

const DEFAULT_MEMORY_DIR = join(homedir(), ".pi", "agent", "pi-hermes-memory");
const HERMES_FILES = ["MEMORY.md", "failures.md", "USER.md"];
const STATE_FILENAME = ".vault-converge-state.json";
const RECEIPT_DIR = "output/knowledge-pipeline";

function resolveVaultPath(parsed: ParsedArgs, cwd: string): string {
	const explicit = parsed.vault ?? process.env.OB_VAULT_PATH;
	if (explicit) {
		const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
		return abs;
	}
	// Default: walk up from cwd to find vaults_root/pi-agent-vault (the shared
	// convergence sink). Falls back to creating it relative to cwd.
	const dir = parsed.vaultDir ?? "vaults_root/pi-agent-vault";
	let search = cwd;
	for (let i = 0; i < 10; i++) {
		const candidate = join(search, dir);
		if (existsSync(candidate)) return candidate;
		const parent = resolve(search, "..");
		if (parent === search) break;
		search = parent;
	}
	const abs = resolve(cwd, dir);
	mkdirSync(abs, { recursive: true });
	return abs;
}

function resolveMemoryDir(parsed: ParsedArgs): string {
	const dir = parsed.memoryDir ?? process.env.PI_HERMES_MEMORY_DIR ?? DEFAULT_MEMORY_DIR;
	return dir;
}

/** Collect + adapt hermes memory files into KnowledgeRecords. */
function collectHermesRecords(memoryDir: string): { records: KnowledgeRecord[]; fileCount: number; files: string[] } {
	const records: KnowledgeRecord[] = [];
	const files: string[] = [];
	for (const f of HERMES_FILES) {
		const abs = join(memoryDir, f);
		if (!existsSync(abs)) continue;
		files.push(abs);
		const content = readFileSync(abs, "utf8");
		const recs = adaptHermesMarkdown(content);
		records.push(...recs);
	}
	return { records, fileCount: files.length, files };
}

/** DJB2 hash (matches vault-converge.ts + passive-converge.ts). */
function entryHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

interface ConvergeState {
	[target: string]: string[];
}

function loadConvergeState(memoryDir: string): ConvergeState {
	try {
		const p = join(memoryDir, STATE_FILENAME);
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
	} catch { /* corrupt → treat as empty */ }
	return {};
}

/** Count converged vs pending records by matching record ids against the state.
 *  The state tracks raw entry hashes per target; we approximate "pending" by
 *  counting records whose hash (from detail text) isn't in the state. */
function countPending(records: KnowledgeRecord[], state: ConvergeState): { total: number; converged: number; pending: number } {
	const allHashes = new Set<string>();
	for (const arr of Object.values(state)) for (const h of arr) allHashes.add(h);
	let converged = 0;
	for (const rec of records) {
		// The record id encodes the source hash for pi-memory entries, but hermes
		// ids are slugs. Use the detail hash for a best-effort pending count.
		if (allHashes.has(entryHash(rec.detail))) converged++;
	}
	return { total: records.length, converged, pending: records.length - converged };
}

function lastConvergeTime(memoryDir: string): string | null {
	try {
		const p = join(memoryDir, STATE_FILENAME);
		if (!existsSync(p)) return null;
		return statSync(p).mtime.toISOString();
	} catch { return null; }
}

interface PipelineReceipt {
	timestamp: string;
	mode: "run" | "dry-run" | "lint";
	vaultPath: string;
	memoryDir: string;
	converge?: IngestSummary;
	heal?: HealResult;
	health?: GraphHealthResult;
}

function writeReceipt(receipt: PipelineReceipt, cwd: string): string {
	const dir = resolve(cwd, RECEIPT_DIR);
	mkdirSync(dir, { recursive: true });
	const ts = receipt.timestamp.replace(/[:.]/g, "-");
	const path = join(dir, `run-${ts}.json`);
	writeFileSync(path, JSON.stringify(receipt, null, 2), "utf8");
	return path;
}

export const knowledgePipelineCommand = {
	name: "pipeline",
	summary: "knowledge pipeline: converge + merge + heal (status / run / dry-run / lint)",
	details: `Usage:
  pi-agent cli pipeline status [options]        snapshot: captures, pending, health
  pi-agent cli pipeline run [options]           converge + merge + heal (writes a receipt)
  pi-agent cli pipeline dry-run [options]       preview converge + merge (no writes)
  pi-agent cli pipeline lint [--fix] [options]  merge-duplicates + heal only

The knowledge pipeline operational surface — one command for the
memory → knowledge-card → obsidian flow. Convergence is wiki-aware (reuses ONE
canonical card per lesson); hygiene uses the same Jaccard duplicate scanner as
'zk-query --merge-duplicates'.

Sources converged on 'run'/'dry-run':
  ~/.pi/agent/pi-hermes-memory/{MEMORY,failures,USER}.md  (hermes entries)

Options:
  --memory-dir <path>   hermes memory dir (default ~/.pi/agent/pi-hermes-memory)
  --vault <path>        absolute vault path (sets OB_VAULT_PATH)
  --vault-dir <name>    vault folder under cwd (default vaults_root/pi-agent-vault)
  --folder <name>       convergence folder (default Zettelkasten/knowledge-graph)
  --threshold <0..1>    merge similarity threshold (default 0.9)
  --fix                 with lint: apply merges (default dry-run)
  --reconverge          with run: reset convergence state → re-converge everything
  --json                machine-readable output

Examples:
  pi-agent cli pipeline status
  pi-agent cli pipeline run
  pi-agent cli pipeline dry-run
  pi-agent cli pipeline lint --fix
  pi-agent cli pipeline run --json`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const sub = parsed.positionals[0] ?? "status";
		const validSubs = ["status", "run", "dry-run", "lint"];
		if (!validSubs.includes(sub)) {
			throw new Error(`Unknown pipeline sub-command: '${sub}'. Expected one of: ${validSubs.join(", ")}`);
		}

		const vaultPath = resolveVaultPath(parsed, cwd);
		process.env.OB_VAULT_PATH = vaultPath;
		const folder = parsed.folder ?? "Zettelkasten/knowledge-graph";
		const mocPath = "Tags/Knowledge Graph.md";
		const memoryDir = resolveMemoryDir(parsed);
		const threshold = typeof parsed.threshold === "number" ? parsed.threshold : 0.9;
		const json = parsed.json === true || parsed.mode === "json";

		// ── STATUS ──────────────────────────────────────────────────────
		if (sub === "status") {
			const collected = collectHermesRecords(memoryDir);
			const state = loadConvergeState(memoryDir);
			const counts = countPending(collected.records, state);
			const lastTime = lastConvergeTime(memoryDir);
			const health = await graphHealth({ vaultPath, folder, mocPath });

			const snapshot = {
				memoryDir,
				files: collected.fileCount,
				totalEntries: counts.total,
				converged: counts.converged,
				pending: counts.pending,
				lastConverge: lastTime,
				vaultPath,
				folder,
				cardCount: health.cardCount,
				deadLinks: health.deadLinks.length,
				mocMissing: health.mocMissing,
				mocStale: health.mocStale,
				graphOk: health.ok,
			};
			if (json) {
				console.log(JSON.stringify(snapshot, null, 2));
			} else {
				console.log("knowledge-pipeline status");
				console.log("─────────────────────────");
				console.log(`memory dir:    ${memoryDir}`);
				console.log(`files:         ${collected.fileCount} hermes file(s)`);
				console.log(`entries:       ${counts.total} total, ${counts.converged} converged, ${counts.pending} pending`);
				console.log(`last converge: ${lastTime ?? "(never)"}`);
				console.log(`vault:         ${vaultPath}`);
				console.log(`folder:        ${folder}/  (${health.cardCount} cards)`);
				console.log(`graph health:  ${health.ok ? "✓ clean" : "✗ drift"} — ${health.deadLinks.length} dead link(s), MOC ${health.mocMissing ? "missing" : health.mocStale ? "stale" : "ok"}`);
			}
			return;
		}

		// ── LINT (heal only) ────────────────────────────────────
		if (sub === "lint") {
			const dryRun = parsed.fix !== true || parsed.dryRun === true;
			const heal = dryRun ? null : await healGraph({ vaultPath, folder, mocPath });
			const health = await graphHealth({ vaultPath, folder, mocPath });

			if (json) {
				console.log(JSON.stringify({ mode: "lint", heal, health }, null, 2));
			} else {
				console.log(`pipeline lint ${dryRun ? "(dry-run)" : "(applying)"}`);
				if (heal) console.log(`  heal:  MOC ${heal.mocRegenerated ? "regenerated" : "(no change)"}, ${heal.deadLinksPruned} dead link(s) pruned`);
				console.log(`  graph: ${health.ok ? "✓ clean" : "✗ drift"}`);
			}
			return;
		}

		// ── RUN / DRY-RUN (converge + merge + heal) ─────────────────────
		const dryRun = sub === "dry-run" || parsed.dryRun === true;

		// Optional: reset convergence state for a full re-converge.
		if (!dryRun && parsed.reconverge) {
			writeFileSync(join(memoryDir, STATE_FILENAME), JSON.stringify({}, null, 2), "utf8");
		}

		const collected = collectHermesRecords(memoryDir);
		if (collected.records.length === 0) {
			console.log(json ? JSON.stringify({ mode: sub, message: "no hermes entries to converge" }) : "No hermes memory entries found.");
			return;
		}

		// 1. Converge (wiki-aware). Process each hermes file separately so the
		//    sourceLabel matches the original per-file convention (hermes:MEMORY,
		//    hermes:failures, hermes:USER) — a single merged label would dirty
		//    every card's `source` frontmatter on every run.
		let convergeTotals = { total: 0, created: 0, updated: 0, unchanged: 0, wikiMerged: 0, skipped: 0 };
		for (const file of collected.files) {
			const content = readFileSync(file, "utf8");
			const recs = adaptHermesMarkdown(content);
			if (recs.length === 0) continue;
			const label = `hermes:${basename(file)}`;
			const s = await ingestRecords(recs, {
				vaultPath,
				source: "hermes",
				sourceLabel: label,
				folder,
				dryRun,
				wikiAware: true,
				wikiThreshold: 0.85,
			});
			convergeTotals.total += s.total;
			convergeTotals.created += s.created;
			convergeTotals.updated += s.updated;
			convergeTotals.unchanged += s.unchanged;
			convergeTotals.wikiMerged += s.wikiMerged;
			convergeTotals.skipped += s.skipped;
		}
		const converge: IngestSummary = {
			source: "hermes",
			sourceLabel: "hermes:pipeline",
			total: convergeTotals.total,
			created: convergeTotals.created,
			updated: convergeTotals.updated,
			unchanged: convergeTotals.unchanged,
			skipped: convergeTotals.skipped,
			linked: 0,
			wikiMerged: convergeTotals.wikiMerged,
			mocUpdated: false,
			vaultPath,
			folder,
			cards: [],
			parseErrors: [],
		};

		// 2. Heal graph (MOC + dead links). Skipped in dry-run (no writes).
		const heal = dryRun ? null : await healGraph({ vaultPath, folder, mocPath });

		// 3. Graph health snapshot.
		const health = await graphHealth({ vaultPath, folder, mocPath });

		const timestamp = new Date().toISOString();
		const receipt: PipelineReceipt = { timestamp, mode: dryRun ? "dry-run" : "run", vaultPath, memoryDir, converge, heal: heal ?? undefined, health };
		const receiptPath = dryRun ? null : writeReceipt(receipt, cwd);

		if (json) {
			console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2));
		} else {
			console.log(`pipeline ${sub}`);
			console.log("─────────────────────────");
			console.log(`converge: ${converge.total} records → ${converge.created} created, ${converge.updated} updated, ${converge.unchanged} unchanged, ${converge.wikiMerged} wiki-merged, ${converge.skipped} skipped`);
			if (heal) console.log(`heal:     MOC ${heal.mocRegenerated ? "regenerated" : "(no change)"}, ${heal.deadLinksPruned} dead link(s) pruned`);
			console.log(`graph:    ${health.cardCount} cards, ${health.deadLinks.length} dead link(s), MOC ${health.mocMissing ? "missing" : health.mocStale ? "stale" : "ok"} — ${health.ok ? "✓ clean" : "✗ drift"}`);
			if (receiptPath) console.log(`receipt:  ${receiptPath}`);
		}

		// Update convergence state (so passive shutdown doesn't re-converge
		// everything that was just converged here). Only on a real run.
		if (!dryRun && converge.created + converge.updated + converge.wikiMerged > 0) {
			const state = loadConvergeState(memoryDir);
			for (const rec of collected.records) {
				const hash = entryHash(rec.detail);
				// Approximate: all hermes entries converge under the "memory" bucket.
				const arr = state.memory ?? (state.memory = []);
				if (!arr.includes(hash)) arr.push(hash);
			}
			try {
				writeFileSync(join(memoryDir, STATE_FILENAME), JSON.stringify(state, null, 2), "utf8");
			} catch { /* best effort */ }
		}
	},
};
