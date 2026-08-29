/**
 * usage-ledger — ticket 11 (context-lifecycle P3): deterministic "card was
 * used" detection across three provenance sources + the vault-local jsonl
 * ledger. Acceptance under test:
 *  - (i) turn_end: assistant text mentioning an injected card's title → row
 *    via "turn_end"; monotonic (one row per card per session);
 *  - (ii) zk_card: a non-error tool result mentioning a card title (served OR
 *    vault-indexed) → row via "zk_card";
 *  - (iii) bus: emitKnowledgeUsed → onKnowledgeUsed sink routes shape-valid
 *    used reports, publish emissions stay invisible to the used handler;
 *  - vault git status stays CLEAN through a read+use cycle (no frontmatter);
 *  - append atomicity: every line in the ledger parses, concurrent appends
 *    never interleave a torn line.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UsageRow,
	UsedDetector,
	appendUsageRows,
	ensureLedgerIgnored,
	normalizeForMatch,
	readUsageLedger,
	USAGE_LEDGER_FILENAME,
} from "../src/feedback/usage.ts";
import {
	emitKnowledge,
	emitKnowledgeUsed,
	onKnowledge,
	onKnowledgeUsed,
	type KnowledgeEmission,
} from "../src/emit.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

function assistantMessage(text: string): { role: string; content: Array<{ type: string; text: string }> } {
	return { role: "assistant", content: [{ type: "text", text }] };
}

/** Minimal card fixture on disk: frontmatter source_id + H1 title (the two
 *  fields loadVaultTitles indexes). */
