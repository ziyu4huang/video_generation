/**
 * Phase 4 — index coherence (WS-A5 external-edit detection + WS-C3 incremental
 * reindex). The file cache (readCached) is already mtime-coherent per read, so
 * these tests target the INDEX: byTag / byTitle / reverseAdjacency must reflect
 * external edits (simulating a note changed in the Obsidian app mid-session)
 * without a full rebuild and without leaking stale entries.
 *
 * Each test gets a FRESH fixture (beforeEach) so on-disk mutations in one test
 * cannot contaminate another.
 *
 *   bun test extensions/__tests__/indexCoherence.test.mjs
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import {
	getIndex,
	dropIndex,
	refreshIndex,
	reindexFile,
	appendUnderHeading,
	updateFrontmatter,
	searchVault,
	buildMatcher,
	trigramCandidates,
} from "../obsidian.ts";
import { writeFile, unlink, utimes, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

// Disable the refresh throttle for deterministic, fast coherence tests.
beforeAll(() => {
	process.env.OB_INDEX_POLL_MS = "0";
});

const NOTES = {
	"alpha.md": "# Alpha\n\ntag #red. links [[Bravo]].\n",
	"bravo.md": "# Bravo\n\ntag #blue. links [[Alpha]].\n",
	"orphan.md": "# Orphan\n\nnothing here.\n",
};

let vault;
beforeEach(async () => {
	vault = await makeFixture(NOTES);
});
afterEach(async () => {
	dropIndex(vault);
	await rmFixture(vault);
});

/** Force a mtime change distinct from the current one (deterministic on any fs). */
async function touchLater(abs, content) {
	await writeFile(abs, content, "utf8");
	const future = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000); // +1 min
	await utimes(abs, future, future);
}

describe("Phase 4 / WS-A5 — refreshIndex picks up external edits", () => {
	it("detects a content change (mtime bump) and updates byTag + title", async () => {
		const idx = await getIndex(vault);
		const origTitle = idx.notes.get("alpha.md")?.title;
		expect(origTitle).toBe("alpha");
		expect([...(idx.byTag.get("red") ?? [])]).toContain("alpha.md");

		// External edit: alpha retitled (H1) + retagged.
		await touchLater(join(vault, "alpha.md"), "# Renamed\n\ntag #green.\n");

		const diff = await refreshIndex(idx, { force: true });
		expect(diff.changed).toBe(1);
		expect(diff.added).toBe(0);
		expect(diff.deleted).toBe(0);

		// New title + tag present; note's stored title flipped.
		expect(idx.byTitle.get("renamed")).toBe("alpha.md");
		expect(idx.notes.get("alpha.md")?.title).toBe("renamed");
		expect([...(idx.byTag.get("green") ?? [])]).toContain("alpha.md");
		// Old TAG entry cleared (red no longer maps to alpha.md).
		expect([...(idx.byTag.get("red") ?? [])]).not.toContain("alpha.md");
	});

	it("detects a file added externally", async () => {
		const idx = await getIndex(vault);
		expect(idx.notes.size).toBe(3);
		await mkdir(join(vault, "Inbox"), { recursive: true });
		await writeFile(join(vault, "Inbox", "new.md"), "# Fresh\n\ntag #new.\n", "utf8");

		const diff = await refreshIndex(idx, { force: true });
		expect(diff.added).toBe(1);
		expect(idx.notes.has("Inbox/new.md")).toBe(true);
		expect(idx.byTitle.get("fresh")).toBe("Inbox/new.md");
		expect([...(idx.byTag.get("new") ?? [])]).toContain("Inbox/new.md");
	});

	it("detects a file deleted externally and clears its index entries", async () => {
		const idx = await getIndex(vault);
		expect(idx.notes.has("orphan.md")).toBe(true);
		await unlink(join(vault, "orphan.md"));

		const diff = await refreshIndex(idx, { force: true });
		expect(diff.deleted).toBe(1);
		expect(idx.notes.has("orphan.md")).toBe(false);
		// Title key for the H1 ("orphan") is gone; path/basename key "orphan" gone too.
		expect(idx.byTitle.get("orphan")).toBeUndefined();
	});

	it("recomputes reverseAdjacency after an edit (backlinks stay correct)", async () => {
		const idx = await getIndex(vault);
		// bravo initially links [[Alpha]].
		expect([...(idx.reverseAdjacency.get("alpha.md") ?? [])]).toContain("bravo.md");

		// External edit: bravo now links [[Orphan]] instead.
		await touchLater(join(vault, "bravo.md"), "# Bravo\n\nnow links [[Orphan]].\n");
		await refreshIndex(idx, { force: true });

		expect([...(idx.reverseAdjacency.get("alpha.md") ?? [])]).not.toContain("bravo.md");
		expect([...(idx.reverseAdjacency.get("orphan.md") ?? [])]).toContain("bravo.md");
	});
});

