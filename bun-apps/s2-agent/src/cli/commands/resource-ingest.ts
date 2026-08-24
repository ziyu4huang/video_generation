/**
 * `resource-ingest <dir>` — index a document TREE into the kcard resource
 * tier (effort 2026-08-25-kcard-resource-tier, tickets 01+02).
 *
 * Tier pass (ticket 02, default ON): directories are processed leaves→root;
 * each gets one LLM call producing a `.overview.md` (L1) sidecar, with the
 * `.abstract.md` (L0) extracted from it — never a second call. Unchanged
 * directories (child-hash gate) make ZERO LLM calls; a child edit refreshes
 * only its ancestor chain. `--no-tiers` skips the pass (L2-only rebuild).
 *
 * Then the ticket-01 L2 rebuild runs: walks the markdown tree (dot-dirs
 * excluded; sidecars index as their own level-0/1 rows), embeds everything
 * via the semantic seam (per-tree content-hash cache: unchanged files embed
 * zero times), and lands rows in the `resource` table of the kcard
 * context_db — fingerprint-gated per tree, shadow-batched, NEVER touching
 * the zettel `card` lane.
 *
 * Flags:
 *   --tree <slug>   tree discriminator override (default: basename of <dir>)
 *   --model <id>    embedding model override (default: seam → env → bge-m3)
 *   --no-tiers      skip L0/L1 sidecar generation
 *   --dry-run       plan + fingerprint + report only, write nothing (no LLM)
 *   --json          JSON output
 */
import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import {
	buildResourceRows,
	rebuildResourceIndex,
	makeResourceClient,
} from "@repo/s2-agent-ext-knowledge-card/src/resource-index.ts";
import {
	defaultTierGenerator,
	generateResourceTiers,
} from "@repo/s2-agent-ext-knowledge-card/src/resource-tiers.ts";
import { resolveKgModel } from "@repo/s2-agent-ext-knowledge-card/src/llm-chat.ts";
import { defaultEmbedder } from "@repo/s2-agent-ext-knowledge-card/src/semantic.ts";