function writeCard(vaultRoot: string, rel: string, id: string, title: string): string {
	const p = join(vaultRoot, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(
		p,
		`---\ntags: [test]\nsource_id: ${id}\n---\n\n# ${title}\n\nbody text\n`,
	);
	return p;
}

const tmpVaults: string[] = [];
afterAll(() => {
	for (const v of tmpVaults) rmSync(v, { recursive: true, force: true });
});
function tempVault(name: string): string {
	const v = mkdtempSync(join(tmpdir(), `kcard-usage-${name}-`));
	tmpVaults.push(v);
	return v;
}

// PORTABILITY-GUARDED: the git-vault tests below spawn `git` (init/add/
// commit/status) — present on every CI runner — with commit identity injected
// via `-c user.email/-c user.name`, so no machine-local gitconfig is read.
const run = (cwd: string, ...args: string[]): number =>
	Bun.spawnSync(["git", ...args], { cwd }).exitCode ?? -1;

// ─── (i) turn_end scan ───────────────────────────────────────────────────────

describe("source (i): turn_end scan of assistant text", () => {
	test("injected card title echoed by the model → one row, via turn_end", () => {
		const d = new UsedDetector();
		d.registerServed([{ id: "workflow:cfg-lever", title: "CFG guidance is the biggest quality lever" }]);
		const rows = d.scanTurnEnd(
			assistantMessage("Per the card CFG guidance is the biggest quality lever, raise guidance."),
			new Date("2026-08-29T00:00:00Z"),
		);
		expect(rows).toEqual([{ uri: "workflow:cfg-lever", at: "2026-08-29T00:00:00.000Z", via: "turn_end" }]);
	});

	test("monotonic: a detected card never re-matches in the same session", () => {
		const d = new UsedDetector();
		d.registerServed([{ id: "x:1", title: "quantization noise scale bug pattern" }]);
		const once = d.scanTurnEnd(assistantMessage("the quantization noise scale bug pattern applies"));
		expect(once.length).toBe(1);
		const again = d.scanTurnEnd(assistantMessage("again: quantization noise scale bug pattern"));
		expect(again.length).toBe(0);
		expect(d.isUndetected("x:1")).toBe(false);
	});

	test("unmentioned served cards produce no rows and stay undetected", () => {
		const d = new UsedDetector();
		d.registerServed([{ id: "x:1", title: "long card title about lora formats" }]);
		expect(d.scanTurnEnd(assistantMessage("totally unrelated reply"))).toEqual([]);
		expect(d.isUndetected("x:1")).toBe(true);
	});

	test("short titles (< MIN_SCAN_TITLE_CHARS) are never matched (false-positive guard)", () => {
		const d = new UsedDetector();
		d.registerServed([{ id: "x:2", title: "SAM3" }]);
		expect(d.scanTurnEnd(assistantMessage("SAM3 is everywhere in this output, coincidentally"))).toEqual([]);
	});

	test("matching is case/whitespace-insensitive via normalizeForMatch", () => {
		expect(normalizeForMatch("  CFG   Guidance\tIs\nThe LEVER ")).toBe("cfg guidance is the lever");
		const d = new UsedDetector();
		d.registerServed([{ id: "x:3", title: "cfg guidance is the lever" }]);
		expect(d.scanTurnEnd(assistantMessage("CFG   GUIDANCE IS THE LEVER!")).length).toBe(1);
	});

	test("thinking blocks and tool calls are not scanned (only spoken text)", () => {
		const d = new UsedDetector();
		d.registerServed([{ id: "x:4", title: "a very distinctive card title phrase" }]);
		const msg = {
			role: "assistant",
			content: [
				{ type: "thinking", text: "a very distinctive card title phrase (internal)" },
				{ type: "toolCall", name: "bash" },
				{ type: "text", text: "the answer is 42" },
			],
		};
		expect(d.scanTurnEnd(msg)).toEqual([]);
	});
});

// ─── (ii) zk_card tool-result provenance ─────────────────────────────────────

describe("source (ii): zk_card tool-result provenance", () => {
	test("a vault card (never injected) titled in a find result → row via zk_card", () => {
		const vault = tempVault("zkfind");
		writeCard(vault, "Zettelkasten/knowledge-graph/a.md", "workflow:vault-card", "Vault Card About Seed Determinism");
		const d = new UsedDetector();
		const rows = d.scanToolResult(
			"vault: test (…) [env]\nFound: Vault Card About Seed Determinism — relevant",
			vault,
			new Date("2026-08-29T01:00:00Z"),
		);
		expect(rows).toEqual([{ uri: "workflow:vault-card", at: "2026-08-29T01:00:00.000Z", via: "zk_card" }]);
	});

	test("a served card detected in a tool result is forgotten for turn_end (shared monotonicity)", () => {
		const vault = tempVault("shared");
		const d = new UsedDetector();
		d.registerServed([{ id: "s:1", title: "regional net negative conditioning result" }]);
		const rows = d.scanToolResult("… regional net negative conditioning result …", vault);
		expect(rows.length).toBe(1);
		// Already detected via zk_card — turn_end must not double-report.
		expect(d.scanTurnEnd(assistantMessage("regional net negative conditioning result"))).toEqual([]);
	});

	test("the vault title index loads once and is cached", () => {
		const vault = tempVault("cache");
		writeCard(vault, "c.md", "g:1", "Cached Title For Index Test");
		const d = new UsedDetector();
		const first = d.loadVaultTitles(vault);
		expect(first.get("cached title for index test")).toBe("g:1");
		// Remove the card from disk; the cached index still has it (one load).
		rmSync(join(vault, "c.md"));
		const second = d.loadVaultTitles(vault);
		expect(second.get("cached title for index test")).toBe("g:1");
	});
});

// ─── (iii) pi:knowledge bus used reports ─────────────────────────────────────

function fakeBus() {
	const handlers = new Map<string, Array<(d: unknown) => void>>();
	return {
		events: {
			emit: (c: string, d: unknown) => {
				for (const h of handlers.get(c) ?? []) h(d);
			},
			on: (c: string, h: (d: unknown) => void) => {
				if (!handlers.has(c)) handlers.set(c, []);
				handlers.get(c)!.push(h);
				return () => {
					const arr = handlers.get(c) ?? [];
					const i = arr.indexOf(h);
					if (i >= 0) arr.splice(i, 1);
				};
			},
		},
	};
}

describe("source (iii): pi:knowledge bus used reports", () => {
	test("emitKnowledgeUsed reaches onKnowledgeUsed; publish emissions do not", () => {
		const bus = fakeBus();
		const usedSeen: string[] = [];
		const publishSeen: string[] = [];
		onKnowledgeUsed(bus as never, (p) => usedSeen.push(...p.used.map((u) => u.uri)));
		onKnowledge(bus as never, (p) => publishSeen.push(p.sourceLabel));
		emitKnowledgeUsed(bus as never, {
			source: "usage",
			sourceLabel: "workflow:receipt",
			used: [{ uri: "workflow:u1" }, { uri: "workflow:u2" }],
		});
		const publish: KnowledgeEmission = {
			source: "workflow-jsonl",
			sourceLabel: "not-for-used-sink",
			records: [],
		};
		emitKnowledge(bus as never, publish);
		expect(usedSeen).toEqual(["workflow:u1", "workflow:u2"]);
		expect(publishSeen).toEqual(["not-for-used-sink"]); // publish handler never saw the used payload
	});

	test("malformed used payloads are skipped (no records field abuse)", () => {
		const bus = fakeBus();
		const seen: number[] = [];
		onKnowledgeUsed(bus as never, () => seen.push(1));
		bus.events.emit("pi:knowledge", { source: "usage", sourceLabel: "x", records: [] }); // publish-shaped
		bus.events.emit("pi:knowledge", { source: "other", used: [{ uri: "u" }] }); // wrong source
		bus.events.emit("pi:knowledge", null);
		expect(seen).toEqual([]);
	});
});

// ─── storage: ledger append + atomicity + vault cleanliness ─────────────────

describe("ledger storage", () => {
	test("appendUsageRows writes one JSON line per row; readUsageLedger round-trips", () => {
		const vault = tempVault("append");
		const rows: UsageRow[] = [
			{ uri: "a:1", at: "2026-08-29T02:00:00Z", via: "turn_end" },
			{ uri: "a:2", at: "2026-08-29T02:00:01Z", via: "zk_card" },
		];
		appendUsageRows(vault, rows);
		appendUsageRows(vault, [{ uri: "a:3", at: "2026-08-29T02:00:02Z", via: "bus" }]);
		expect(readUsageLedger(vault)).toHaveLength(3);
		expect(readUsageLedger(vault)[0]).toEqual(rows[0]);
	});

	test("append atomicity: N concurrent single-row appends never interleave a torn line", async () => {
		const vault = tempVault("atomic");
		const N = 200;
		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				Promise.resolve().then(() =>
					appendUsageRows(vault, [{ uri: `concurrent:${i}`, at: new Date().toISOString(), via: "turn_end" }]),
				),
			),
		);
		const ledger = readUsageLedger(vault);
		expect(ledger).toHaveLength(N);
		const uris = new Set(ledger.map((r) => r.uri));
		expect(uris.size).toBe(N); // no lost rows
		// Every physical line parses (readUsageLedger skips torn lines — so
		// assert on the RAW file too: line count must equal row count).
		const raw = readFileSync(join(vault, USAGE_LEDGER_FILENAME), "utf8");
		expect(raw.split("\n").filter((l) => l.trim()).length).toBe(N);
	});

	test("appendUsageRows never throws on an unwritable vault", () => {
		expect(() => appendUsageRows("/nonexistent-root/definitely/not/here", [{ uri: "x", at: "t", via: "bus" }])).not.toThrow();
	});

	test("read+use cycle leaves the git vault CLEAN (no frontmatter writes)", () => {
		const vault = tempVault("gitclean");
		writeCard(vault, "Zettelkasten/knowledge-graph/clean.md", "g:clean", "Clean Cycle Card Title Phrase");
		run(vault, "init", "-q");
		run(vault, "add", "-A");
		run(vault, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
		ensureLedgerIgnored(vault);
		const before = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: vault });
		const dirtyBefore = String(new TextDecoder().decode(before.stdout)).trim();
		// The ONLY dirty line is the new .gitignore entry (the ledger's
		// ignore guard) — nothing else existed to change yet.
		expect(dirtyBefore.split("\n").every((l) => l.endsWith(".gitignore"))).toBe(true);
		// The read+use cycle: detect + append, card md UNTOUCHED.
		const d = new UsedDetector();
		d.registerServed([{ id: "g:clean", title: "Clean Cycle Card Title Phrase" }]);
		const rows = d.scanTurnEnd(assistantMessage("per Clean Cycle Card Title Phrase …"));
		appendUsageRows(vault, rows);
		const after = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: vault });
		const dirtyAfter = String(new TextDecoder().decode(after.stdout)).trim();
		// Identical dirty set: the ledger row is ignored, the card's
		// frontmatter/body were never written.
		expect(dirtyAfter).toBe(dirtyBefore);
		expect(dirtyAfter.includes(USAGE_LEDGER_FILENAME)).toBe(false);
		expect(dirtyAfter.includes("clean.md")).toBe(false);
		expect(readUsageLedger(vault)).toEqual([expect.objectContaining({ uri: "g:clean", via: "turn_end" })]);
	});

	test("ensureLedgerIgnored appends the entry once and is idempotent", () => {
		const vault = tempVault("ignore");
		run(vault, "init", "-q");
		expect(ensureLedgerIgnored(vault)).toBe(true);
		expect(ensureLedgerIgnored(vault)).toBe(true);
		const gi = readFileSync(join(vault, ".gitignore"), "utf8");
		expect(gi.split("\n").filter((l) => l.trim() === USAGE_LEDGER_FILENAME)).toHaveLength(1);
	});

	test("ensureLedgerIgnored leaves non-git vaults untouched", () => {
		const vault = tempVault("nogit");
		expect(ensureLedgerIgnored(vault)).toBe(false);
		expect(readUsageLedger(vault)).toEqual([]);
	});
});

