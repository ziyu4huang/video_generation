/**
 * Ticket 06 — session-commit → extraction loop (D28–D31).
 *
 * Deterministic suite (local_ci ≤5min): injected `_llm` (never a live LM
 * Studio), tmp vaults. Pins, in order:
 *   1. D17 CARD_TYPES registry contract (add_only vs upsert, full key set);
 *   2. hermes-journal parsing (frontmatter + § + legacy comment forms);
 *   3. deterministic classify (unique / ambiguous band / upgrade);
 *   4. the loop end-to-end: gate → LLM → vote validation → converge →
 *      supersede → diff → id-cursor (D31);
 *   5. D29 deterministic-first enforcement (add_only passthrough,
 *      target-not-in-evidence, delete-needs-reason, delete→supersede decode,
 *      upgrade supersede);
 *   6. failure mode (LLM null → no writes, no cursor move) + dryRun.
 */
import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_TYPES, isCardType } from "../src/kcard-types.ts";
import {
	classifyEntry,
	EXTRACT_CHUNK_ENTRIES,
	parseHermesEntries,
	readExtractState,
	readHermesJournal,
	runExtraction,
	type RawExtractItem,
} from "../src/extract.ts";
import { scanGraphCards } from "../src/distill/gate.ts";
import type { MemoryEntry } from "../src/distill/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

function tmpVault(): string {
	const dir = mkdtempSync(join(tmpdir(), "kcard-extract-"));
	mkdirSync(join(dir, "Zettelkasten", "knowledge-graph"), { recursive: true });
	return dir;
}

const GRAPH = (v: string) => join(v, "Zettelkasten", "knowledge-graph");

function cardFiles(v: string): string[] {
	return readdirSync(GRAPH(v)).filter((f) => f.endsWith(".md"));
}

function mem(id: string, content: string, created = "2026-08-22"): MemoryEntry {
	return { id, target: "failure", category: "failure", content, created, last: created };
}

/** A minimal active curated card (mimics ingestRecords output shape — REAL
 *  ingest cards carry `source_id` = id; ingest's existing-lookup keys on it). */
function seedCard(vault: string, id: string, recordType: string, title: string, body: string): void {
	writeFileSync(
		join(GRAPH(vault), `${id.replace(/:/g, "-")}.md`),
		["---", `id: ${id}`, `source_id: ${id}`, "created: 2026-08-21", "tags: [zettel]", `record_type: ${recordType}`,
			"status: active", "superseded_by: ", "confidence: 0.85", "---", `# ${title}`, "", body].join("\n"),
	);
}

// contents crafted for the ambiguity band (gate kills at ≥0.72)
const BAND = "Rebase the private branch onto main before merging — squash order matters.";
const BAND_ENTRY = "We learned always rebasing the private branch onto main before merging — squash order matters in the 2026 session.";
const FIX_BODY = "The pi SDK model hijack was fixed by --provider.";

// ── 1. D17 registry ────────────────────────────────────────────────────────

describe("CARD_TYPES (D17)", () => {
	test("full D16 key set, one entry per type", () => {
		expect(Object.keys(CARD_TYPES).sort()).toEqual(
			["avoid", "case", "event", "experience", "false_positive", "gotcha", "lever", "metric", "pattern", "preference", "reference"].sort(),
		);
	});
	test("event is add_only; case/preference/legacy are upsert", () => {
		expect(CARD_TYPES.event.operationMode).toBe("add_only");
		expect(CARD_TYPES.case.operationMode).toBe("upsert");
		expect(CARD_TYPES.preference.operationMode).toBe("upsert");
		expect(CARD_TYPES.pattern.operationMode).toBe("upsert");
	});
	test("every def carries requiredFields + stage; isCardType gates the set", () => {
		for (const def of Object.values(CARD_TYPES)) {
			expect(def.requiredFields.length).toBeGreaterThan(0);
			expect(["user", "agent"]).toContain(def.stage);
		}
		expect(isCardType("event")).toBe(true);
		expect(isCardType("soul")).toBe(false);
	});
});

// ── 2. journal parsing ─────────────────────────────────────────────────────

