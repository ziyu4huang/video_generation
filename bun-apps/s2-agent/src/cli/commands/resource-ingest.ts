/**
 * `resource-ingest <dir>` — index a document TREE into the kcard resource
 * tier (effort 2026-08-25-kcard-resource-tier, ticket 01).
 *
 * Walks the markdown tree under <dir> (dot-dirs and .abstract/.overview
 * sidecars excluded), embeds every file (bge-m3 via the semantic seam, a
 * per-tree content-hash cache so unchanged files embed zero times), and lands
 * one L2 row per file in the `resource` table of the kcard context_db —
 * fingerprint-gated per tree, shadow-batched, NEVER touching the zettel
 * `card` lane.
 *
 * Flags:
 *   --tree <slug>   tree discriminator override (default: basename of <dir>)
 *   --model <id>    embedding model override (default: seam → env → bge-m3)
 *   --dry-run       walk + fingerprint + report only, write nothing
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
import { defaultEmbedder } from "@repo/s2-agent-ext-knowledge-card/src/semantic.ts";

export const resourceIngestCommand = {
	name: "resource-ingest",
	summary: "index a document tree into the resource tier (L2 rows, kcard context_db)",
	details: `Usage:
  s2-agent cli resource-ingest <dir> [options]       index a markdown document tree

  Walks <dir> recursively (dot-directories and tier sidecars excluded), embeds
  every .md file via the semantic seam (per-tree content-hash cache: unchanged
  files embed zero times), and writes one level-2 row per file to the
  \`resource\` table in the kcard context_db. Per-tree fingerprint gate: an
  unchanged tree skips in milliseconds. The zettel card lane is untouched.

Options:
  --tree <slug>    tree discriminator override (default: basename of <dir>)
  --model <id>     embedding model override (default: seam → env → bge-m3)
  --dry-run        walk + fingerprint + report only, write nothing
  --json           JSON output

Examples:
  s2-agent cli resource-ingest "~/proj/study-news/ic-standard-spec/USB4 Specification November 2025/vlm-out"
  s2-agent cli resource-ingest ./docs --tree my-docs --dry-run`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const dir = parsed.positionals[0];
		if (!dir) throw new Error("No input dir. Usage: resource-ingest <dir>");
		const treePath = isAbsolute(dir) ? dir : resolve(cwd, dir);
		if (!existsSync(treePath) || !statSync(treePath).isDirectory()) {
			throw new Error(`Not a directory: ${dir} (resolved: ${treePath})`);
		}

		if (parsed.dryRun) {
			const built = await buildResourceRows({
				treePath,
				tree: parsed.tree,
				model: parsed.model,
				embedder: defaultEmbedder,
			});
			if (parsed.json) {
				console.log(
					JSON.stringify(
						{
							mode: "dry-run",
							tree: built.tree,
							files: built.rows.length,
							fingerprint: built.fingerprint,
							dim: built.dim,
							embedModel: built.embedModel,
							skipped: built.skipped,
						},
						null,
						2,
					),
				);
			} else {
				console.error(`tree:         ${built.tree} (${treePath})`);
				console.error(`files:        ${built.rows.length} (skipped ${built.skipped.length})`);
				console.error(`fingerprint:  ${built.fingerprint}`);
				console.error(`dim/model:    ${built.dim || "(embedder down)"} / ${built.embedModel}`);
				console.error("(dry-run — no writes)");
			}
			return;
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
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.error(`tree:        ${result.tree} (${treePath})`);
			console.error(`status:      ${result.skipped ? "SKIP (fingerprint match)" : "REBUILT"}`);
			console.error(`rows:        ${result.inserted}`);
			console.error(`embedded:    ${result.embedded} this run, ${result.cached} from cache`);
			console.error(`dim/model:   ${result.dim || "(no vectors)"} / ${result.embedModel}`);
			console.error(`elapsed:     ${result.elapsedMs}ms`);
		}
	},
};
