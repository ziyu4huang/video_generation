/**
 * `zk-query` — deterministic cross-workflow knowledge retrieval + graph health.
 *
 * The READ-side counterpart to `zk-ingest` (the WRITE side). Two modes:
 *
 *   RETRIEVE (default): scan the convergence folder for cards matching ANY of
 *   --tags, rank by shared-tag count, EXCLUDE the caller's own active ids
 *   (--exclude-from-kb <jsonl> reads active ids; --exclude-ids <csv> adds more),
 *   and print a compact grouped digest. This is the cross-workflow injection a
 *   self-improve loop's loadGraphKnowledge helper shells out to.
 *
 *   HEALTH (--health): audit the convergence folder for dead links, MOC drift,
 *   and orphans. Exit non-zero on drift (dead-link / MOC-missing / MOC-stale).
 *   Add --fix to auto-heal (regenerate MOC + prune dead links in-card).
 *
 * Flags:
 *   --tags <csv>           tags to match (ANY semantics)
 *   --exclude-from-kb <f>  .knowledge.jsonl to read active ids from + exclude
 *   --exclude-ids <csv>    explicit ids to exclude (in addition to --exclude-from-kb)
 *   --top-k <n>            max cards (default 10)
 *   --health               graph health audit (dead-links / MOC-drift / orphans)
 *   --fix                  auto-heal (with --health): regenerate MOC + prune dead links
 *   --folder <name>        convergence folder (default Zettelkasten/knowledge-graph)
 *   --vault <path>         absolute vault path
 *   --vault-dir <name>     vault folder name under cwd (default vault)
 */
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { resolveVaultPath, applyResolvedVaultEnv } from "../vault-paths.ts";
import {
	retrieveRecords,
	readActiveIds,
	graphHealth,
	healGraph,
	formatHealth,
} from "@repo/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { coverageReport } from "@repo/s2-agent-ext-knowledge-card/src/ingest.ts";
import { loadWatchlist, resolveSpecsToRecords } from "@repo/s2-agent-ext-knowledge-card/src/source-watchlist.ts";