describe("parseHermesEntries", () => {
	test("per-entry frontmatter form (§-separated) with category prefix", () => {
		const md = [
			"---", "id: abc-123", "created: 2026-08-21", "last: 2026-08-21", "state: acquired", "---",
			"[correction] First entry — something happened and was corrected.",
			"§",
			"---", "id: def-456", "created: 2026-08-22", "last: 2026-08-22", "state: active", "---",
			"[insight] Second entry with [[wiki-link]].",
		].join("\n");
		const entries = parseHermesEntries(md, "memory");
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			id: "abc-123", target: "memory", category: "correction", created: "2026-08-21", last: "2026-08-21",
		});
		expect(entries[0].content).toContain("First entry");
		expect(entries[1].category).toBe("insight");
		expect(entries[1].content).toContain("wiki-link");
		expect(entries[1].content).not.toContain("id: def-456");
	});
	test("legacy comment-form timestamps + uuid-less id fallback", () => {
		const md = "[failure] Legacy entry shape. <!-- created=2026-08-01, last=2026-08-03 -->";
		const entries = parseHermesEntries(md, "failure");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe("hermes:failure:0");
		expect(entries[0]!.created).toBe("2026-08-01");
		expect(entries[0]!.content).toContain("Legacy entry shape");
	});
	test("empty / whitespace input → []", () => {
		expect(parseHermesEntries("", "memory")).toHaveLength(0);
		expect(parseHermesEntries("\n§\n", "memory")).toHaveLength(0);
	});
});

describe("readHermesJournal", () => {
	test("live files only — backups and README are skipped", () => {
		const dir = mkdtempSync(join(tmpdir(), "kcard-hermes-"));
		writeFileSync(join(dir, "MEMORY.md"), "---\nid: m1\ncreated: 2026-08-22\n---\n[insight] Live memory entry.\n");
		writeFileSync(join(dir, "failures.md"), "---\nid: f1\ncreated: 2026-08-22\n---\n[failure] Live failure entry.\n");
		writeFileSync(join(dir, "MEMORY.md.bak-condense-186600"), "---\nid: x\n---\nstale backup\n");
		writeFileSync(join(dir, "_backup_1866"), "---\nid: y\n---\nold backup\n");
		writeFileSync(join(dir, "README.md"), "index\n");
		const entries = readHermesJournal(dir);
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.target).sort()).toEqual(["failure", "memory"]); // fs order is not guaranteed
	});
});

// ── 3. deterministic classify ──────────────────────────────────────────────

describe("classifyEntry (D29)", () => {
	test("unique when no curated card is similar", () => {
		const vault = tmpVault();
		seedCard(vault, "distill:pattern:zebra", "pattern", "Zebra", "The zebra migration aborted.");
		const cards = scanGraphCards(vault);
		const c = classifyEntry(mem("a1", "The MLX pipeline renders with Z-Image."), cards);
		expect(c.cls).toBe("unique");
		expect(c.evidence).toHaveLength(0);
	});
	test("ambiguous in the band with evidence, raw cards excluded", () => {
		const vault = tmpVault();
		seedCard(vault, "distill:pattern:model-hijack", "pattern", "Model hijack", "pi SDK model hijack: user defaultProvider silently captures a bare model name.");
		seedCard(vault, "hermes:legacy", "pattern", "Legacy", "A raw hermes card about something else entirely.");
		const cards = scanGraphCards(vault);
		const c = classifyEntry(
			mem("a2", "pi SDK model hijack: a user-level defaultProvider captures a BARE --model name — pass explicit --provider."),
			cards,
		);
		expect(c.cls).toBe("ambiguous");
		expect(c.evidence.length).toBeGreaterThan(0);
		expect(c.evidence[0]!.id).toBe("distill:pattern:model-hijack");
		expect(c.evidence.every((ev) => !ev.id.startsWith("hermes:"))).toBe(true);
	});
	test("upgrade carries the raw supersede target", () => {
		const c = classifyEntry(mem("a3", "anything at all"), [], "hermes:old-card");
		expect(c.cls).toBe("upgrade");
		expect(c.supersedesCardId).toBe("hermes:old-card");
	});
});

