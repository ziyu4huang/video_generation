/**
 * src/feedback/usage.ts — deterministic "card was used" detection + the vault
 * usage ledger (context-lifecycle ticket 11).
 *
 * DISTINCT from src/usage.ts (the SurrealDB ACCESS ledger, D37): that records
 * what was SERVED (zk_card reads, injector serves, retrieve echoes); this
 * module records what was USED — the agent's output or tool traffic actually
 * referencing the card. Three provenance sources (ticket 11):
 *
 *   (i) turn_end scan — assistant text matched against the per-session
 *       served set (auto-recall injected cards; titles from the same
 *       buildAutoRecallBlock trace that feeds the RecallLedger);
 *  (ii) zk_card tool-result provenance — a card whose title appears in a
 *       non-error zk_card result was rendered in-session and counts as used;
 * (iii) pi:knowledge bus `used` emissions — workflows report usage from
 *       receipts via emitKnowledgeUsed (src/emit.ts).
 *
 * Storage: append-only `<vault>/.knowledge-usage.jsonl`, one JSON object per
 * line — `{ uri, at, via }` where uri is the card's canonical record id.
 * NEVER frontmatter: a read+use cycle must leave the git vault clean
 * (content stays canonical in md; this ledger is canonical for USE).
 *
 * Detection is best-effort at every level: matching and appends are
 * try/catch-wrapped and never throw into the turn loop (the hermes
 * used-detection safety envelope, ported).
 *
 * Library only — no ExtensionAPI (the extension entry wires the hooks).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cardAnatomy, readCardFrontmatterFields } from "../card-format.ts";

/** Which provenance source produced a usage row. */
export type UsageVia = "turn_end" | "zk_card" | "bus";

/** One ledger row (one JSON line in .knowledge-usage.jsonl). */
export interface UsageRow {
	/** Canonical card record id (RetrievedCard.id — the frontmatter source_id). */
	uri: string;
	/** ISO timestamp of the detection. */
	at: string;
	via: UsageVia;
}

export const USAGE_LEDGER_FILENAME = ".knowledge-usage.jsonl";
export const USAGE_LEDGER_IGNORE_LINE = USAGE_LEDGER_FILENAME;

/** Titles shorter than this are skipped in text scans — a 4-char title (e.g.
 *  "SAM3") substring-matches unrelated output far too often to mean "used". */
export const MIN_SCAN_TITLE_CHARS = 6;

/** Normalize text for title matching: lowercase, collapse all whitespace runs
 *  to single spaces, trim. Both the title and the scanned text go through
 *  this, so a normalized title is by construction a substring of any text
 *  that mentions it with arbitrary casing/spacing (hermes signature pattern). */
