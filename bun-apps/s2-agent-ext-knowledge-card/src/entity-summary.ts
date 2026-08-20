/**
 * src/entity-summary.ts — LeanRAG ⑥ entity summaries (ticket 03 P2-T4).
 *
 * Same-entity descriptions (one per card mention, from the T2 extractor's
 * `ExtractedEntity.description`) are merged with " | " and, when the merged
 * text exceeds ~512 tokens, condensed via the T1 chat client (`llm-chat.ts`
 * `chatJson`) into plain prose that preserves key facts. The result is a
 * DERIVED-ONLY artifact: canonical card md is NEVER rewritten. It feeds the
 * embed input through `augmentEmbedText` (prefix, capped like
 * `semantic.ts`'s cardEmbedText) and is cached beside the semantic index at
 * `<vault>/.knowledge-semantic/entity-summaries-<modelSlug>.json`
 * (mirrors semantic.ts's cachePath pattern).
 *
 * NEVER-THROWS: every chat failure (HTTP error, timeout, unparseable) falls
 * back to the ORIGINAL merged text — the summary path can only degrade
 * gracefully, never block or fail the pipeline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatJson, type LmChatOptions } from "./llm-chat.ts";

/** Cheap heuristic: ~4 chars per token. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Merge same-entity descriptions: filter empties, join with " | ". */
export function mergeDescriptions(items: string[]): string {
	return items.filter((s) => s.trim().length > 0).join(" | ");
}

/** Merged text at-or-under this token budget is used as-is (no chat call). */
export const SUMMARY_TOKEN_THRESHOLD = 512;

/**
 * Condense an over-budget merged summary via the chat client. Under budget →
 * text returned unchanged with NO chat call. On chat null/throw → the ORIGINAL
 * text (never-throws, mirrors the llm-chat boundary).
 */
export async function condenseSummary(text: string, opts?: LmChatOptions): Promise<string> {
	if (estimateTokens(text) <= SUMMARY_TOKEN_THRESHOLD) return text;
	const prompt = [
		"Condense the following merged entity descriptions into one summary.",
		"Preserve key facts, plain prose, no lists, max 512 tokens.",
		"",
		text,
	].join("\n");
	const condensed = await chatJson<string>(
		prompt,
		(raw) => {
			const stripped = raw.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
			if (stripped.length === 0) throw new Error("empty condense output");
			return stripped;
		},
		opts,
	);
	// chatJson never throws; null (unparseable/HTTP/network) → original text.
	return condensed ?? text;
}

/** Derived side-cache: merged-input text → summary. The cache key is the
 * merged-input text itself (not an entity id), so distinct entities whose
 * descriptions merge to the same text share a cache entry. */
export interface EntitySummaryCache {
	[entityKey: string]: string;
}

/** On-disk cache file format version. A load-time mismatch (older shape,
 * newer shape, corrupt) resets the cache wholesale — safe because the cache
 * is derived and regenerates lazily on the next summaries pass. */
export const ENTITY_SUMMARY_CACHE_VERSION = 2;

/** Envelope written to disk; `version` gates interpretation of `entries`. */
interface EntitySummaryCacheFile {
	version: number;
	entries: EntitySummaryCache;
}

/** Cache path mirroring semantic.ts's cachePath: <vault>/.knowledge-semantic/. */
function summaryCachePath(vaultPath: string, model: string): string {
	const slug = model.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	return join(vaultPath, ".knowledge-semantic", `entity-summaries-${slug}.json`);
}