// ── 4–6. the loop ──────────────────────────────────────────────────────────

describe("runExtraction (D28–D31)", () => {
	const eventEntry = mem("a1", "[insight] The team confirmed a Friday dinner at 7pm after the review.");
	const patternEntry = mem("a2", "[correction] Always rebase the private branch onto main before merging it.");

	test("happy path: gate → LLM → typed cards + diff + id-cursor advance", async () => {
		const vault = tmpVault();
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a1", vote: "create", type: "event", title: "Friday dinner confirmed", detail: "A dinner with the team was confirmed for Friday at 7pm.", date: "2026-08-22", tags: ["dinner"], targetCardId: null, reason: "new event" },
			{ entryId: "a2", vote: "create", type: "pattern", title: "Rebase before merge", detail: "Rebase onto main before every merge.", tags: ["git"], reason: "new pattern" },
		];
		const out = join(vault, "out");
		const res = await runExtraction({ vaultPath: vault, entries: [eventEntry, patternEntry], outputDir: out, _llm: llm });

		expect(res.llmFailed).toBe(false);
		expect(res.candidates).toBe(2);
		expect(res.seenBefore).toBe(0);
		expect(res.decisions).toHaveLength(2);
		expect(res.writes).toHaveLength(2);
		expect(res.diffFile).not.toBeNull();

		const files = cardFiles(vault);
		expect(files).toHaveLength(2);
		const eventFile = files.find((f) => f.startsWith("distill-event-2026-08-22-friday"))!;
		expect(eventFile).toBeDefined();
		const eventCard = readFileSync(join(GRAPH(vault), eventFile), "utf-8");
		expect(eventCard).toContain("record_type: event");
		expect(eventCard).toMatch(/^created: 2026-08-22/m);

		const diff = JSON.parse(readFileSync(res.diffFile!, "utf-8")) as { runId: string; decisions: unknown[]; writes: unknown[] };
		expect(diff.runId).toMatch(/^extract-/);
		expect(diff.decisions).toHaveLength(2);

		const st = readExtractState(vault);
		expect(st.seenIds).toEqual(["a1", "a2"]);
		expect(st.runs).toBe(1);
	});

	test("D31 id-cursor: repeat run skips seen entries, processes same-day fresh ones", async () => {
		const vault = tmpVault();
		// r1: LLM answers only a3 → a1/a2 recorded as omitted-skip.
		const r1llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a3", vote: "create", type: "case", title: "Surreal timeout case", detail: "The 10s per-request timeout was fixed by load-then-index.", tags: ["surreal"], reason: "new" },
		];
		const a3 = mem("a3", "The Surreal per-request timeout fixed via load-then-index swap.", "2026-08-23");
		const r1 = await runExtraction({ vaultPath: vault, entries: [eventEntry, patternEntry, a3], outputDir: join(vault, "out"), _llm: r1llm });
		expect(r1.candidates).toBe(3);
		expect(r1.decisions).toHaveLength(3);
		expect(cardFiles(vault)).toHaveLength(1); // the case card

		// r2: same entries PLUS a same-day new one (2026-08-23 = cursor's day —
		// id-cursor must NOT exclude it; a date cursor would).
		const a4 = mem("a4", "A same-day second session produced this note.", "2026-08-23");
		const r2llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a4", vote: "create", type: "event", title: "Same-day note confirmed", detail: "The second session's event.", date: "2026-08-23", tags: [], reason: "new" },
		];
		const r2 = await runExtraction({ vaultPath: vault, entries: [eventEntry, patternEntry, a3, a4], outputDir: join(vault, "out"), _llm: r2llm });
		expect(r2.seenBefore).toBe(3);
		expect(r2.cursorExcluded).toBe(3);
		expect(r2.candidates).toBe(1);
		expect(r2.decisions[0]!.entryId).toBe("a4");
		expect(cardFiles(vault)).toHaveLength(2);
	});

	test("D29 add_only: an event merge vote is forced back to create", async () => {
		const vault = tmpVault();
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a1", vote: "merge", type: "event", title: "Friday dinner confirmed", detail: "A dinner was confirmed.", date: "2026-08-22", tags: [], targetCardId: "distill:event:2026-08-21:old", reason: "same event" },
		];
		const res = await runExtraction({ vaultPath: vault, entries: [eventEntry], outputDir: join(vault, "out"), _llm: llm });
		const d = res.decisions[0]!;
		expect(d.vote).toBe("create");
		expect(d.forced).toContain("add_only");
		expect(res.writes).toHaveLength(1);
		expect(cardFiles(vault)).toHaveLength(1);
	});

	test("D29 target-not-in-evidence: off-list merge is forced create", async () => {
		const vault = tmpVault();
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a2", vote: "merge", type: "pattern", title: "Rebase before merge", detail: "Rebase before every merge.", tags: [], targetCardId: "distill:pattern:unrelated", reason: "similar" },
		];
		const res = await runExtraction({ vaultPath: vault, entries: [patternEntry], outputDir: join(vault, "out"), _llm: llm });
		expect(res.decisions[0]!.vote).toBe("create");
		expect(res.decisions[0]!.forced).toContain("target_not_in_evidence");
	});

	test("D29 delete protection + valid delete decodes to supersede", async () => {
		// (a) delete with no reason → forced create (own vault — cursor must not leak)
		const v1 = tmpVault();
		seedCard(v1, "distill:pattern:rebase", "pattern", "Rebase", BAND);
		const llmBad = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a2", vote: "delete", type: "pattern", title: "Rebase discipline", detail: BAND, tags: [], targetCardId: "distill:pattern:rebase", reason: "" },
		];
		const r1 = await runExtraction({ vaultPath: v1, entries: [mem("a2", BAND_ENTRY)], outputDir: join(v1, "out"), _llm: llmBad });
		expect(r1.decisions[0]!.vote).toBe("create");
		expect(r1.decisions[0]!.forced).toContain("delete_needs_reason");

		// (b) valid delete with reason → replacement create + target superseded
		const v2 = tmpVault();
		seedCard(v2, "distill:pattern:rebase", "pattern", "Rebase", BAND);
		const llmOk = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a2", vote: "delete", type: "pattern", title: "Rebase before merge", detail: BAND_ENTRY, tags: [], targetCardId: "distill:pattern:rebase", reason: "replaced by the refined card" },
		];
		const r2 = await runExtraction({ vaultPath: v2, entries: [mem("a2", BAND_ENTRY)], outputDir: join(v2, "out"), _llm: llmOk });
		const d2 = r2.decisions[0]!;
		expect(d2.vote).toBe("delete");
		expect(d2.forced).toContain("delete_via_supersede");
		expect(r2.writes).toHaveLength(1);
		expect(r2.superseded).toHaveLength(1);
		expect(r2.superseded[0]!.rawCardId).toBe("distill:pattern:rebase");
		expect(r2.superseded[0]!.updated).toBe(true);
		const target = readFileSync(join(GRAPH(v2), "distill-pattern-rebase.md"), "utf-8");
		expect(target).toContain("status: superseded");
		expect(target).toContain('superseded_by: "distill:pattern:rebase-before-merge"'); // yamlScalar quotes colon ids
	});

	test("D29 merge: valid same-kind merge upserts the target in place (reviewer F1)", async () => {
		const vault = tmpVault();
		seedCard(vault, "distill:pattern:rebase", "pattern", "Rebase", BAND);
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a2", vote: "merge", type: "pattern", title: "Rebase before merge", detail: BAND_ENTRY, tags: ["git"], targetCardId: "distill:pattern:rebase", reason: "refined in the new session" },
		];
		const res = await runExtraction({ vaultPath: vault, entries: [mem("a2", BAND_ENTRY)], outputDir: join(vault, "out"), _llm: llm });
		const d = res.decisions[0]!;
		expect(d.vote).toBe("merge");
		expect(d.forced).toContain("merge_in_place");
		expect(res.writes).toHaveLength(1);
		expect(res.writes[0]!.cardId).toBe("distill:pattern:rebase");
		expect(res.writes[0]!.outcome).toBe("updated");
		const target = readFileSync(join(GRAPH(vault), "distill-pattern-rebase.md"), "utf-8");
		expect(target).toContain(BAND_ENTRY.slice(0, 40)); // merged content landed
		expect(target).toContain("git");
		expect(cardFiles(vault)).toHaveLength(1); // no parallel card
	});

	test("D29 merge same-kind: type mismatch falls back to create (reviewer F1 sibling)", async () => {
		const vault = tmpVault();
		seedCard(vault, "distill:gotcha:rebase", "gotcha", "Rebase", BAND);
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a2", vote: "merge", type: "pattern", title: "Rebase before merge", detail: BAND_ENTRY, tags: [], targetCardId: "distill:gotcha:rebase", reason: "same content" },
		];
		const res = await runExtraction({ vaultPath: vault, entries: [mem("a2", BAND_ENTRY)], outputDir: join(vault, "out"), _llm: llm });
		expect(res.decisions[0]!.vote).toBe("create");
		expect(res.decisions[0]!.forced).toContain("merge_type_mismatch");
		expect(cardFiles(vault)).toHaveLength(2); // gotcha card untouched + new pattern card
	});

	test("D29 add_only: an event DELETE vote is forced back to create too (reviewer F2)", async () => {
		const vault = tmpVault();
		seedCard(vault, "distill:pattern:rebase", "pattern", "Rebase", BAND);
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a2", vote: "delete", type: "event", title: "Dinner confirmed", detail: BAND_ENTRY, date: "2026-08-22", tags: [], targetCardId: "distill:pattern:rebase", reason: "wrong card" },
		];
		const res = await runExtraction({ vaultPath: vault, entries: [mem("a2", BAND_ENTRY)], outputDir: join(vault, "out"), _llm: llm });
		expect(res.decisions[0]!.vote).toBe("create");
		expect(res.decisions[0]!.forced).toContain("add_only");
		expect(res.superseded).toHaveLength(0);
		const target = readFileSync(join(GRAPH(vault), "distill-pattern-rebase.md"), "utf-8");
		expect(target).toContain("status: active"); // untouched
	});

	test("ingest failure: no cursor advance (reviewer F4)", async () => {
		const base = tmpVault();
		const vaultPath = join(base, "as-file");
		writeFileSync(vaultPath, "not a directory");
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a1", vote: "create", type: "pattern", title: "X", detail: "y", tags: [], reason: "new" },
		];
		const res = await runExtraction({ vaultPath, entries: [eventEntry], outputDir: join(base, "out"), _llm: llm });
		expect(res.errors.some((e) => e.startsWith("ingest failed"))).toBe(true);
		expect(res.writes).toHaveLength(0);
		expect(readExtractState(vaultPath).seenIds).toHaveLength(0); // retry on the next commit
	});

	test("upgrade: raw hermes card is superseded by the typed create", async () => {
		const vault = tmpVault();
		seedCard(vault, "hermes:model-hijack", "pattern", "Model hijack", FIX_BODY);
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a4", vote: "create", type: "gotcha", title: "Model hijack fix", detail: FIX_BODY + "\nPass --provider explicitly to escape the hijack.", tags: [], reason: "upgrade" },
		];
		const res = await runExtraction({
			vaultPath: vault,
			entries: [mem("a4", FIX_BODY)],
			outputDir: join(vault, "out"),
			_llm: llm,
		});
		expect(res.decisions[0]!.vote).toBe("create");
		expect(res.superseded).toHaveLength(1);
		expect(res.superseded[0]!.rawCardId).toBe("hermes:model-hijack");
		expect(res.superseded[0]!.found).toBe(true);
		expect(res.superseded[0]!.updated).toBe(true);
		const raw = readFileSync(join(GRAPH(vault), "hermes-model-hijack.md"), "utf-8");
		expect(raw).toContain("status: superseded");
	});

	test("LLM failure: no writes, no cursor move, diff still recorded", async () => {
		const vault = tmpVault();
		const res = await runExtraction({
			vaultPath: vault, entries: [eventEntry],
			outputDir: join(vault, "out"),
			_llm: async () => null,
		});
		expect(res.llmFailed).toBe(true);
		expect(res.decisions).toHaveLength(0);
		expect(res.writes).toHaveLength(0);
		expect(cardFiles(vault)).toHaveLength(0);
		expect(readExtractState(vault).seenIds).toHaveLength(0); // retries next commit
		expect(res.diffFile).not.toBeNull();
		expect(JSON.parse(readFileSync(res.diffFile!, "utf-8")).llmFailed).toBe(true);
	});

	test("shutdown backoff: repeated LLM failures stop re-paying the timeout at shutdown; on-demand still runs and a success resets", async () => {
		// Regression (2026-08-24 perf fix): a failing shutdown LLM run never
		// advanced the cursor, so the SAME batch retried at every
		// session_shutdown — every one-shot -p run stalled its full 25s
		// budget before exit.
		const vault = tmpVault();
		let calls = 0;
		const failing = async (): Promise<RawExtractItem[] | null> => {
			calls++;
			return null;
		};
		// Two failing shutdown runs arm the backoff (and book-keep it in state).
		await runExtraction({ vaultPath: vault, entries: [eventEntry], outputDir: join(vault, "out"), trigger: "shutdown", _llm: failing });
		expect(readExtractState(vault).consecutiveFailures).toBe(1);
		await runExtraction({ vaultPath: vault, entries: [eventEntry], outputDir: join(vault, "out"), trigger: "shutdown", _llm: failing });
		expect(readExtractState(vault).consecutiveFailures).toBe(2);
		expect(calls).toBe(2);

		// Third shutdown run: the LLM is never called — the 25s budget is not spent.
		const skipped = await runExtraction({ vaultPath: vault, entries: [eventEntry], outputDir: join(vault, "out"), trigger: "shutdown", _llm: failing });
		expect(calls).toBe(2);
		expect(skipped.skippedBackoff).toBe(true);
		expect(skipped.llmFailed).toBe(false);
		const receipt = JSON.parse(readFileSync(skipped.diffFile!, "utf-8"));
		expect(receipt.skippedBackoff).toBe(true);
		expect(receipt.consecutiveFailures).toBe(2);
		// The skip does not advance the cursor (the batch is still unprocessed)…
		expect(readExtractState(vault).seenIds).toHaveLength(0);

		// …but an on-demand run bypasses the backoff and, on success, resets it.
		const ok = await runExtraction({ vaultPath: vault, entries: [eventEntry], outputDir: join(vault, "out"), _llm: async () => [] });
		expect(ok.skippedBackoff).toBe(false);
		const healed = readExtractState(vault);
		expect(healed.consecutiveFailures).toBe(0);
		expect(healed.seenIds).toContain("a1");

		// After the reset, a shutdown run starts a fresh cycle (LLM called again).
		const freshCycle = await runExtraction({ vaultPath: vault, entries: [mem("a9", FIX_BODY)], outputDir: join(vault, "out"), trigger: "shutdown", _llm: failing });
		expect(freshCycle.skippedBackoff).toBe(false);
		expect(calls).toBe(3);
	});

	test("dryRun: zero writes + zero cursor move, decisions recorded", async () => {
		const vault = tmpVault();
		const llm = async (): Promise<RawExtractItem[]> => [
			{ entryId: "a1", vote: "create", type: "event", title: "Friday dinner confirmed", detail: "A dinner was confirmed.", date: "2026-08-22", tags: [], reason: "new" },
		];
		const res = await runExtraction({ vaultPath: vault, entries: [eventEntry], outputDir: join(vault, "out"), dryRun: true, _llm: llm });
		expect(res.dryRun).toBe(true);
		expect(res.writes).toHaveLength(0);
		expect(cardFiles(vault)).toHaveLength(0);
		expect(readExtractState(vault).seenIds).toHaveLength(0);
		expect(res.decisions).toHaveLength(1);
		expect(existsSync(res.diffFile!)).toBe(true);
	});
});