// ─── entry wiring: hooks land rows in the REAL vault ledger ──────────────────

describe("extension entry wiring (ticket 11 hooks)", () => {
	async function loadFactory() {
		const handlers = new Map<string, Array<(e: unknown) => unknown>>();
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			registerShortcut: () => {},
			registerFlag: () => {},
			sendMessage: () => {},
			appendEntry: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setActiveTools: () => {},
			getActiveTools: () => [] as string[],
			getFlag: () => undefined,
			setModel: async () => true,
			on: (event: string, handler: (e: unknown) => unknown) => {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			events: { on: () => () => {}, emit: () => {} },
			getAllTools: () => [],
			exec: async () => "",
			sendUserMessage: () => {},
		};
		const { default: factory, __setVaultResolverForTest } = await import("../extensions/knowledge-card.ts");
		__setVaultResolverForTest(async () => vault);
		factory(pi as never);
		return {
			fire: async (event: string, e: unknown) => {
				for (const h of handlers.get(event) ?? []) await h(e);
			},
			restore: () => __setVaultResolverForTest(null),
		};
	}

	const vault = tempVault("wiring");

	test("zk_card tool_execution_end lands a ledger row in the resolved vault", async () => {
		writeCard(vault, "Zettelkasten/knowledge-graph/w.md", "g:wired", "Wired Detection Card Title Phrase");
		const w = await loadFactory();
		try {
			await w.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "zk_card",
				isError: false,
				result: { content: [{ type: "text", text: "vault: test\nFound: Wired Detection Card Title Phrase — match" }] },
			});
			// The handler awaits usageVault + appends synchronously inside the
			// fired promise — one microtask drain for safety.
			await new Promise((r) => setTimeout(r, 10));
			const rows = readUsageLedger(vault);
			expect(rows.some((r) => r.uri === "g:wired" && r.via === "zk_card")).toBe(true);
		} finally {
			w.restore();
		}
	});

	test("error zk_card results and other tools never write", async () => {
		const w = await loadFactory();
		try {
			await w.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "t2",
				toolName: "zk_card",
				isError: true,
				result: { content: [{ type: "text", text: "Wired Detection Card Title Phrase" }] },
			});
			await w.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "t3",
				toolName: "read",
				isError: false,
				result: { content: [{ type: "text", text: "Wired Detection Card Title Phrase" }] },
			});
			await new Promise((r) => setTimeout(r, 10));
			const rows = readUsageLedger(vault).filter((r) => r.uri === "g:wired");
			// Still exactly the one row from the previous test — monotonic + gated.
			expect(rows).toHaveLength(1);
		} finally {
			w.restore();
		}
	});
});
