/**
 * Regression guard for the `memory_search` 10s-timeout root cause (wayfinder
 * effort `.planning/2026-07-30-hermes-failure-memory-md-41-112-71-memory-search/`,
 * ticket 00).
 *
 * `SurrealMemoryRepository.fetchGraphNeighbors` must use SurrealDB's NATIVE
 * graph traversal (`->tagged->tag`), NOT a nested `IN (SELECT…)` subquery over
 * the `tagged` edge table. SurrealDB's planner pathologically under-optimizes
 * the nested `id IN (SELECT VALUE in FROM tagged WHERE out IN (SELECT …))`
 * shape — measured at ~8–16s vs ~0.05s for the native form at ~1k memories /
 * ~30k edges — which made `memory_search` time out at its 10s limit every call.
 *
 * This is a contract test on the query the code SENDS to SurrealDB (captured via
 * a spy client), because the pathological slowness cannot be reproduced at the
 * small data volume of an integration test. The query shape IS the bug.
 */
import { describe, it, expect } from "bun:test";
import { SurrealMemoryRepository } from "../../../src/store/surreal/surreal-memory-repo.js";
import type { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";

/** A lexical seed row the FTS step returns, so search proceeds to graph fetch. */
const SEED_ROW = {
	seq: 1, project: "p1", target: "memory", category: null, content: "seed needle",
	failureReason: null, toolState: null, correctedTo: null,
	created: "2026-07-30", lastReferenced: "2026-07-30",
};

describe("SurrealMemoryRepository graph query shape", () => {
	it("fetchGraphNeighbors uses native graph traversal, not a nested IN-subquery over tagged", async () => {
		const queries: string[] = [];
		const fakeBackend = {
			client: {
				query: async (sql: string) => {
					queries.push(sql);
					// Drive searchMemories through to the graph step: the lexical
					// (FTS/contains) step returns a seed; everything else → empty.
					return /content @@|string::contains/.test(sql) ? [SEED_ROW] : [];
				},
			},
		} as unknown as SurrealBackend;
		const repo = new SurrealMemoryRepository(fakeBackend);

		await repo.searchMemories("needle", { target: "memory", project: "p1" });

		const graphQuery = queries.find((q) => q.includes("tagged"));
		expect(graphQuery, "a graph-neighbor query was issued").toBeDefined();
		// Native graph traversal (what SurrealDB optimizes):
		expect(graphQuery).toMatch(/->tagged->tag/);
		// NOT the pathologically-slow nested subquery shape:
		expect(graphQuery).not.toMatch(/SELECT VALUE in FROM tagged WHERE out IN/);
		expect(graphQuery).not.toMatch(/IN \(SELECT VALUE id FROM tag/);
	});
});
