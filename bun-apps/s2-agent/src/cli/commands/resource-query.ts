/**
 * `resource-query <text>` — flat KNN retrieval over the kcard resource tier
 * (effort 2026-08-25-kcard-resource-tier, ticket 01's read surface; the
 * recursive directory-descent lane is ticket 03).
 *
 * Embeds the query (same seam/model as the index), runs KNN over the
 * `resource` table, prints uri + name + abstract preview + cosine sim.
 * Degrades to `semantic:false` with a plain message when the embedder or the
 * index is down — never throws at the caller.
 *
 * Flags:
 *   --tree <slug>   restrict hits to one tree (default: all trees)
 *   --top-k <n>     max hits (default 10)
 *   --model <id>    embedding model override
 *   --json          JSON output
 */
import type { ParsedArgs } from "../args.ts";
import {
	makeResourceClient,
	resourceKnnQuery,
} from "@repo/s2-agent-ext-knowledge-card/src/resource-index.ts";
import { defaultEmbedder } from "@repo/s2-agent-ext-knowledge-card/src/semantic.ts";

export const resourceQueryCommand = {
	name: "resource-query",
	summary: "flat KNN search over the resource tier (document-tree rows)",
	details: `Usage:
  s2-agent cli resource-query <text> [options]       flat vector search over resource rows

  Embeds the query via the semantic seam and runs KNN over the \`resource\`
  table (level-2 document rows today; L0/L1 directory tiers land with the
  semantic-tier ticket). Hits print uri + name + abstract preview + cosine.

Options:
  --tree <slug>    restrict hits to one tree (default: all trees)
  --top-k <n>      max hits (default 10)
  --model <id>     embedding model override (must match the index's model)
  --json           JSON output

Examples:
  s2-agent cli resource-query "PM Packet CLx low power states" --tree usb4-specification-2.0-november-2025-clean
  s2-agent cli resource-query "router topology discovery" --top-k 5 --json`,
	async run(parsed: ParsedArgs): Promise<void> {
		const text = parsed.positionals.join(" ").trim();
		if (!text) throw new Error("No query text. Usage: resource-query <text>");
		const client = makeResourceClient();
		const result = await resourceKnnQuery({
			client,
			query: text,
			tree: parsed.tree,
			topK: parsed.topK,
			model: parsed.model,
			embedder: defaultEmbedder,
		});
		if (parsed.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.error(`tree:     ${result.tree ?? "(all)"}   query: ${result.query}`);
			console.error(`semantic: ${result.semantic}   hits: ${result.hits.length}   elapsed: ${result.elapsedMs}ms`);
			console.error();
			if (result.hits.length === 0) {
				console.log(
					result.semantic
						? "(no hits — the index may be empty; run resource-ingest first)"
						: "(embedding unavailable — the semantic seam is down; nothing queried)",
				);
			}
			for (const [i, h] of result.hits.entries()) {
				console.log(`${i + 1}. [L${h.level}] ${h.uri}  (${h.sim.toFixed(4)})`);
				console.log(`   ${h.name}`);
				const preview = h.abstract.slice(0, 160).replace(/\s+/g, " ");
				if (preview) console.log(`   ${preview}${h.abstract.length > 160 ? "…" : ""}`);
			}
		}
	},
};
