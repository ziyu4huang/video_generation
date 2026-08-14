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

/** Derived side-cache: entityKey/merged-input → summary. */
export interface EntitySummaryCache {
	[entityKey: string]: string;
}

/** Cache path mirroring semantic.ts's cachePath: <vault>/.knowledge-semantic/. */
function summaryCachePath(vaultPath: string, model: string): string {
	const slug = model.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	return join(vaultPath, ".knowledge-semantic", `entity-summaries-${slug}.json`);
}

/** Load the derived cache; missing/corrupt → {} (cache miss, non-fatal). */
export function loadEntitySummaries(vaultPath: string, model: string): EntitySummaryCache {
	try {
		const p = summaryCachePath(vaultPath, model);
		if (!existsSync(p)) return {};
		const j = JSON.parse(readFileSync(p, "utf8")) as EntitySummaryCache;
		return j && typeof j === "object" ? j : {};
	} catch {
		return {};
	}
}

/** Save the derived cache; write failure is silently swallowed (non-fatal). */
export function saveEntitySummaries(vaultPath: string, model: string, cache: EntitySummaryCache): void {
	try {
		const p = summaryCachePath(vaultPath, model);
		mkdirSync(join(vaultPath, ".knowledge-semantic"), { recursive: true });
		writeFileSync(p, JSON.stringify(cache, null, 2), "utf8");
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
export function augmentEmbedText(base: string, summary: string | undefined): string {
	if (!summary || summary.length === 0) return base;
	return `${summary.slice(0, 200)} ${base}`.slice(0, 1000);
}
