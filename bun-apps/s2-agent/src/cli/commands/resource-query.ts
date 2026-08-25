/**
 * `resource-query <text>` — retrieval over the kcard resource tier (effort
 * 2026-08-25-kcard-resource-tier; flat lane = ticket 01, recursive lane =
 * ticket 03, map D6).
 *
 * `--mode flat` (default): plain KNN over the `resource` table.
 * `--mode recursive`: the heap lane — a global L0/L1 seed pass, best-first
 * directory descent (≤4 dirs/round), `α·child + (1−α)·parent` score
 * propagation, ≤3 convergence rounds, and a descent trajectory per hit.
 * Opt-in: the flat default (and the zettel card lane) is untouched.
 *
 * Tiered loading (`--tier 0|1|2`, default 2 = everything): filters hits to
 * `level ≤ tier`; with `--root <path>` an L2 hit's body is read lazily from
 * the source tree (capped preview) — no root, no file reads.
 *
 * Degrades to `semantic:false` with a plain message when the embedder or the
 * index is down — never throws at the caller.
 *
 * Flags:
 *   --mode <lane>    flat (default) | recursive
 *   --tree <slug>    restrict hits to one tree (default: all trees)
 *   --top-k <n>      max hits (default 10)
 *   --alpha <f>      recursive lane: score propagation α (default 0.5)
 *   --tier <0|1|2>   max result level (default 2); 2 + --root reads L2 bodies
 *   --root <path>    source-tree root for lazy L2 body promotion
 *   --model <id>     embedding model override
 *   --json           JSON output
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ParsedArgs } from "../args.ts";
import {
	makeResourceClient,
	resourceKnnQuery,
} from "@repo/s2-agent-ext-knowledge-card/src/resource-index.ts";
import {
	resourceRecursiveQuery,
	RECURSIVE_DEFAULT_ALPHA,
	type RecursiveHit,
} from "@repo/s2-agent-ext-knowledge-card/src/resource-recursive.ts";
import { defaultEmbedder } from "@repo/s2-agent-ext-knowledge-card/src/semantic.ts";

/** Lazy L2 body preview cap — enough to judge the hit, not the whole page. */
const TIER2_BODY_PREVIEW = 600;

function parseTier(raw: string | undefined): number {
	if (raw === undefined) return 2;
	if (raw === "0" || raw === "1" || raw === "2") return Number(raw);
	throw new Error(`--tier must be 0, 1, or 2 (got: ${raw})`);
}

/** Read an L2 hit's body from the source tree (degrades to null — a moved or
 *  deleted file must not fail the query that found its row). The uri comes
 *  from the DB, so containment is checked: a `../`-bearing row must not read
 *  outside the tree root (reviewer N6). */
function tier2Body(root: string, uri: string): string | null {
	try {
		const abs = resolve(root, uri);
		const rootAbs = resolve(root);
		if (abs !== rootAbs && !abs.startsWith(rootAbs + "/")) return null;
		const text = readFileSync(abs, "utf8");
		return text.replace(/\s+/g, " ").trim().slice(0, TIER2_BODY_PREVIEW) || null;
	} catch {
		return null;
	}
}

/** Tier-aware empty message — a tier-capped query with zero hits means the
 *  top matches lived at other levels, not that the index is empty (S1). */
function emptyMessage(semantic: boolean, tier: number): string {
	if (!semantic) return "(embedding unavailable — the semantic seam is down; nothing queried)";
	if (tier < 2) return `(no hits at level <= ${tier} — the top matches are other levels; try --tier 2)`;
	return "(no hits — the index may be empty; run resource-ingest first)";
}

