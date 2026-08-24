/**
 * resource-index live round-trip (effort 2026-08-25-kcard-resource-tier,
 * ticket 01) — rebuild + KNN against a THROWAWAY SurrealDB namespace + scratch
 * database (the PR #2008 receipt lesson: NEVER rebuild against the live
 * `context_db` — a scratch `database:` on makeContextClient scopes every
 * statement away from production). Skipped when the local SurrealDB service
 * is down (hermes _helpers / eval-gate pattern); no LM Studio dependency —
 * a deterministic 8-dim fake embedder rides the injectable seam.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient, SURREAL_DEFAULTS } from "@repo/s2-agent-core-interface";
import {
	makeResourceClient,
	rebuildResourceIndex,
	resourceKnnQuery,
	resourceMetaStatus,
} from "../src/resource-index.ts";

const NS = "kcard_resource_test";
const DB = "resource_receipt_tmp";

async function isSurrealUp(endpoint: string = SURREAL_DEFAULTS.endpoint): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 1500);
		const res = await fetch(`${endpoint}/health`, { signal: ctrl.signal });
		clearTimeout(t);
		return res.ok;
	} catch {
		return false;
	}
}

// Deterministic embedder: a stable 8-dim vector per text — the query for
// "alpha" lands nearest the file whose embed text carries "alpha" heaviest.
const fakeEmbedder = async (texts: string[]): Promise<number[][]> =>
	texts.map((t) => {
		const v = new Array<number>(8).fill(0);
		for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 8] += 1;
		const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
		return v.map((x) => x / norm);
	});

const up = await isSurrealUp();
const client: SurrealClient = up
	? makeResourceClient({ namespace: NS, database: DB, requestTimeoutMs: 30_000 })
	: (undefined as unknown as SurrealClient);
const root = up ? mkdtempSync(join(tmpdir(), "kcard-resource-live-")) : "";

afterAll(async () => {
	if (up) {
		try {
			await client.query(`REMOVE DATABASE IF EXISTS ${DB};`);
			await client.query(`REMOVE NAMESPACE IF EXISTS ${NS};`);
		} catch {
			// teardown best-effort
		}
	}
	if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!up)("resource round-trip (live Surreal, scratch ns/db)", () => {
	test(
		"rebuild → rows land, meta stamps, second run skips, edit forces rebuild, KNN hits",
		async () => {
			// scratch hygiene: start from a clean db for THIS run
			await client.query(`REMOVE DATABASE IF EXISTS ${DB};`);
			await client.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};\nDEFINE DATABASE IF NOT EXISTS ${DB};`);

			mkdirSync(join(root, "pages"), { recursive: true });
			writeFileSync(join(root, "pages", "alpha.md"), "# Alpha Router\n\nAlpha topic body content.", "utf8");
			writeFileSync(join(root, "pages", "beta.md"), "# Beta Adapter\n\nBeta topic body content.", "utf8");
			writeFileSync(join(root, "readme.md"), "# Tree Root\n\nOverview prose.", "utf8");

			const r1 = await rebuildResourceIndex({
				client,
				treePath: root,
				tree: "fixture",
				model: "fake-model",
				embedder: fakeEmbedder,
			});
			expect(r1.skipped).toBe(false);
			expect(r1.inserted).toBe(3);
			expect(r1.dim).toBe(8);

			const status = await resourceMetaStatus(client, "fixture");
			expect(status.present).toBe(true);
			expect(status.fingerprint).toBe(r1.fingerprint);
			expect(status.rowCount).toBe(3);

			// Fingerprint gate: unchanged tree → skip.
			const r2 = await rebuildResourceIndex({
				client,
				treePath: root,
				tree: "fixture",
				model: "fake-model",
				embedder: fakeEmbedder,
			});
			expect(r2.skipped).toBe(true);

			// Single-file edit → rebuild, delta embed = 1.
			writeFileSync(join(root, "pages", "beta.md"), "# Beta Adapter\n\nEDITED beta body.", "utf8");
			const r3 = await rebuildResourceIndex({
				client,
				treePath: root,
				tree: "fixture",
				model: "fake-model",
				embedder: fakeEmbedder,
			});
			expect(r3.skipped).toBe(false);
			expect(r3.embedded).toBe(1);
			expect(r3.cached).toBe(2);

			// Flat KNN: the alpha-heavy query lands alpha.md first.
			const q = await resourceKnnQuery({
				client,
				query: "Alpha Router alpha topic",
				tree: "fixture",
				topK: 3,
				model: "fake-model",
				embedder: fakeEmbedder,
			});
			expect(q.semantic).toBe(true);
			expect(q.hits.length).toBeGreaterThan(0);
			expect(q.hits[0]!.uri).toBe("pages/alpha.md");
			expect(q.hits[0]!.level).toBe(2);

			// Cross-tree isolation: a second tree's rebuild must not disturb the first.
			const root2 = mkdtempSync(join(tmpdir(), "kcard-resource-live2-"));
			try {
				writeFileSync(join(root2, "other.md"), "# Other Tree\n\nOther body.", "utf8");
				await rebuildResourceIndex({ client, treePath: root2, tree: "second", model: "fake-model", embedder: fakeEmbedder });
				const s1 = await resourceMetaStatus(client, "fixture");
				expect(s1.rowCount).toBe(3); // untouched
				const s2 = await resourceMetaStatus(client, "second");
				expect(s2.rowCount).toBe(1);
			} finally {
				rmSync(root2, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