export const resourceIngestCommand = {
	name: "resource-ingest",
	summary: "index a document tree into the resource tier (L0/L1/L2 rows, kcard context_db)",
	details: `Usage:
  s2-agent cli resource-ingest <dir> [options]       index a markdown document tree

  Tier pass (default): directories are processed leaves→root, one LLM call
  each — a \`.overview.md\` (L1) sidecar whose leading paragraph is extracted
  into a \`.abstract.md\` (L0), never a second call. Directories whose child
  inputs are unchanged since the last generation make ZERO LLM calls. Then
  every file (L2) and sidecar (L0/L1) is embedded via the semantic seam
  (per-tree content-hash cache) and written to the \`resource\` table in the
  kcard context_db. Per-tree fingerprint gate: an unchanged tree skips in
  milliseconds. The zettel card lane is untouched.

Options:
  --tree <slug>    tree discriminator override (default: basename of <dir>)
  --model <id>     embedding model override (default: seam → env → bge-m3)
  --no-tiers       skip L0/L1 sidecar generation (L2-only rebuild)
  --dry-run        plan + fingerprint + report only, write nothing (no LLM)
  --json           JSON output

Examples:
  s2-agent cli resource-ingest "~/proj/study-news/ic-standard-spec/USB4 Specification November 2025/vlm-out"
  s2-agent cli resource-ingest ./docs --tree my-docs --dry-run
  s2-agent cli resource-ingest ./docs --no-tiers`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const dir = parsed.positionals[0];
		if (!dir) throw new Error("No input dir. Usage: resource-ingest <dir>");
		const treePath = isAbsolute(dir) ? dir : resolve(cwd, dir);
		if (!existsSync(treePath) || !statSync(treePath).isDirectory()) {
			throw new Error(`Not a directory: ${dir} (resolved: ${treePath})`);
		}

		if (parsed.dryRun) {
			// Reviewer m1: dry-run means dry — NO embedder (zero network), NO
			// cache write into the previewed tree, NO LLM (tier pass in planOnly
			// mode decides per-dir actions without calling the generator).
			const built = await buildResourceRows({
				treePath,
				tree: parsed.tree,
				model: parsed.model,
			});
			const tiers = parsed.noTiers
				? null
				: await generateResourceTiers({ treePath, planOnly: true });
			if (parsed.json) {
				console.log(
					JSON.stringify(
						{
							mode: "dry-run",
							tree: built.tree,
							files: built.rows.filter((r) => r.level === 2).length,
							tierRows: built.rows.filter((r) => r.level !== 2).length,
							fingerprint: built.fingerprint,
							dim: built.dim,
							embedModel: built.embedModel,
							tierPlan: tiers,
							skipped: built.skipped,
						},
						null,
						2,
					),
				);
			} else {
				console.error(`tree:         ${built.tree} (${treePath})`);
				console.error(`files:        ${built.rows.filter((r) => r.level === 2).length} (skipped ${built.skipped.length})`);
				console.error(`tier rows:    ${built.rows.filter((r) => r.level !== 2).length} (existing sidecars)`);
				console.error(`fingerprint:  ${built.fingerprint}`);
				console.error(`dim/model:    ${built.dim || "(embedder down)"} / ${built.embedModel}`);
				if (tiers) {
					for (const d of tiers.dirs) {
						console.error(`tier ${d.action.padEnd(9)} ${d.uri} (entries ${d.totalEntries}, pending ${d.pendingChildChanges})`);
					}
				} else {
					console.error("tier pass:    skipped (--no-tiers)");
				}
				console.error("(dry-run — no writes, no LLM calls)");
			}
			return;
		}

		// Tier pass first (writes sidecars → the L2 rebuild below indexes them
		// as level-0/1 rows). chatJson never throws; a failed dir is reported,
		// its sidecars simply absent from this rebuild.
		let tiers = null as Awaited<ReturnType<typeof generateResourceTiers>> | null;
		if (!parsed.noTiers) {
			tiers = await generateResourceTiers({
				treePath,
				generator: defaultTierGenerator(),
				llmModel: resolveKgModel(),
			});
		}

		// Long timeout: a cold-cache tree embeds the whole corpus (~minutes at
		// 839 files); the default 10s would abort mid-swap (scheduleCardRebuild
		// precedent).
		const client = makeResourceClient({ requestTimeoutMs: 180_000 });
		const result = await rebuildResourceIndex({
			client,
			treePath,
			tree: parsed.tree,
			model: parsed.model,
			embedder: defaultEmbedder,
		});
		if (parsed.json) {
			console.log(JSON.stringify({ ...result, tiers }, null, 2));
		} else {
			console.error(`tree:        ${result.tree} (${treePath})`);
			console.error(`status:      ${result.skipped ? "SKIP (fingerprint match)" : "REBUILT"}`);
			console.error(`rows:        ${result.inserted}`);
			console.error(`embedded:    ${result.embedded} this run, ${result.cached} from cache`);
			console.error(`dim/model:   ${result.dim || "(no vectors)"} / ${result.embedModel}`);
			if (tiers) {
				console.error(`tiers:       ${tiers.refreshed} refreshed, ${tiers.skipped} skipped, ${tiers.pending} pending, ${tiers.failed} failed (${tiers.llmCalls} LLM calls)`);
				for (const d of tiers.dirs.filter((r) => r.promptChars > 0 || r.action !== "skipped")) {
					console.error(`  ${d.action.padEnd(9)} ${d.uri} — ${d.totalEntries} entries, prompt ${d.promptChars} chars`);
				}
			} else {
				console.error("tiers:       skipped (--no-tiers)");
			}
			console.error(`elapsed:     ${result.elapsedMs}ms`);
		}
	},
};