export const resourceQueryCommand = {
	name: "resource-query",
	summary: "search the resource tier (flat KNN or recursive directory descent)",
	details: `Usage:
  s2-agent cli resource-query <text> [options]       vector search over resource rows

  --mode flat (default) runs plain KNN over the \`resource\` table.
  --mode recursive runs the heap lane: a global L0/L1 seed pass ranks
  directories, a best-first descent expands the top ≤4 per round with KNN
  scoped to their direct children, scores propagate as
  \`alpha*child + (1-alpha)*parent\`, and the loop stops after 3 stable or
  stagnant rounds. Every hit carries the descent trajectory that produced it.

Options:
  --mode <lane>     flat (default) | recursive
  --tree <slug>     restrict hits to one tree (default: all trees)
  --top-k <n>       max hits (default 10)
  --alpha <f>       recursive: score propagation alpha (default 0.5)
  --tier <0|1|2>    max result level (default 2; L2 = file rows)
  --root <path>     source-tree root — with --tier 2, L2 bodies load lazily
  --model <id>      embedding model override (must match the index's model)
  --json            JSON output

Examples:
  s2-agent cli resource-query "PM Packet CLx low power states" --tree usb4-specification-2.0-november-2025-clean
  s2-agent cli resource-query "where is CLx power management defined" --mode recursive --tier 2 --root ~/spec-tree
  s2-agent cli resource-query "router topology discovery" --mode recursive --alpha 0.3 --top-k 5 --json`,
	async run(parsed: ParsedArgs): Promise<void> {
		const text = parsed.positionals.join(" ").trim();
		if (!text) throw new Error("No query text. Usage: resource-query <text>");
		const tier = parseTier(parsed.tier);
		if (parsed.alpha !== undefined && parsed.alpha > 1) {
			throw new Error(`--alpha must be within 0..1 (got: ${parsed.alpha})`);
		}
		const root = parsed.root ? (isAbsolute(parsed.root) ? parsed.root : resolve(process.cwd(), parsed.root)) : null;
		const client = makeResourceClient();

		if (parsed.retrievalMode === "recursive") {
			const result = await resourceRecursiveQuery({
				client,
				query: text,
				tree: parsed.tree,
				topK: parsed.topK,
				model: parsed.model,
				embedder: defaultEmbedder,
				alpha: parsed.alpha ?? RECURSIVE_DEFAULT_ALPHA,
				// Filter at COLLECTION time (upstream's `level` param) — a
				// post-hoc filter on a sliced top-k starves (reviewer S1).
				maxLevel: tier,
			});
			const hits = result.hits.map((h) =>
				tier === 2 && h.level === 2 && root
					? { ...h, body: tier2Body(root, h.uri) }
					: h,
			);
			if (parsed.json) {
				console.log(JSON.stringify({ ...result, hits }, null, 2));
				return;
			}
			console.error(
				`tree:     ${result.tree ?? "(all)"}   query: ${result.query}   alpha: ${result.alpha}`,
			);
			console.error(
				`semantic: ${result.semantic}   hits: ${hits.length}   stop: ${result.stop}   seeds: ${result.seedCount}   rounds: ${result.rounds}   dirs: ${result.expandedDirs}   elapsed: ${result.elapsedMs}ms`,
			);
			console.error();
			if (hits.length === 0) {
				console.log(emptyMessage(result.semantic, tier));
			}
			for (const [i, h] of hits.entries()) {
				console.log(`${i + 1}. [L${h.level}] ${h.uri}  (${h.sim.toFixed(4)})`);
				console.log(`   via: ${h.trajectory.join(" → ")}`);
				console.log(`   ${h.name}`);
				const preview = h.abstract.slice(0, 160).replace(/\s+/g, " ");
				if (preview) console.log(`   ${preview}${h.abstract.length > 160 ? "…" : ""}`);
				if ((h as RecursiveHit & { body?: string | null }).body) {
					console.log(`   body: ${(h as RecursiveHit & { body: string }).body}`);
				}
			}
			return;
		}

		const result = await resourceKnnQuery({
			client,
			query: text,
			tree: parsed.tree,
			// Tier-capped flat queries over-fetch 5x then filter+slice — the
			// same starvation guard the recursive lane solves with maxLevel
			// (reviewer S1); the flat lane has no collection-time filter hook.
			topK: tier < 2 ? Math.max(1, (parsed.topK ?? 10) * 5) : parsed.topK,
			model: parsed.model,
			embedder: defaultEmbedder,
		});
		const hits = tier < 2 ? result.hits.filter((h) => h.level <= tier).slice(0, parsed.topK ?? 10) : result.hits;
		if (parsed.json) {
			console.log(JSON.stringify({ ...result, hits }, null, 2));
		} else {
			console.error(`tree:     ${result.tree ?? "(all)"}   query: ${result.query}`);
			console.error(`semantic: ${result.semantic}   hits: ${hits.length}   elapsed: ${result.elapsedMs}ms`);
			console.error();
			if (hits.length === 0) {
				console.log(emptyMessage(result.semantic, tier));
			}
			for (const [i, h] of hits.entries()) {
				console.log(`${i + 1}. [L${h.level}] ${h.uri}  (${h.sim.toFixed(4)})`);
				console.log(`   ${h.name}`);
				const preview = h.abstract.slice(0, 160).replace(/\s+/g, " ");
				if (preview) console.log(`   ${preview}${h.abstract.length > 160 ? "…" : ""}`);
			}
		}
	},
};