describe("Phase 4 / WS-C3 — getIndex reconciles incrementally (no full rebuild)", () => {
	it("a second getIndex reflects an external edit without dropIndex", async () => {
		const idx1 = await getIndex(vault);
		expect(idx1.notes.get("alpha.md")?.title).toBe("alpha");

		await touchLater(join(vault, "alpha.md"), "# Retitled\n\nbody.\n");
		const idx2 = await getIndex(vault); // same cached index, refreshed in place

		expect(idx2).toBe(idx1); // NOT a fresh object → no full rebuild
		expect(idx2.notes.get("alpha.md")?.title).toBe("retitled");
	});

	it("reindexFile (write path) and refreshIndex (external path) agree", async () => {
		const idx = await getIndex(vault);
		await touchLater(join(vault, "orphan.md"), "# NewName\n\ntag #zz.\n");
		await reindexFile(vault, "orphan.md");
		expect(idx.byTitle.get("newname")).toBe("orphan.md");
		// A subsequent force refresh sees 0 changed (reindexFile already synced mtime).
		const diff = await refreshIndex(idx, { force: true });
		expect(diff.changed).toBe(0);
	});
});

describe("Phase 4 — throttle gate", () => {
	it("non-force refresh within the poll window is a no-op even if files changed", async () => {
		process.env.OB_INDEX_POLL_MS = "60000";
		try {
			const idx = await getIndex(vault); // build + sets refreshAt
			await touchLater(join(vault, "alpha.md"), "# Sneaky\n\nchange.\n");

			const diff = await refreshIndex(idx, { force: false });
			expect(diff.changed).toBe(0); // throttled — did not scan
			expect(idx.notes.get("alpha.md")?.title).toBe("alpha"); // unchanged

			// force bypasses the gate.
			const forced = await refreshIndex(idx, { force: true });
			expect(forced.changed).toBe(1);
			expect(idx.notes.get("alpha.md")?.title).toBe("sneaky");
		} finally {
			process.env.OB_INDEX_POLL_MS = "0";
		}
	});
});

describe("write paths invalidate the index — trigram search sees just-written content", () => {
	it("appendUnderHeading reindexes so a just-appended token is findable within the throttle window", async () => {
		// With the default poll window, refreshIndex(force:false) right after a write
		// is a no-op. Without reindexFile in the write path, idx.trigrams stays stale
		// and trigramCandidates short-circuits to an empty set for a token new to the
		// vault → substring search returns 0 results even though content is on disk.
		process.env.OB_INDEX_POLL_MS = "60000";
		try {
			// Build + cache the index (sets refreshAt).
			const idx = await getIndex(vault);

			const TOKEN = "zzzqxjuniquetoken";
			await appendUnderHeading(vault, "alpha.md", "Notes", `${TOKEN} appears now`);

			// Mirror the obsidian_search tool's substring path exactly: a throttled
			// refreshIndex(force:false) is a no-op right after the write, so idx.trigrams
			// reflects pre-write state unless the write path called reindexFile. The tool
			// then narrows candidates via trigramCandidates and feeds them to searchVault
			// as `paths` — an empty candidate set yields zero results (false negative).
			await refreshIndex(idx, { force: false });
			const cand = trigramCandidates(idx, TOKEN);
			const paths = cand ? [...cand] : undefined;
			const m = buildMatcher(TOKEN, "substring", false);
			const rec = await searchVault(vault, {
				match: m.match,
				fields: null,
				folder: "",
				sort: "file",
				max: 100,
				paths,
			});
			expect(rec.some((r) => r.file === "alpha.md")).toBe(true);
		} finally {
			process.env.OB_INDEX_POLL_MS = "0";
		}
	});

	it("updateFrontmatter reindexes so a just-added tag is findable within the throttle window", async () => {
		// updateFrontmatter used to dropIndex (full rebuild on next read), leaving a
		// caller's held idx detached/stale. It now reindexes the one note in place,
		// matching appendUnderHeading / obsidian_create / _append — so byTag reflects
		// the new frontmatter tag immediately, even under a throttled (no-op) refresh.
		process.env.OB_INDEX_POLL_MS = "60000";
		try {
			const idx = await getIndex(vault);
			// alpha.md starts with inline tag #red only (no frontmatter tags key).
			expect([...(idx.byTag.get("red") ?? [])]).toContain("alpha.md");
			expect(idx.byTag.get("newfrontmatter")).toBeUndefined();

			await updateFrontmatter(vault, "alpha.md", {
				tags: ["red", "newfrontmatter"],
			});

			// A throttled refresh does NOT reconcile disk → the write path must have.
			await refreshIndex(idx, { force: false });
			expect([...(idx.byTag.get("newfrontmatter") ?? [])]).toContain("alpha.md");
		} finally {
			process.env.OB_INDEX_POLL_MS = "0";
		}
	});
});
