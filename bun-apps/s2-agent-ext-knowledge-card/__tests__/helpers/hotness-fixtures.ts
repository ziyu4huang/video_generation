/**
 * hotness-fixtures.ts — shared fixtures for __tests__/hotness.test.ts
 * (kcard-parity ticket 08). Keeps the temp-vault ingest shape identical to
 * retrieve.test.ts's local `rec()`/`ingest()` pair.
 */
import type { KnowledgeRecord } from "../../src/types.ts";
import { slugify } from "../../src/card-format.ts";

export const FOLDER = "Zettelkasten/knowledge-graph";

/** A minimal active record with the given id + tags (hotness cares only
 *  about ranking shape: shared-tag counts). */
export function rec(id: string, tags: string[]): KnowledgeRecord {
	return {
		id: `t08:${id}`,
		type: "pattern",
		title: id,
		detail: `Detail for ${id}.`,
		tags,
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
	};
}

/** The index stem (md filename minus .md) a `rec(id)` card lands at — the
 *  `usage` table's key domain (D9: record key = md filename stem). */
export const stemsOf = new Proxy({} as Record<string, string>, {
	get(_t, id: string) {
		return slugify(`t08:${id}`);
	},
});