// ── 7. chunking (ticket 01 — extract backlog drain) ────────────────────────

describe("runExtraction chunking (ticket 01)", () => {
	/** Lexically distinct batch entries so the gate's in-batch dedup (Jaccard
	 *  over >2-char word sets, 0.72) kills none of them — chunk math then keys
	 *  off real survivor counts. Six unique tokens per entry, near-empty
	 *  shared scaffold (pairwise similarity ≈ 0.1). */
	function batch(n: number, prefix = "c"): MemoryEntry[] {
		return Array.from({ length: n }, (_, i) => {
			const u = (k: number) => `uniq${i}tok${k}`;
			return mem(`${prefix}${i}`, `[insight] Subject${i} ${u(1)} ${u(2)} ${u(3)} ${u(4)} ${u(5)} ${u(6)}.`);
		});
	}

	/** Scrapes the chunk prompt for entryId=… and votes create for each. */
	const scrape = async (prompt: string): Promise<RawExtractItem[]> =>
		[...prompt.matchAll(/entryId=([\w.:-]+)/g)].map((m) => m[1]!).map((entryId) => ({
			entryId, vote: "create" as const, type: "pattern", title: `Card ${entryId}`,
			detail: `Detail for ${entryId}.`, tags: [], reason: "new",
		}));

	test("multi-chunk batch: one LLM call per chunk, cursor advances for everything fresh", async () => {
		const vault = tmpVault();
		let calls = 0;
		const llm = async (p: string): Promise<RawExtractItem[] | null> => {
			calls++;
			return scrape(p);
		};
		const entries = batch(32);
		const res = await runExtraction({ vaultPath: vault, entries, outputDir: join(vault, "out"), _llm: llm });
		const expectedChunks = Math.ceil(res.survivors / EXTRACT_CHUNK_ENTRIES);
		expect(calls).toBe(expectedChunks); // never one call over the whole batch
		expect(res.chunksPlanned).toBe(expectedChunks);
		expect(res.chunksProcessed).toBe(expectedChunks);
		expect(res.llmFailed).toBe(false);
		expect(res.seenAfter).toBe(entries.length); // survivors AND killed all seen
		expect(readExtractState(vault).seenIds).toHaveLength(entries.length);
		expect(res.writes).toHaveLength(res.survivors);
	});

	test("mid-batch LLM failure keeps prior chunks' progress; a retry costs only the remainder", async () => {
		const vault = tmpVault();
		let calls = 0;
		const flaky = async (p: string): Promise<RawExtractItem[] | null> => {
			calls++;
			return calls === 1 ? scrape(p) : null;
		};
		const entries = batch(35);
		const res = await runExtraction({ vaultPath: vault, entries, outputDir: join(vault, "out"), _llm: flaky });
		expect(res.chunksProcessed).toBe(1);
		expect(res.chunksPlanned).toBe(Math.ceil(res.survivors / EXTRACT_CHUNK_ENTRIES));
		expect(res.llmFailed).toBe(true); // the run is incomplete…
		const st = readExtractState(vault);
		expect(st.seenIds.length).toBeGreaterThanOrEqual(Math.min(res.survivors, EXTRACT_CHUNK_ENTRIES)); // …but chunk 1 landed
		expect(st.seenIds.length).toBeLessThan(entries.length); // and the rest did not
		const receipt = JSON.parse(readFileSync(res.diffFile!, "utf-8"));
		expect(receipt.chunksProcessed).toBe(1);
		expect(receipt.llmFailed).toBe(true);

		// Retry: ONLY the un-processed remainder goes back through the LLM.
		const res2 = await runExtraction({ vaultPath: vault, entries, outputDir: join(vault, "out"), _llm: (p) => scrape(p) });
		expect(res2.cursorExcluded).toBe(st.seenIds.length);
		expect(res2.llmFailed).toBe(false);
		expect(new Set(readExtractState(vault).seenIds).size).toBe(entries.length); // fully drained
	});

	test("shutdown run processes at most ONE chunk regardless of backlog size", async () => {
		const vault = tmpVault();
		let calls = 0;
		const llm = async (p: string): Promise<RawExtractItem[] | null> => {
			calls++;
			return scrape(p);
		};
		const entries = batch(40); // ≥3 chunks of backlog
		const r1 = await runExtraction({ vaultPath: vault, entries, outputDir: join(vault, "out"), trigger: "shutdown", _llm: llm });
		expect(calls).toBe(1); // the 25s shutdown budget buys exactly one chunk call
		expect(r1.chunksPlanned).toBe(1);
		expect(r1.chunksProcessed).toBe(1);
		expect(r1.llmFailed).toBe(false);
		const seen1 = readExtractState(vault).seenIds.length;

		// Progressive drain: the NEXT shutdown takes the NEXT chunk (no backoff
		// armed — chunk 1 succeeded, consecutiveFailures reset to 0).
		const r2 = await runExtraction({ vaultPath: vault, entries, outputDir: join(vault, "out"), trigger: "shutdown", _llm: llm });
		expect(calls).toBe(2);
		expect(r2.chunksProcessed).toBe(1);
		const seen2 = readExtractState(vault).seenIds.length;
		expect(seen2).toBeGreaterThan(seen1);
		expect(readExtractState(vault).consecutiveFailures).toBe(0);
	});

	test("backoff interplay: two failing shutdown runs arm; on-demand drain bypasses and resets", async () => {
		const vault = tmpVault();
		const entries = batch(20); // ≥2 chunks
		let fail = true;
		const llm = async (p: string): Promise<RawExtractItem[] | null> => (fail ? null : scrape(p));
		const run = (trigger?: "shutdown") =>
			runExtraction({ vaultPath: vault, entries, outputDir: join(vault, "out"), trigger, _llm: llm });

		await run("shutdown"); // chunk 1 fails → consecutiveFailures 1
		await run("shutdown"); // chunk 1 fails again → 2, armed
		expect(readExtractState(vault).consecutiveFailures).toBe(2);

		const skipped = await run("shutdown");
		expect(skipped.skippedBackoff).toBe(true); // LLM never called, zero budget spent

		fail = false;
		const drained = await run(); // on-demand: never skips, drains ALL chunks
		expect(drained.skippedBackoff).toBe(false);
		expect(drained.llmFailed).toBe(false);
		expect(readExtractState(vault).consecutiveFailures).toBe(0);
		expect(readExtractState(vault).seenIds).toHaveLength(entries.length);
	});

	test("killed entries ride with the first successful chunk — not with a fully-failed run", async () => {
		// Success: the malformed (too-short) entry never reaches the LLM but is
		// marked seen alongside chunk 1 (deterministic rejection is final).
		const v1 = tmpVault();
		const withTiny = [...batch(3), mem("tiny", "x")]; // < MIN_CONTENT_LEN → malformed kill
		const r1 = await runExtraction({ vaultPath: v1, entries: withTiny, outputDir: join(v1, "out"), _llm: (p) => scrape(p) });
		expect(r1.killed).toBe(1);
		expect(readExtractState(v1).seenIds).toContain("tiny");

		// Full failure: NOTHING is marked seen — the killed id retries too.
		const v2 = tmpVault();
		const r2 = await runExtraction({ vaultPath: v2, entries: withTiny, outputDir: join(v2, "out"), _llm: async () => null });
		expect(r2.llmFailed).toBe(true);
		expect(readExtractState(v2).seenIds).not.toContain("tiny");
	});

	test("zero-survivor batch: no LLM call, killed ids still advance the cursor", async () => {
		const vault = tmpVault();
		let calls = 0;
		const llm = async (): Promise<RawExtractItem[] | null> => {
			calls++;
			return [];
		};
		const res = await runExtraction({
			vaultPath: vault,
			entries: [mem("t1", "x"), mem("t2", "y")], // both malformed
			outputDir: join(vault, "out"),
			_llm: llm,
		});
		expect(calls).toBe(0); // an empty batch never pays an LLM round-trip
		expect(res.llmFailed).toBe(false);
		expect(res.chunksProcessed).toBe(0);
		expect(readExtractState(vault).seenIds).toEqual(["t1", "t2"]); // rejection is final
	});
});
