/**
 * Ticket 14 (context-lifecycle P3): per-run memory diff (`.distill-diff.json`).
 *
 * Covers the acceptance:
 *  - the diff is written EVERY converge run, atomically (tmp+rename);
 *  - crash mid-run / mid-write leaves the previous run's diff intact;
 *  - REPLAY: applying the diff's created/merged field ops to a pre-run
 *    snapshot reconstructs the post-run card state (supersede is a
 *    frontmatter flip, asserted directly);
 *  - shape: {runId, at, target, created[], merged[](ops), superseded[](found),
 *    skipped[](reason)}.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConverge } from "../../src/distill/converge.ts";
import { writeDiff, readDiff } from "../../src/distill/state.ts";
import type { DistillDiff, DistillDiffFieldOp } from "../../src/distill/types.ts";
import type { EnrichedNote } from "../../src/distill/types.ts";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";

const FOLDER = "Zettelkasten/knowledge-graph";

let vault: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "distill-diff-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

const note = (over: Partial<EnrichedNote> = {}): EnrichedNote => ({
	id: "distill:note-1",
	type: "gotcha",
	title: "Note one",
	detail: "Original detail.",
	tags: ["a"],
	confidence: 0.8,
	...over,
});

const metrics = { candidates: 2, killed: 1, survivors: 1 };
const killed = [{ id: "hermes:failure:dup-1", reason: "duplicate", detail: "token-jaccard 0.91 vs entry 2" }];

describe("writeDiff / readDiff (atomic writer)", () => {
	test("tmp+rename: a failing write leaves the previous diff intact, no tmp debris", () => {
		const d1: DistillDiff = { runId: "r1", at: "r1", target: "failure", created: [{ id: "x", path: `${FOLDER}/x` }], merged: [], superseded: [], skipped: [] };
		writeDiff(vault, d1);
		expect(readDiff(vault)?.runId).toBe("r1");
		// A serialization failure (circular ref) throws BEFORE the tmp file is
		// touched — the previous diff survives untouched.
		const bad: Record<string, unknown> = {};
		bad.self = bad;
		expect(() => writeDiff(vault, bad as unknown as DistillDiff)).toThrow();
		expect(readDiff(vault)?.runId).toBe("r1");
		expect(readdirSync(vault).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		// A successful second write swaps atomically — file is exactly d2.
		const d2: DistillDiff = { ...d1, runId: "r2", at: "r2", created: [] };
		writeDiff(vault, d2);
		expect(readDiff(vault)?.runId).toBe("r2");
		expect(existsSync(join(vault, ".distill-diff.json.tmp"))).toBe(false);
	});

	test("readDiff: absent → null; corrupt → null (never throws)", () => {
		expect(readDiff(vault)).toBeNull();
		writeFileSync(join(vault, ".distill-diff.json"), "{torn", "utf8");
		expect(readDiff(vault)).toBeNull();
	});
});

describe("runConverge memory diff", () => {
	test("created run: diff written beside state, full shape", async () => {
		const result = await runConverge([note()], vault, metrics, "failure", killed);
		expect(existsSync(join(vault, ".distill-diff.json"))).toBe(true);
		const diff = readDiff(vault)!;
		expect(diff.runId).toBe(result.diff?.runId ?? "");
		expect(diff.target).toBe("failure");
		expect(diff.created).toEqual([{ id: "distill:note-1", path: `${FOLDER}/distill-note-1.md` }]);
		expect(diff.merged).toEqual([]);
		expect(diff.superseded).toEqual([]);
		expect(diff.skipped).toEqual(killed);
		// runId matches the state's lastRun entry (the audit join key).
		const state = JSON.parse(readFileSync(join(vault, ".distill-state.json"), "utf8"));
		expect(diff.runId).toBe(state.lastRun);
	});

	test("skipped defaults to [] when no gate context is passed", async () => {
		await runConverge([note()], vault, metrics);
		expect(readDiff(vault)?.skipped).toEqual([]);
	});

	test("REPLAY: applying merged ops to the pre-run snapshot reconstructs the post-run card", async () => {
		await runConverge([note()], vault, metrics);
		const cardAbs = join(vault, FOLDER, "distill-note-1.md");
		const preRaw = readFileSync(cardAbs, "utf8"); // pre-run snapshot (run 2)

		// Run 2 converges the ENRICHED v2 of the same note (union tags +
		// replaced confidence/body → an "updated" card with field ops).
		const v2 = note({
			detail: "Enriched detail with the mechanism spelled out.",
			tags: ["a", "b", "c"],
			confidence: 0.95,
		});
		const result = await runConverge([v2], vault, metrics);
		expect(result.updated).toBe(1);
		const diff = readDiff(vault)!;
		expect(diff.created).toEqual([]);
		expect(diff.merged.length).toBe(1);
		const entry = diff.merged[0]!;
		expect(entry.id).toBe("distill:note-1");

		// Replay: pre frontmatter + ops → assert equals post frontmatter on
		// EVERY field (ops cover exactly the changed fields — both directions).
		const postRaw = readFileSync(cardAbs, "utf8");
		const pre = parseFrontmatter(preRaw).data ?? {};
		const post = parseFrontmatter(postRaw).data ?? {};
		const replayed: Record<string, unknown> = { ...pre };
		for (const op of entry.ops as DistillDiffFieldOp[]) {
			if (op.field === "body") continue; // coarse body marker, not a frontmatter field
			if (op.op === "union") {
				const cur = Array.isArray(replayed[op.field]) ? [...replayed[op.field] as unknown[]] : [];
				replayed[op.field] = [...cur, ...((op.value as unknown[]) ?? [])];
			} else {
				replayed[op.field] = op.value;
			}
		}
		const keys = new Set([...Object.keys(pre), ...Object.keys(post)]);
		for (const k of keys) {
			expect(replayed[k], `field ${k}: replay must equal the real post-run value`).toEqual(post[k]);
		}
		// The op set is exact: every field NOT mentioned was unchanged.
		const opFields = new Set(entry.ops.map((o) => o.field));
		for (const k of keys) {
			if (!opFields.has(k)) {
				expect(pre[k], `unchanged field ${k} must be identical pre/post`).toEqual(post[k]);
			}
		}
		// And the body marker fired (the detail changed).
		expect(opFields.has("body")).toBe(true);
	});

	test("supersede recorded as a frontmatter flip with found=true", async () => {
		mkdirSync(join(vault, FOLDER), { recursive: true });
		writeFileSync(
			join(vault, FOLDER, "raw-supersede.md"),
			`---\nid: "pi-memory:failure:hash1"\nstatus: active\nsuperseded_by: ""\ntags: [zettel]\n---\nRaw body\n`,
		);
		await runConverge(
			[note({ id: "distill:upgrade", supersedesCardId: "pi-memory:failure:hash1" })],
			vault,
			{ candidates: 1, killed: 0, survivors: 1 },
		);
		const diff = readDiff(vault)!;
		expect(diff.superseded).toEqual([{ from: "pi-memory:failure:hash1", to: "distill:upgrade", found: true }]);
		const raw = readFileSync(join(vault, FOLDER, "raw-supersede.md"), "utf8");
		expect(raw).toContain("status: superseded");
	});

	test("crash mid-run (ingest failure) leaves the previous run's diff intact", async () => {
		await runConverge([note()], vault, metrics);
		const before = readDiff(vault)!;
		const beforeRaw = readFileSync(join(vault, ".distill-diff.json"), "utf8");
		// A nonexistent vault makes ingestRecords throw BEFORE any write —
		// the previous diff must survive byte-identically.
		await expect(
			runConverge([note({ id: "distill:note-2" })], "/nonexistent/vault/xyz", metrics),
		).rejects.toThrow();
		expect(readDiff(vault)?.runId).toBe(before.runId);
		expect(readFileSync(join(vault, ".distill-diff.json"), "utf8")).toEqual(beforeRaw);
	});

	test("unchanged re-run: no created/merged entries (idempotent diff)", async () => {
		await runConverge([note()], vault, metrics);
		await runConverge([note()], vault, metrics);
		const diff = readDiff(vault)!;
		expect(diff.created).toEqual([]);
		expect(diff.merged).toEqual([]);
	});
});