export function normalizeForMatch(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Extract the concatenated text blocks of an assistant message (thinking and
 *  tool calls excluded — only what the agent SAID counts as usage evidence). */
export function assistantText(message: unknown): string {
	const blocks = (message as { content?: Array<{ type?: string; text?: unknown }> } | undefined)?.content;
	if (!Array.isArray(blocks)) return "";
	const parts: string[] = [];
	for (const b of blocks) {
		if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

interface ServedEntry {
	uri: string;
	normTitle: string;
	title: string;
}

/**
 * Per-session used-detector: holds the served (injected) card set, scans
 * turn/tool surfaces for title mentions, and forgets a card once detected
 * (MONOTONIC — one usage row per card per session, idempotent appends; the
 * hermes matchAndForget pattern). Factory-scope state in the extension entry
 * ⇒ per-session by construction (the D9 property).
 */
export class UsedDetector {
	/** Keyed by URI — one entry per card regardless of title collisions;
	 *  matching iterates the entries' normalized titles (review finding 3:
	 *  title keys collapsed distinct cards and made isUndetected lie). */
	private readonly served = new Map<string, ServedEntry>();
	/** URIs already recorded this session, across ALL sources — the
	 *  cross-source monotonicity guard (review #2148 finding 1: the vault
	 *  index cannot forget, so without this set one card collected a ledger
	 *  row per scanToolResult call). */
	private readonly detected = new Set<string>();
	/** Per-ROOT lazily-loaded vault title indexes (source for zk_card
	 *  provenance on cards that were never injected), keyed by vaultRoot so
	 *  two different roots never share an index (review finding 5). */
	private readonly vaultTitles = new Map<string, Map<string, string>>();

	/** Register cards served this session (the auto-recall injection trace).
	 *  Re-registering a card replaces its entry (delete-then-set drops any
	 *  stale previous entry, so a changed title can never still "detect" via
	 *  the old one — review finding 4). */
	registerServed(cards: ReadonlyArray<{ id: string; title: string }>): void {
		for (const c of cards) {
			if (!c?.id || !c?.title) continue;
			this.served.delete(c.id);
			this.served.set(c.id, { uri: c.id, normTitle: normalizeForMatch(c.title), title: c.title });
		}
	}

	/** Drop the cached vault title indexes (e.g. after a mutating zk_card op
	 *  changed the vault mid-session) so the next scan re-indexes fresh
	 *  cards (review finding 5). */
	resetVaultIndex(): void {
		this.vaultTitles.clear();
	}

	/** Load (once per root) the vault-wide title→uri index for
	 *  scanToolResult. Cards live under any folder as .md files; title =
	 *  first H1, uri = frontmatter source_id — both from ONE file read
	 *  (review finding 7). Best-effort: an unreadable vault yields an empty
	 *  index (zk_card provenance degrades to the served set only — never
	 *  throws). */
	loadVaultTitles(vaultRoot: string): Map<string, string> {
		const cached = this.vaultTitles.get(vaultRoot);
		if (cached) return cached;
		const out = new Map<string, string>();
		try {
			const walk = (dir: string, depth: number): void => {
				if (depth > 4) return; // vaults are shallow; never scan the world
				for (const e of readdirSync(dir, { withFileTypes: true })) {
					if (e.name.startsWith(".")) continue;
					const p = join(dir, e.name);
					if (e.isDirectory()) walk(p, depth + 1);
					else if (e.name.endsWith(".md")) this.indexCard(p, out);
				}
			};
			walk(vaultRoot, 0);
		} catch {
			// unreadable vault — empty index, scans degrade to the served set
		}
		this.vaultTitles.set(vaultRoot, out);
		return out;
	}

	private indexCard(absPath: string, out: Map<string, string>): void {
		try {
			const content = readFileSync(absPath, "utf8");
			const title = cardAnatomy(content).title;
			const uri = readCardFrontmatterFields(content).sourceId;
			if (!title || !uri) return;
			out.set(normalizeForMatch(title), uri);
		} catch {
			// unreadable card — skip it
		}
	}

	/** Scan normalized text against normalized titles. Returns matched uris
	 *  (order-stable); dedup/forgetting is the caller's, via markDetected. */
	private matchTitles(text: string, titles: Iterable<[normTitle: string, uriOrEntry: string | ServedEntry]>): string[] {
		const matched: string[] = [];
		for (const [normTitle, ref] of titles) {
			if (normTitle.length < MIN_SCAN_TITLE_CHARS) continue;
			if (text.includes(normTitle)) {
				matched.push(typeof ref === "string" ? ref : ref.uri);
			}
		}
		return matched;
	}

	/** Cross-source monotonicity gate: true exactly once per uri per session.
	 *  A served card is also forgotten from the served set on first detection
	 *  so the served scan cannot re-match it either. */
	private markDetected(uri: string): boolean {
		if (this.detected.has(uri)) return false;
		this.detected.add(uri);
		this.served.delete(uri);
		return true;
	}

	/** Source (i): scan a turn's assistant text against the served set.
	 *  Monotonic — a detected card is forgotten and cannot re-match this
	 *  session. Returns usage rows for newly detected cards. */
	scanTurnEnd(message: unknown, at: Date = new Date()): UsageRow[] {
		const text = normalizeForMatch(assistantText(message));
		if (!text) return [];
		const rows: UsageRow[] = [];
		for (const uri of this.matchTitles(text, [...this.served.values()].map((e) => [e.normTitle, e] as const))) {
			if (!this.markDetected(uri)) continue;
			rows.push({ uri, at: at.toISOString(), via: "turn_end" });
		}
		return rows;
	}

	/** Source (ii): scan a non-error zk_card tool result. Matches BOTH the
	 *  served set and the vault-wide title index (a find result often
	 *  surfaces cards that were never injected). Monotonic per card across
	 *  ALL sources and calls. */
	scanToolResult(resultText: string, vaultRoot: string | undefined, at: Date = new Date()): UsageRow[] {
		const text = normalizeForMatch(resultText ?? "");
		if (!text) return [];
		const seen = new Set<string>();
		const rows: UsageRow[] = [];
		const collect = (uris: string[]): void => {
			for (const uri of uris) {
				if (seen.has(uri)) continue;
				seen.add(uri);
				if (!this.markDetected(uri)) continue;
				rows.push({ uri, at: at.toISOString(), via: "zk_card" });
			}
		};
		// Served set first (highest-confidence).
		collect(this.matchTitles(text, [...this.served.values()].map((e) => [e.normTitle, e] as const)));
		if (vaultRoot) {
			collect(this.matchTitles(text, this.loadVaultTitles(vaultRoot)));
		}
		return rows;
	}

	/** Exposed for tests: is a served card still undetected? */
	isUndetected(uri: string): boolean {
		return this.served.has(uri);
	}
}

/** Append usage rows to `<vaultRoot>/.knowledge-usage.jsonl`, one complete
 *  `<json>\n` line per row, batched into one appendFileSync call (a single
 *  small O_APPEND write is atomic on APFS/ext4 — a crash leaves whole lines
 *  only, never a torn half-line; readUsageLedger additionally SKIPS a torn
 *  line rather than failing the read). Best-effort: never throws (a failed
 *  ledger write must never fail the turn that detected the usage). */
export function appendUsageRows(vaultRoot: string, rows: readonly UsageRow[]): void {
	if (rows.length === 0) return;
	try {
		const lines = rows.map((r) => `${JSON.stringify({ uri: r.uri, at: r.at, via: r.via })}\n`).join("");
		mkdirSync(vaultRoot, { recursive: true });
		appendFileSync(join(vaultRoot, USAGE_LEDGER_FILENAME), lines);
	} catch {
		// best-effort — never block the session
	}
}

/** Read back the ledger (tests + tooling). Returns [] when absent. */
export function readUsageLedger(vaultRoot: string): UsageRow[] {
	try {
		const raw = readFileSync(join(vaultRoot, USAGE_LEDGER_FILENAME), "utf8");
		const out: UsageRow[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line) as UsageRow;
				if (typeof r?.uri === "string" && typeof r?.at === "string" && typeof r?.via === "string") out.push(r);
			} catch {
				// a torn/partial line never breaks the read
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Ensure the ledger file is git-ignored inside the vault. Only touches a
 *  vault that IS a git repo (a `.git` entry exists — vault submodule or plain
 *  repo); appends the ignore line to `.gitignore` once. Best-effort, never
 *  throws; returns true when the vault is (now) ignoring the ledger. */
export function ensureLedgerIgnored(vaultRoot: string): boolean {
	try {
		if (!existsSync(join(vaultRoot, ".git"))) return false;
		const giPath = join(vaultRoot, ".gitignore");
		const current = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
		if (current.split("\n").some((l) => l.trim() === USAGE_LEDGER_IGNORE_LINE)) return true;
		appendFileSync(giPath, `${current.endsWith("\n") || current === "" ? "" : "\n"}${USAGE_LEDGER_IGNORE_LINE}\n`);
		return true;
	} catch {
		return false;
	}
}
