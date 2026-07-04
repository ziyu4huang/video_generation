/**
 * `zk-query` — deterministic READ side of the unified knowledge graph.
 *
 * The symmetric counterpart to `zk-ingest`: instead of converging records INTO
 * the graph, it retrieves relevant cards OUT of it, so a self-improve workflow
 * can learn what EVERY other workflow learned (not just its own `.knowledge.jsonl`).
 * Deterministic — no LLM, no network. Two modes:
 *
 *   zk-query --tags argv,path-validation [--exclude-from-kb <kb.jsonl>] [--topK 12]
 *     Retrieve cards matching ANY of the tags, ranked by shared-tag count, as a
 *     compact grouped digest. `--exclude-from-kb` reads a workflow's own active
 *     ids and EXCLUDES them, so the digest is genuinely cross-workflow (the
 *     closed-loop proof: a card whose id the caller never wrote).
 *
 *   zk-query --health
 *     Graph integrity gate over the convergence folder: dead links, MOC drift
 *     (card present but MOC missing it / vice versa), and orphan cards. Exits
 *     non-zero only on dead-link / MOC-drift (orphans are reported, non-fatal).
 *
 * Flags:
 *   --tags <csv>            match cards with ≥1 of these tags
 *   --exclude-from-kb <path>  read active record ids from this .knowledge.jsonl and skip them
 *   --exclude-ids <csv>     explicit record ids to skip
 *   --exclude-source <lbl>  skip cards whose frontmatter `source` == this label
 *   --top-k <n>             max cards to return (default 12)
 *   --folder <name>         convergence folder (default Zettelkasten/knowledge-graph)
 *   --health                run the integrity gate instead of retrieval
 *   --moc-path <rel>        MOC note path for drift check (default Tags/Knowledge Graph.md)
 *   --vault <path>          absolute vault path
 *   --vault-dir <name>      vault folder under cwd (default vault)
 *   --json                  emit machine-readable JSON instead of a digest
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import {
	retrieveRecords,
	formatRetrieveDigest,
	graphHealth,
	formatHealthReport,
	readActiveIds,
} from "pi-knowledge-card/src/retrieve.ts";

function resolveVaultPath(parsed: ParsedArgs, cwd: string): string {
	const explicit = parsed.vault ?? process.env.OB_VAULT_PATH;
	if (explicit) {
		const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
		return abs;
	}
	const dir = parsed.vaultDir ?? process.env.OB_VAULT_DIR ?? "vault";
	const abs = resolve(cwd, dir);
	if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
	return abs;
}

const DETAILS = `Usage:
  bun-pi-agent-cli zk-query --tags <csv> [options]      retrieve cross-workflow cards
  bun-pi-agent-cli zk-query --health [options]          graph integrity gate

Retrieval mode (default):
  Returns a compact digest of cards from the convergence folder matching ANY of
  --tags, ranked by shared-tag count. Pass --exclude-from-kb <your.knowledge.jsonl>
  to surface ONLY cards your own workflow did not write (cross-workflow feedback).

Health mode (--health):
  Reports dead links, MOC drift, and orphans over the folder. Exit code:
    0 = no dead links + no MOC drift (orphans are reported but non-fatal)
    1 = drift detected (operator must re-ingest or fix vault content)

Options:
  --tags <csv>              match cards with ≥1 of these tags (e.g. argv,path-safety)
  --exclude-from-kb <path>  skip active record ids from this .knowledge.jsonl
  --exclude-ids <csv>       skip these record ids explicitly
  --exclude-source <lbl>    skip cards whose 'source' frontmatter matches
  --top-k <n>               max cards (default 12)
  --folder <name>           convergence folder (default Zettelkasten/knowledge-graph)
  --health                  integrity gate instead of retrieval
  --moc-path <rel>          MOC note path (default "Tags/Knowledge Graph.md")
  --vault <path>            absolute vault path
  --vault-dir <name>        vault folder under cwd (default vault)
  --json                    machine-readable JSON output

Examples:
  bun-pi-agent-cli zk-query --tags argv,argparse --exclude-from-kb .claude/workflows/flux2.knowledge.jsonl
  bun-pi-agent-cli zk-query --tags path-safety --top-k 8 --json
  bun-pi-agent-cli zk-query --health`;

export const zkQueryCommand = {
	name: "zk-query",
	summary:
		"retrieve cross-workflow cards from the shared knowledge graph (deterministic; no LLM)",
	details: DETAILS,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const vaultPath = resolveVaultPath(parsed, cwd);
		process.env.OB_VAULT_PATH = vaultPath;
		const folder = parsed.folder ?? "Zettelkasten/knowledge-graph";
		const asJson = parsed.mode === "json";

		// ── Health mode ──
		if (parsed.health) {
			const report = await graphHealth({
				vaultPath,
				folder,
				mocPath: parsed.mocPath ?? "Tags/Knowledge Graph.md",
			});
			if (asJson) {
				console.log(JSON.stringify(report));
			} else {
				console.log(formatHealthReport(report));
			}
			// Dead links / MOC drift are real defects; orphans are reported but
			// non-fatal (a freshly-ingested card has no inbound links yet).
			process.exitCode = report.ok ? 0 : 1;
			return;
		}

		// ── Retrieval mode ──
		const tags = (parsed.tags ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const excludeIds = new Set<string>(
			(parsed.excludeIds ?? "").split(",").map((t) => t.trim()).filter(Boolean),
		);
		if (parsed.excludeFromKb) {
			const kbAbs = isAbsolute(parsed.excludeFromKb)
				? parsed.excludeFromKb
				: resolve(cwd, parsed.excludeFromKb);
			if (!existsSync(kbAbs)) {
				console.error(`--exclude-from-kb not found: ${parsed.excludeFromKb} (resolved: ${kbAbs})`);
			} else {
				for (const id of readActiveIds(kbAbs)) excludeIds.add(id);
			}
		}

		if (tags.length === 0) {
			console.log(DETAILS);
			return;
		}

		const summary = await retrieveRecords({
			vaultPath,
			tags,
			excludeIds: [...excludeIds],
			excludeSourceLabel: parsed.excludeSource,
			folder,
			topK: parsed.topK ?? 12,
		});

		if (asJson) {
			console.log(JSON.stringify(summary));
		} else {
			console.log(formatRetrieveDigest(summary));
			console.error(
				`(matched ${summary.matched}/${summary.total} in ${folder}, returned ${summary.returned}, excluded ${summary.query.excludeIds} own-id(s))`,
			);
		}
	},
};