export const zkQueryCommand = {
	name: "zk-query",
	summary:
		"cross-workflow knowledge retrieval + graph health (READ side of the knowledge graph)",
	details: `Usage:
  s2-agent cli zk-query --tags <csv> [options]          cross-workflow retrieval
  s2-agent cli zk-query --health [--fix] [options]      graph health audit / heal

Retrieve mode (default):
  Scan the convergence folder for cards matching ANY of --tags, rank by
  shared-tag count, exclude the caller's own active ids, and print a compact
  grouped digest. This is what loadGraphKnowledge in a self-improve loop calls.

Health mode (--health):
  Audit dead links, MOC drift, and orphans (scoped to the convergence folder).
  Exit non-zero on drift (dead-link / MOC-missing / MOC-stale). Orphans are
  reported but non-fatal. Add --fix to auto-heal: regenerate MOC + prune dead
  [[...]] links in-card (scoped to the folder; never touches human-authored cards).

Options:
  --tags <csv>             tags to match, comma-separated (ANY semantics)
  --exclude-from-kb <f>    .knowledge.jsonl → read active ids and exclude them
  --exclude-ids <csv>      explicit ids to exclude (adds to --exclude-from-kb)
  --top-k <n>              max cards to return (default 10)
  --health                 run graph health audit instead of retrieval
  --fix                    with --health: auto-heal: regenerate MOC + prune dead links
  --folder <name>          convergence folder (default Zettelkasten/knowledge-graph)
  --vault <path>           absolute vault path (sets OB_VAULT_PATH)
  --vault-dir <name>       vault folder name under cwd (default vault)

Examples:
  # Cross-workflow retrieval for flux2's tag space
  s2-agent cli zk-query --tags argv,argparse,path-validation \\
    --exclude-from-kb .claude/workflows/s2-agent-ext-flux2-self-improve.knowledge.jsonl

  # Graph health audit
  s2-agent cli zk-query --health

  # Auto-heal drift
  s2-agent cli zk-query --health --fix`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const vaultPath = resolveVaultPath(parsed, cwd);
		applyResolvedVaultEnv(parsed, vaultPath);
		const folder = parsed.folder ?? "Zettelkasten/knowledge-graph";

		// ── COVERAGE MODE ─────────────────────────────────────────────────
		if (parsed.coverage) {
			const specs = loadWatchlist(cwd);
			const sources = await resolveSpecsToRecords(specs, cwd);
			if (!sources.length) {
				console.error(`coverage: no source families resolved (watch-list dirs missing under ${cwd}).`);
				console.error(`         create .pi/kcard-coverage.json or run from the project root.`);
				return;
			}
			const cov = await coverageReport({ vaultPath, folder, sources });
			if (parsed.json || parsed.mode === "json") {
				console.log(JSON.stringify({ mode: "coverage", ...cov }, null, 2));
			} else {
				console.error(`vault:   ${vaultPath}`);
				console.error(`folder:  ${folder}/`);
				console.error(`coverage: ${cov.matched}/${cov.expected} converged, ${cov.missing.length} missing, ${cov.sourceOrphaned.length} source-orphaned`);
				console.error();
				for (const [fam, by] of Object.entries(cov.byFamily)) {
					console.log(`[${fam}] expected ${by.expected}, vault ${by.vault}, matched ${by.matched}, missing ${by.missing.length}, sourceOrphaned ${by.sourceOrphaned.length}`);
					if (by.missing.length) console.log(`  missing:        ${by.missing.join(", ")}`);
					if (by.sourceOrphaned.length) console.log(`  sourceOrphaned: ${by.sourceOrphaned.join(", ")}`);
				}
			}
			if (cov.missing.length) process.exitCode = 1; // non-zero when records never converged
			return;
		}

		// ── HEALTH MODE ──────────────────────────────────────────────────
		if (parsed.health) {
			const mocPath = "Tags/Knowledge Graph.md";
			if (parsed.fix && !parsed.dryRun) {
				const healed = await healGraph({ vaultPath, folder, mocPath });
				console.error(`heal: MOC ${healed.mocRegenerated ? "regenerated" : "(no change)"}, ${healed.deadLinksPruned} dead link(s) pruned in ${healed.cardsTouched.length} card(s)`);
			} else if (parsed.fix && parsed.dryRun) {
				console.error("[dry-run] --fix suppressed (would heal graph: regenerate MOC + prune dead links)");
			}
			const h = await graphHealth({ vaultPath, folder, mocPath });
			if (parsed.json || parsed.mode === "json") {
				console.log(JSON.stringify({ mode: "health", ...h }, null, 2));
			} else {
				console.log(formatHealth(h));
			}
			if (!h.ok) {
				process.exitCode = 1;
			}
			return;
		}

		// ── RETRIEVE MODE ───────────────────────────────────────────────
		const tags = (parsed.tags ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (tags.length === 0) {
			throw new Error("zk-query: --tags <csv> is required (or use --health).");
		}

		// Exclude the caller's own active ids.
		const excludeIds: string[] = [];
		if (parsed.excludeFromKb) {
			const kbAbs = isAbsolute(parsed.excludeFromKb) ? parsed.excludeFromKb : resolve(cwd, parsed.excludeFromKb);
			if (existsSync(kbAbs)) {
				excludeIds.push(...readActiveIds(kbAbs));
			}
		}
		if (parsed.excludeIds) {
			excludeIds.push(...parsed.excludeIds.split(",").map((t) => t.trim()).filter(Boolean));
		}

		const topK = parsed.topK ?? 10;

		const result = await retrieveRecords({
			vaultPath,
			folder,
			tags,
			excludeIds,
			topK,
			// ticket 10 reconciliation: the CLI retrieve is a production access
			// path — echo the served cards into the usage ledger.
			usageLog: true,
		});

		if (parsed.json || parsed.mode === "json") {
			console.log(JSON.stringify({ mode: "retrieve", ...result }, null, 2));
		} else {
			console.error(`vault:   ${vaultPath}`);
			console.error(`folder:  ${folder}/  (${result.scanned} card(s) scanned, ${result.excluded} own-id(s) excluded)`);
			console.error(`tags:    [${tags.join(", ")}]`);
			console.error(`matched: ${result.count} cross-workflow card(s) (topK=${topK})`);
			console.error();

			if (result.digest) {
				console.log(result.digest);
				console.log(`\n(matched ${result.count}/${result.scanned} in ${folder}, excluded ${result.excluded} own-id(s))`);
			} else {
				console.log("(no cross-workflow cards matched — the graph may be empty or tag overlap is zero)");
			}
		}
	},
};