/*
 * PRUNE-ON-REBUILD — still deliberately NOT implemented here, and as of the
 * D6 merge-on-write change it CANNOT ride on save: saveEntitySummaries now
 * loads the on-disk entries and overlays the new ones on top, so summaries
 * persist across runs incrementally (partial regenerations no longer
 * discard previously condensed ones — the old wholesale-rewrite semantics
 * are gone). Consequence: a pruning consumer can no longer save a pruned
 * subset and expect eviction — the merge would resurrect whatever is
 * already on disk. Dead-entry eviction belongs in the summaries-pass
 * consumer: after iterating the FULL current entity set, rebuild to only
 * the entries it touched (lookup hits + regenerations) and replace the file
 * (delete-then-save or an explicit full rewrite). Content-keying makes
 * stale entries self-heal; dead entries merely accumulate (bounded by the
 * derived cache's lazily-regenerating nature) until that consumer lands.
 */

/** Load the derived cache; missing/corrupt/version-mismatch → {}
 * (cache miss, non-fatal; one-time wholesale reset on format change). */
export function loadEntitySummaries(vaultPath: string, model: string): EntitySummaryCache {
	try {
		const p = summaryCachePath(vaultPath, model);
		if (!existsSync(p)) return {};
		const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
		// Version gate: v1 files were plain { mergedText: summary } maps with no
		// envelope, so any old/foreign shape fails here and resets wholesale.
		if (
			!j ||
			typeof j !== "object" ||
			Array.isArray(j) ||
			(j as EntitySummaryCacheFile).version !== ENTITY_SUMMARY_CACHE_VERSION
		) {
			return {};
		}
		const { entries } = j as EntitySummaryCacheFile;
		return entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};
	} catch {
		return {};
	}
}

/**
 * Save the derived cache, MERGE-ON-WRITE (D6): the entries already on disk
 * are loaded and overlaid with the new ones, so a partial regeneration
 * never discards previously condensed summaries. Overlapping keys resolve
 * to the NEW value. Load failure (missing/corrupt/version-mismatch file) →
 * empty base — loadEntitySummaries already swallows those as {}, so a bad
 * on-disk file silently degrades to a fresh write rather than failing the
 * pipeline. Write failure is silently swallowed (non-fatal).
 */
export function saveEntitySummaries(vaultPath: string, model: string, cache: EntitySummaryCache): void {
	try {
		const p = summaryCachePath(vaultPath, model);
		mkdirSync(join(vaultPath, ".knowledge-semantic"), { recursive: true });
		const existing = loadEntitySummaries(vaultPath, model);
		const file: EntitySummaryCacheFile = {
			version: ENTITY_SUMMARY_CACHE_VERSION,
			entries: { ...existing, ...cache },
		};
		writeFileSync(p, JSON.stringify(file, null, 2), "utf8");
	} catch {
		// Derived-only artifact: a failed cache write must never fail the pipeline.
	}
}

/**
 * Merge + (over-threshold) condense a set of same-entity descriptions, with
 * optional memoization into a caller-owned cache. The cache key is the merged
 * input text — deterministic, so a hit short-circuits the chat call entirely.
 * Writes back to the cache ALWAYS (cheap, idempotent), mirroring the derived
 * side-cache contract. Never throws.
 */
export async function summarizeEntity(
	descriptions: string[],
	opts?: { chat?: LmChatOptions; cache?: EntitySummaryCache },
): Promise<string> {
	const merged = mergeDescriptions(descriptions);
	const cache = opts?.cache;
	if (cache && merged in cache) return cache[merged]!;
	try {
		const summary = await condenseSummary(merged, opts?.chat);
		if (cache) cache[merged] = summary;
		return summary;
	} catch {
		// Defensive: condenseSummary itself never throws, but a cache write or
		// unexpected failure must still return the merged raw text.
		return merged;
	}
}

/**
 * Prefix a summary onto an embed input. Summary is sliced to 200 chars and the
 * TOTAL capped at 1000 — mirroring semantic.ts's cardEmbedText budget. No
 * summary → base unchanged (zero behavior change when summaries are absent).
 * Wiring into the embed pipeline is deferred to the ③/20 integration.
 */
export function augmentEmbedText(base: string, summary: string | null | undefined): string {
	if (!summary || summary.length === 0) return base;
	return `${summary.slice(0, 200)} ${base}`.slice(0, 1000);
}
