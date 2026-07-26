/**
 * Ticket 03 (KNOWN-ISSUES disposition): `zk-ingest --source generic` parity.
 *
 * The CLI's KNOWN_SOURCES used to omit "generic" (the tool/host-fns path
 * accepts it). With the fix, `--source generic` is accepted AND routed to
 * adaptGenericMarkdown (one record per .md file), NOT mis-parsed by
 * parseKnowledgeJsonl.
 *
 * Proof contract (disable→fail→restore→pass, same bar as #839/#841/#843/#850):
 *  - with the `else if (source === "generic")` dispatch branch removed, a plain
 *    .md file falls through to parseKnowledgeJsonl → 0 records (the file isn't
 *    jsonl) → the summary reports "0 record(s)" → this test FAILS.
 *  - with the branch present, adaptGenericMarkdown yields a card → ">0
 *    record(s)" → PASSES.
 *
 * Hermetic: writes to a temp vault via OB_VAULT_PATH; no network, no model.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zkIngestCommand } from "../commands/zk-ingest.ts";
import type { ParsedArgs } from "../args.ts";

let vault: string;
let mdFile: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "zk-ingest-generic-"));
	mdFile = join(vault, "note.md");
	// A plain markdown file that is NOT jsonl, NOT hermes (no §), NOT auto-memory
	// (no name/description frontmatter). Only the generic adapter can make a
	// card from it.
	writeFileSync(
		mdFile,
		[
			"# Trigram Index Cache Layers",
			"",
			"Notes on the fs-cache + trigram index interaction.",
			"",
			"#caching #trigram",
			"",
		].join("\n"),
	);
	process.env.OB_VAULT_PATH = vault;
});

afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	delete process.env.OB_VAULT_PATH;
});

function makeParsed(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
	return {
		appendSystemPrompt: [],
		mode: "text" as never,
		print: false,
		noSession: false,
		noTools: false,
		noBuiltinTools: false,
		extensionPaths: [],
		positionals: [mdFile],
		source: "generic",
		...overrides,
	} as ParsedArgs;
}

describe("zk-ingest --source generic (ticket 03)", () => {
	test("accepts --source generic and yields a card from a plain .md file", async () => {
		const stdout: string[] = [];
		const origLog = console.log;
		console.log = (...a: unknown[]) => {
			stdout.push(a.join(" "));
		};
		try {
			await zkIngestCommand.run(makeParsed());
		} finally {
			console.log = origLog;
		}
		const summary = stdout.join("\n");

		// The generic adapter must have produced a record (proves the dispatch
		// routed to adaptGenericMarkdown, not parseKnowledgeJsonl which would
		// yield 0 — the .md is not jsonl).
		expect(summary).toMatch(/1 record/);
		// And a card file landed in the vault's convergence folder.
		const kg = join(vault, "Zettelkasten", "knowledge-graph");
		expect(existsSync(kg)).toBe(true);
		const cards = readdirSync(kg).filter((f) => f.endsWith(".md"));
		expect(cards.length).toBeGreaterThanOrEqual(1);
	});
});
