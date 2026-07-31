/**
 * Integration test: MemoryStore surfaces a near-duplicate WARNING when an added
 * entry overlaps an existing one (wayfinder 2026-07-30-self-reflection-to-fix-
 * these-error ticket 02). The entry is still added (warning, not block).
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryStore } from "../../src/store/memory-store.js";
import { DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const NEAR_DUP_ENV = "PI_MEMORY_NEAR_DUP_THRESHOLD";
let MEMORY_DIR = "";

function makeConfig(): MemoryConfig {
	return {
		memoryMode: "legacy-inject",
		memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
		userCharLimit: DEFAULT_USER_CHAR_LIMIT,
		projectCharLimit: 5000,
		nudgeInterval: 10,
		reviewEnabled: false,
		flushOnCompact: false,
		flushOnShutdown: false,
		flushMinTurns: 6,
		autoConsolidate: false,
		correctionDetection: false,
		failureInjectionEnabled: false,
		failureInjectionMaxAgeDays: 7,
		failureInjectionMaxEntries: 5,
		nudgeToolCalls: 15,
		memoryDir: MEMORY_DIR,
	};
}

describe("MemoryStore near-dup warning (ticket 02)", () => {
	beforeAll(() => {
		MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "near-dup-int-"));
	});
	afterAll(() => {
		fs.rmSync(MEMORY_DIR, { recursive: true, force: true });
	});
	beforeEach(() => {
		for (const f of fs.readdirSync(MEMORY_DIR)) fs.rmSync(path.join(MEMORY_DIR, f), { force: true });
		delete process.env[NEAR_DUP_ENV];
	});

	test("adding a near-duplicate flags it in the response (warning, not block)", async () => {
		const store = new MemoryStore(makeConfig());
		const first =
			"mupdf npm API: Document.openDocument(path) then page.toStructuredText().asText() for text extraction; there is no page.toText. mupdf-js@2.0.1 is a deprecated stub; use mupdf@1.28.0.";
		const nearDup =
			"mupdf API uses Document.openDocument (not Document.open); page text via page.toStructuredText().asText(), no page.toText. mupdf-js@2.0.1 is deprecated, use mupdf@1.28.0 native binding.";
		const r1 = await store.add("failure", first);
		const r2 = await store.add("failure", nearDup);
		expect(r1.success).toBe(true);
		expect(r2.success).toBe(true); // still added — warning, not block
		expect(r2.message).toMatch(/near-duplicate/i);
		expect(r2.message).toMatch(/memory replace/); // points to the consolidate path
	});

	test("a distinct entry is NOT flagged", async () => {
		const store = new MemoryStore(makeConfig());
		await store.add(
			"failure",
			"SurrealDB nested IN-SELECT subqueries over edge tables are pathologically slow; use native graph traversal array::intersect.",
		);
		const r2 = await store.add(
			"failure",
			"SDD plan briefs can contain type errors that implementers copy verbatim; reviewers must run tsc --noEmit.",
		);
		expect(r2.message).not.toMatch(/near-duplicate/i);
	});

	test("the gate is disabled when PI_MEMORY_NEAR_DUP_THRESHOLD=0", async () => {
		process.env[NEAR_DUP_ENV] = "0";
		const store = new MemoryStore(makeConfig());
		await store.add("failure", "mupdf Document.openDocument page.toStructuredText asText deprecated stub extract buffer path");
		const r2 = await store.add("failure", "mupdf Document.openDocument page.toStructuredText asText deprecated stub extract buffer path native");
		expect(r2.success).toBe(true);
		expect(r2.message).not.toMatch(/near-duplicate/i); // disabled → no warning
	});
});

/**
 * Prize 2 (wayfinder 2026-07-30-self-reflection ticket 02 deferred): the
 * near-dup WARNING is computed in `_addInner` but DROPPED when the add
 * overflows (fifo-evict / vault-offload early-return without nearDupNote).
 * These cases pin that the warning survives the overflow path.
 */
describe("MemoryStore near-dup warning on overflow paths (prize 2)", () => {
	beforeAll(() => {
		MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "near-dup-overflow-"));
	});
	afterAll(() => {
		fs.rmSync(MEMORY_DIR, { recursive: true, force: true });
	});
	beforeEach(() => {
		for (const f of fs.readdirSync(MEMORY_DIR)) fs.rmSync(path.join(MEMORY_DIR, f), { force: true });
		delete process.env[NEAR_DUP_ENV];
	});

	const FIRST =
		"mupdf npm API: Document.openDocument(path) then page.toStructuredText().asText() for text extraction; there is no page.toText. mupdf-js@2.0.1 is a deprecated stub; use mupdf@1.28.0.";
	const NEAR_DUP_TEXT =
		"mupdf API uses Document.openDocument (not Document.open); page text via page.toStructuredText().asText(), no page.toText. mupdf-js@2.0.1 is deprecated, use mupdf@1.28.0 native binding.";

	test("vault-offload overflow still surfaces the near-dup warning", async () => {
		const store = new MemoryStore({ ...makeConfig(), failureCharLimit: 300, memoryOverflowStrategy: "vault-offload" });
		await store.add("failure", FIRST);
		const r2 = await store.add("failure", NEAR_DUP_TEXT); // join > 300 → overflow
		expect(r2.success).toBe(true);
		expect(r2.message).toMatch(/near-duplicate/i); // ← prize 2: must not be dropped
	});

	test("fifo-evict overflow still surfaces the near-dup warning", async () => {
		const store = new MemoryStore({ ...makeConfig(), failureCharLimit: 300, memoryOverflowStrategy: "fifo-evict" });
		await store.add("failure", FIRST);
		const r2 = await store.add("failure", NEAR_DUP_TEXT);
		expect(r2.success).toBe(true);
		expect(r2.message).toMatch(/near-duplicate/i);
	});
});
