/**
 * src/extract.ts — ticket 06: session-commit → extraction loop (D28–D31).
 *
 * One call runs the whole loop over a commit's worth of fresh hermes-journal
 * entries: deterministic gate (distill/gate.ts, unchanged) → deterministic
 * classify (unique / upgrade / ambiguous-evidence, D29) → bounded chunks of
 * survivors, ONE local LLM call per chunk (typed extraction + dedup votes,
 * OpenViking single-LLM-call shape per batch — ticket 01: per-chunk cursor
 * advance, shutdown runs capped at one chunk) → vote validation
 * (deterministic-first: add_only passthrough, canonical-id upsert,
 * mechanism-B supersede, ambiguous-band LLM judgment) → converge (typed cards,
 * ingestRecords idempotent by canonical id) → markSuperseded for raw targets →
 * per-run audit diff under `output/kcard-extract/` (D30) → cursor advance in
 * `.extract-state.json` (D31, fresh-only next run — advanced per successfully
 * processed chunk, so a mid-batch failure keeps prior chunks' progress).
 *
 * Deterministic-first (D29) is the CONTRACT, and it is enforced IN CODE, not
 * merely in the prompt: votes the deterministic layer forbids (event merge/
 * delete, merge/delete outside the evidence set, delete of raw/event cards)
 * are corrected to create and the correction recorded in the decision.
 *
 * NO vault mutation outside the convergence sink (ingestRecords + supersede);
 * vault md stays the sole canonical store (D2). Library-only — the LLM is the
 * only external dependency, injectable via `_llm` for deterministic tests.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "./distill/types.ts";
import { runGate, scanGraphCards, similarity, type ExistingCard } from "./distill/gate.ts";
import { ingestRecords } from "./ingest.ts";
import { markSuperseded } from "./supersede.ts";
import { chatJson } from "./llm-chat.ts";
import { extractDate } from "./adapters.ts";
import { slugify } from "./card-format.ts";
import { CARD_TYPES, isCardType } from "./kcard-types.ts";
import type { KnowledgeRecord } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants (measured / pinned by the gate — the extract loop reuses the SAME
// signals so dedup semantics stay single-source).
// ---------------------------------------------------------------------------

/** Content-similarity band for the LLM's ambiguous judgment: below the gate's
 *  0.72 KILL threshold (gate.ts SIM_THRESHOLD — a stronger match would have
 *  been killed or upgraded there), at or above this floor a relevant existing
 *  curated card is surfaced as evidence for a merge/delete/skip decision. */
const AMBIG_LOW = 0.45;
/** Max evidence cards per entry. */
const EVIDENCE_LIMIT = 3;
/** Entry content truncation for the prompt (prompt budget is real). */
const PROMPT_ENTRY_CHARS = 1200;
/** Hard cap on LLM items per call (defensive; chunks already bound it). */
const MAX_ITEMS = 60;
/** Max survivor entries per LLM call (ticket 01 chunking). Measured
 *  2026-08-24 on gemma-4-12b (LM Studio, reasoning suppressed): one item ≈
 *  ~95 output tokens, decode ~47 tok/s under 4-resident-model contention →
 *  an 8-entry chunk ≈ ~800-1000 output tokens ≈ 17-21s, which fits the
 *  shutdown trigger's 25s per-attempt budget (a 15-entry chunk measured
 *  ~32s and cannot). Input side: survivors avg 488 chars (p90 771), so a
 *  chunk is ~4k prompt chars; the single-call shape over ALL survivors
 *  (~49k chars) is what made every pre-#1976 run llmFailed. */
export const EXTRACT_CHUNK_ENTRIES = 8;
/** First-attempt max_tokens for a chunk call (ticket 01). Measured chunk
 *  output ≈ 800-1000 tokens; 4096 is generous headroom so the JSON parses on
 *  the FIRST attempt — the llm-chat default 2048 truncated at chunk scale;
 *  the parse-failure retry ladder (14000) stays as the safety net. */
const CHUNK_MAX_TOKENS_FIRST = 4096;
const STATE_FILE = ".extract-state.json";

// ---------------------------------------------------------------------------
// Hermes-journal → MemoryEntry (the capture-only source, context-lifecycle D1)
// ---------------------------------------------------------------------------

interface HermesEntryFrontmatter {
	id: string;
	created: string;
	last: string;
	state: string;
}

/** Parse the per-entry `---` frontmatter block (live journal form) or the
 *  legacy `<!-- created=... -->` comment form the adapter also accepts. */
function parseEntryFrontmatter(entry: string): HermesEntryFrontmatter {
	const fm = entry.match(/^---\n([\s\S]*?)\n---/);
	if (fm) {
		const get = (k: string) => fm[1]!.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
		return { id: get("id"), created: get("created"), last: get("last"), state: get("state") };
	}
	const c = entry.match(/created=([^,\s>]+)/)?.[1] ?? "";
	const l = entry.match(/last=([^,\s>]+)/)?.[1] ?? "";
	return { id: "", created: c, last: l, state: "" };
}

/** Parse ONE hermes journal file into gate-shaped MemoryEntry records.
 *  Entries are separated by a line containing only `§` (per hermes MEMORY.md).
 *  The `[category]` prefix stays in the content (the LLM contract reads it);
 *  it is also harvested into `category` for the card dimension. */
export function parseHermesEntries(content: string, target: MemoryEntry["target"]): MemoryEntry[] {
	if (!content || !content.trim()) return [];
	const out: MemoryEntry[] = [];
	const chunks = content.split(/^§\s*$/m);
	for (let i = 0; i < chunks.length; i++) {
		let raw = chunks[i]!.trim();
		if (!raw) continue;
		const { id, created, last } = parseEntryFrontmatter(raw);
		raw = raw.replace(/^---\n[\s\S]*?\n---(\r?\n|$)/, "");
		raw = raw.replace(/<!--\s*(?:created|last)=[^>]*?-->/g, "").trim();
		if (!raw) continue;
		const category = raw.match(/^\[([\w-]+)\]\s*/)?.[1] ?? "";
		out.push({
			id: id || `hermes:${target}:${i}`,
			target,
			category,
			content: raw,
			created,
			last: last || created,
		});
	}
	return out;
}

/** Read a hermes journal dir (OB_HERMES_MEMORY_DIR default) into entries.
 *  Skips backup / rollup files so only the live journal feeds the loop. */
export function readHermesJournal(dir: string): MemoryEntry[] {
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.includes(".bak") && !f.includes("_backup_") && f !== "README.md");
	} catch {
		return [];
	}
	const stemToTarget = (stem: string): MemoryEntry["target"] => {
		if (stem.includes("failures")) return "failure";
		if (stem.includes("USER")) return "user";
		if (stem.includes("MEMORY")) return "memory";
		return "project";
	};
	const out: MemoryEntry[] = [];
	for (const f of files) {
		let content = "";
		try {
			content = readFileSync(join(dir, f), "utf-8");
		} catch {
			continue;
		}
		out.push(...parseHermesEntries(content, stemToTarget(f.replace(/\.md$/, ""))));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Cursor state (D31: fresh-only extraction; same self-healing shape as
// .distill-state.json — a corrupt file must never crash the loop).
// ---------------------------------------------------------------------------

export interface ExtractState {
	/** Id-based cursor (D31): entry ids already processed. Id-based (not
	 *  date-based) because the journal's per-entry timestamps are day-granular
	 *  — a date cursor would silently skip a same-day second session. FIFO
	 *  capped; a dropped id just re-extracts (the gate's dup/upgrade layer
	 *  keeps that idempotent). */
	seenIds: string[];
	lastRun: string | null;
	runs: number;
	/** Consecutive LLM-failure count (shutdown backoff, 2026-08-24 perf fix).
	 *  A failing LLM run never advances the cursor — without this counter the
	 *  SAME batch retried at every session_shutdown, taxing each one-shot run
	 *  the full 25s budget forever (measured: every receipt since 2026-08-24
	 *  10:08 was llmFailed with candidates=101). Reset to 0 by any successful
	 *  run; 0 on legacy state files. */
	consecutiveFailures: number;
}

const SEEN_CAP = 500;

export function readExtractState(vaultPath: string): ExtractState {
	const p = join(vaultPath, STATE_FILE);
	if (!existsSync(p)) return { seenIds: [], lastRun: null, runs: 0, consecutiveFailures: 0 };
	try {
		const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ExtractState>;
		return {
			seenIds: Array.isArray(raw.seenIds) ? raw.seenIds.filter((x): x is string => typeof x === "string") : [],
			lastRun: raw.lastRun ?? null,
			runs: raw.runs ?? 0,
			consecutiveFailures: typeof raw.consecutiveFailures === "number" ? raw.consecutiveFailures : 0,
		};
	} catch {
		return { seenIds: [], lastRun: null, runs: 0, consecutiveFailures: 0 };
	}
}

export function writeExtractState(vaultPath: string, state: ExtractState): void {
	try {
		writeFileSync(join(vaultPath, STATE_FILE), JSON.stringify(state, null, 2));
	} catch {
		// Best-effort state: the loop must never fail on a state write.
	}
}

function isFresh(e: MemoryEntry, seen: string[]): boolean {
	return !seen.includes(e.id);
}

// ---------------------------------------------------------------------------
// Deterministic classify (D29 — the LLM's ambiguous band is EXPLICIT evidence)
// ---------------------------------------------------------------------------

export type EntryClass = "unique" | "upgrade" | "ambiguous";

export interface EvidenceCard {
	id: string;
	recordType: string;
	title: string;
	sim: number;
}

export interface ClassifiedEntry {
	entry: MemoryEntry;
	cls: EntryClass;
	/** For upgrade: the raw card id the create supersedes (mechanism B). */
	supersedesCardId?: string;
	/** For ambiguous: candidate active curated cards, best-first. */
	evidence: EvidenceCard[];
}

/** Raw-prefix set — mirror of gate.ts RAW_UPGRADE_PREFIXES (single source:
 *  kept in sync by the tests; the gate's upgrade semantics are authoritative). */
function isRawCardId(id: string): boolean {
	return id.startsWith("hermes:") || id.startsWith("pi-memory:");
}

/** Classify a gate survivor: deterministic upgrade / ambiguous-evidence /
 *  unique. Pure — no I/O beyond the already-scanned cards. */
export function classifyEntry(
	entry: MemoryEntry,
	cards: ExistingCard[],
	supersedesCardId?: string,
): ClassifiedEntry {
	if (supersedesCardId) return { entry, cls: "upgrade", supersedesCardId, evidence: [] };
	const curated = cards.filter((c) => c.status === "active" && !isRawCardId(c.id));
	const scored = curated
		.map((c) => ({ c, sim: similarity(entry.content, c.body) }))
		.filter((s) => s.sim >= AMBIG_LOW && s.sim < 0.72)
		.sort((a, b) => b.sim - a.sim)
		.slice(0, EVIDENCE_LIMIT);
	if (scored.length === 0) return { entry, cls: "unique", evidence: [] };
	return {
		entry,
		cls: "ambiguous",
		evidence: scored.map((s) => ({
			id: s.c.id,
			recordType: s.c.recordType || "pattern",
			title: titleOf(s.c.body),
			sim: Math.round(s.sim * 100) / 100,
		})),
	};
}

/** Best-effort title extraction for evidence display (first non-empty line). */
function titleOf(body: string): string {
	const line = body.split(/\r?\n/)[0]?.trim() ?? body.slice(0, 80);
	return line.slice(0, 100) || "(untitled)";
}

// ---------------------------------------------------------------------------
// LLM contract (single call, OpenViking `extract_loop` shape)
// ---------------------------------------------------------------------------

/** Raw per-entry item the LLM returns (pre-validation — the model may invent
 *  fields; validation clamps everything). */
export interface RawExtractItem {
	entryId?: unknown;
	vote?: unknown;
	type?: unknown;
	title?: unknown;
	detail?: unknown;
	date?: unknown;
	tags?: unknown;
	targetCardId?: unknown;
	reason?: unknown;
	experience?: unknown;
}

export interface ExtractionItem {
	entryId: string;
	vote: "create" | "skip" | "merge" | "delete";
	type: string;
	title: string;
	detail: string;
	date: string | null;
	tags: string[];
	targetCardId: string | null;
	reason: string;
	experience?: { situation: string; approach: string; reflection: string } | null;
}

function buildPrompt(
	classified: ClassifiedEntry[],
	freshCount: number,
	seenBefore: number,
): string {
	const typeNotes = Object.entries(CARD_TYPES)
		.map(([t, d]) => `- ${t} (${d.operationMode}): ${(d.notes ?? "").split("\n")[0]}`.trim())
		.join("\n");
	const sections = classified.map((c, i) => {
		const e = c.entry;
		const tag = e.category ? ` [category: ${e.category}]` : "";
		const evidence =
			c.evidence.length > 0
				? `\nEvidence (similar EXISTING cards — only these may be merge/delete targets):\n` +
					c.evidence
						.map((ev) => `  - id=${ev.id} record_type=${ev.recordType} sim=${ev.sim} title=${ev.title}`)
						.join("\n")
				: "";
		const upgrade =
			c.supersedesCardId
				? `\nUpgrade: this entry's raw card (id=${c.supersedesCardId}) must be superseded by the new curated card — vote create (mechanism B).`
				: "";
		return `### ${i + 1}. entryId=${e.id}${tag}\n${e.content.slice(0, PROMPT_ENTRY_CHARS)}${evidence}${upgrade}`;
	}).join("\n\n");

	return [
		"You extract durable knowledge from session-memory entries into typed cards for a developer knowledge graph.",
		"The LLM in this one call emits per-entry extraction + dedup decisions. Reply with ONLY a JSON array, no prose:",
		'[{"entryId":string,"vote":"create"|"skip"|"merge"|"delete","type":string,"title":string,"detail":string,"date":"YYYY-MM-DD"|null,"tags":string[],"targetCardId":string|null,"reason":string,"experience":null|{"situation":string,"approach":string,"reflection":string}}]',
		"Card types (contract):",
		typeNotes,
		"Dedup vote rules:",
		"- create: a new card for this entry (the normal case).",
		"- skip: the entry does not deserve a card.",
		"- merge / delete: ONLY when the entry maps onto a card listed in Evidence — merge = update that card, delete = retire that card fully replaced by a new create; both need a reason. Never against cards outside Evidence.",
		"- deterministic rules you cannot override: events are ADD_ONLY (never merge/delete — emit them as create); upgrade entries must be create (they supersede the raw card); never delete a card whose id starts with hermes: or pi-memory:.",
		"- date: for events, convert any relative time to a specific YYYY-MM-DD based on the entry's own date; null when no date exists.",
		"",
		`Entries to process (${freshCount} fresh, ${seenBefore} already seen (not re-run), up to ${PROMPT_ENTRY_CHARS} chars each):`,
		sections,
	].join("\n");
}

/** Tolerant parseFn (never invalid JSON array escapes — chatJson is the
 *  never-throws boundary; a malformed payload maps to null → llmFailed).
 *  Exported for measurement wrappers that reuse the SAME parse contract. */
export function parseItems(raw: string): RawExtractItem[] {
	let text = raw.trim();
	text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	const body = start >= 0 && end > start ? text.slice(start, end + 1) : text;
	const parsed = JSON.parse(body) as unknown;
	if (!Array.isArray(parsed)) throw new Error("not an array");
	return parsed as RawExtractItem[];
}

function coerceItem(raw: RawExtractItem): ExtractionItem {
	const vote =
		raw.vote === "merge" || raw.vote === "delete" || raw.vote === "skip"
			? raw.vote
			: "create";
	const type = isCardType(String(raw.type ?? "")) ? String(raw.type) : "pattern";
	const date = extractDate(String(raw.date ?? "")) || null;
	const tags = Array.isArray(raw.tags)
		? raw.tags.filter((t): t is string => typeof t === "string").slice(0, 8)
		: [];
	let experience: ExtractionItem["experience"] = null;
	if (raw.experience && typeof raw.experience === "object") {
		const ex = raw.experience as Record<string, unknown>;
		experience = {
			situation: String(ex.situation ?? ""),
			approach: String(ex.approach ?? ""),
			reflection: String(ex.reflection ?? ""),
		};
	}
	return {
		entryId: String(raw.entryId ?? ""),
		vote,
		type,
		title: String(raw.title ?? "").trim().slice(0, 140),
		detail: String(raw.detail ?? "").trim().slice(0, 32_000),
		date,
		tags,
		targetCardId: String(raw.targetCardId ?? ""),
		reason: String(raw.reason ?? "").trim().slice(0, 200),
		experience,
	};
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type ExtractTrigger = "shutdown" | "on-demand";

export interface ExtractOptions {
	vaultPath: string;
	/** The commit's entries (hermes journal). Fresh-mask applied via cursor. */
	entries: MemoryEntry[];
	trigger?: ExtractTrigger;
	/** Diff output dir; default `<cwd>/output/kcard-extract` (D30 — gitignored
	 *  scratch, receipts precedent). */
	outputDir?: string;
	/** Report-only: no vault writes, no cursor advance. */
	dryRun?: boolean;
	/** Chat timeout per attempt (llm-chat.ts pass-through). */
	timeoutMs?: number;
	/** Post-write index rebuild (ticket 08 fold-back via the ticket 10
	 *  reconciliation): after the loop's writes land, schedule the
	 *  fingerprint-gated SurrealDB card-index rebuild (forwarded to the
	 *  internal ingestRecords + markSuperseded calls). Default FALSE —
	 *  production trigger sites opt in. */
	indexRebuild?: boolean;
	/** Test seam: inject the extractor (default = chatJson via llm-chat.ts). */
	_llm?: (prompt: string) => Promise<RawExtractItem[] | null>;
}

export interface ExtractDecision extends ExtractionItem {
	/** Deterministic corrections to the LLM vote (D29 enforcement). */
	forced?: string;
}

export interface ExtractWrite {
	cardId: string;
	path: string;
	outcome: string;
}

export interface ExtractResult {
	runId: string;
	ts: string;
	trigger: ExtractTrigger;
	dryRun: boolean;
	seenBefore: number;
	/** Seen ids AFTER the run (per-chunk advance reflects partial progress). */
	seenAfter: number;
	cursorExcluded: number;
	candidates: number;
	killed: number;
	survivors: number;
	/** Chunks this run planned to process (shutdown runs cap at 1). */
	chunksPlanned: number;
	/** Chunks that completed (LLM ok + ingest ok + cursor advanced). */
	chunksProcessed: number;
	decisions: ExtractDecision[];
	writes: ExtractWrite[];
	superseded: { rawCardId: string; byCardId: string; found: boolean; updated: boolean }[];
	errors: string[];
	llmFailed: boolean;
	/** Shutdown backoff fired: the run short-circuited BEFORE the LLM call
	 *  because the previous SHUTDOWN_BACKOFF_FAILURES shutdown runs failed
	 *  (see ExtractState.consecutiveFailures). On-demand runs never skip. */
	skippedBackoff: boolean;
	diffFile: string | null;
}

/** After this many consecutive LLM failures, shutdown-triggered runs stop
 *  paying their timeout budget on a batch that has already proven unfetchable
 *  — the lane self-heals via an on-demand `zk_ingest` extract run (any
 *  success resets the counter). */
const SHUTDOWN_BACKOFF_FAILURES = 2;

function makeRunId(): { runId: string; ts: string } {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return { runId: `extract-${ts.replace(/[-: ]/g, "")}`, ts };
}

/** Run the extraction loop end to end. NEVER-THROWS at the outer boundary:
 *  every failure mode (LLM down, gate I/O, vault write) lands in `errors` or
 *  is reflected in the summary — a crash mid-loop must not block shutdown
 *  (the hook contract) or hide a partial run (the diff records it). */
export async function runExtraction(opts: ExtractOptions): Promise<ExtractResult> {
	const { runId, ts: tsStr } = makeRunId();
	const state = readExtractState(opts.vaultPath);
	const seen = state.seenIds;

	// Fresh-mask (D31) — id cursor is the commit boundary; entries already
	// processed by a previous run's loop stay out.
	const fresh = opts.entries.filter((e) => isFresh(e, seen));
	const cursorExcluded = opts.entries.length - fresh.length;

	// Shutdown backoff (2026-08-24 perf fix): a shutdown run pays its full
	// timeout budget (25s at the extension trigger site) for the LLM call —
	// and because a failure never advances the cursor, the SAME batch retried
	// at every session end (measured: ~25s stall on every one-shot -p run).
	// After SHUTDOWN_BACKOFF_FAILURES consecutive failures, skip before the
	// LLM; on-demand runs still execute and a success resets the counter.
	if (opts.trigger === "shutdown" && state.consecutiveFailures >= SHUTDOWN_BACKOFF_FAILURES) {
		let diffFile: string | null = null;
		try {
			const dir = opts.outputDir ?? join(process.cwd(), "output", "kcard-extract");
			mkdirSync(dir, { recursive: true });
			diffFile = join(dir, `run-${runId}.json`);
			writeFileSync(
				diffFile,
				JSON.stringify(
					{ runId, ts: tsStr, trigger: "shutdown", skippedBackoff: true, consecutiveFailures: state.consecutiveFailures, seenBefore: seen.length, cursorExcluded, candidates: fresh.length, decisions: [], writes: [], superseded: [], llmFailed: false },
					null,
					2,
				),
			);
		} catch {
			diffFile = null;
		}
		return {
			runId, ts: tsStr, trigger: "shutdown", dryRun: !!opts.dryRun,
			seenBefore: seen.length, seenAfter: seen.length, cursorExcluded, candidates: fresh.length,
			killed: 0, survivors: 0, chunksPlanned: 0, chunksProcessed: 0,
			decisions: [], writes: [], superseded: [],
			errors: [], llmFailed: false, skippedBackoff: true, diffFile,
		};
	}

	// Gate (deterministic — unchanged semantics; this is the kill/upgrade layer)
	const gate = runGate(fresh, opts.vaultPath);
	const cards = gate.survivors.length > 0 ? scanGraphCards(opts.vaultPath) : [];

	const classified: ClassifiedEntry[] = gate.survivors.map((s) =>
		classifyEntry(s.entry, cards, s.supersedesCardId),
	);

	// Chunked loop (ticket 01): bounded input chunks, ONE LLM call per chunk,
	// cursor advancing per successfully-processed chunk — a mid-batch failure
	// keeps prior chunks' progress (the un-processed remainder simply retries
	// fresh next run). A SHUTDOWN-triggered run processes at most ONE chunk so
	// the #1976 bounded-timeout guarantee holds regardless of backlog size;
	// with per-chunk advance each successful shutdown also drains one chunk
	// instead of failing whole (the never-succeeding loop is gone
	// structurally, the backoff stays as the LLM-down safety net).
	const chunks: ClassifiedEntry[][] = [];
	for (let i = 0; i < classified.length; i += EXTRACT_CHUNK_ENTRIES) {
		chunks.push(classified.slice(i, i + EXTRACT_CHUNK_ENTRIES));
	}
	const maxChunks = opts.trigger === "shutdown" ? 1 : chunks.length;
	const plannedChunks = Math.min(chunks.length, maxChunks);

	// Killed entries' ids ride along with the FIRST successful chunk's cursor
	// advance (they are deterministically rejected — no LLM involved — but a
	// fully-failed run must not mark them seen, matching pre-chunk semantics).
	const survivorIds = new Set(classified.map((c) => c.entry.id));
	let killedPending = fresh.filter((e) => !survivorIds.has(e.id)).map((e) => e.id);

	const llm: (p: string) => Promise<RawExtractItem[] | null> =
		opts._llm ??
		((p) => chatJson(p, parseItems, {
			timeoutMs: opts.timeoutMs ?? 60_000,
			maxTokensFirst: CHUNK_MAX_TOKENS_FIRST,
			reasoningEffort: "none", // JSON-only fast path (measured — see llm-chat.ts)
		}));

	const decisions: ExtractDecision[] = [];
	const records: KnowledgeRecord[] = [];
	const supersedePlan: { rawCardId: string; byCardId: string }[] = [];
	const runErrors: string[] = [];
	const writes: ExtractWrite[] = [];
	const superseded: ExtractResult["superseded"] = [];
	let seenIdsNow = state.seenIds;
	let llmFailed = false;
	let chunksProcessed = 0;

	for (let ci = 0; ci < plannedChunks; ci++) {
		const chunk = chunks[ci]!;
		// One LLM call per chunk (OpenViking shape). Failure → this chunk (and
		// the rest of the run) stops; prior chunks keep their progress.
		let items: RawExtractItem[] | null = null;
		try {
			items = await llm(buildPrompt(chunk, chunk.length, seen.length));
		} catch {
			items = null;
		}
		if (items === null) {
			llmFailed = true;
			break;
		}

		const chunkRecords: KnowledgeRecord[] = [];
		const chunkPlan: { rawCardId: string; byCardId: string }[] = [];
		const byEntry = new Map<ClassifiedEntry, ExtractionItem>();
		for (const raw of items.slice(0, MAX_ITEMS)) {
			const item = coerceItem(raw);
			if (!item.entryId) {
				runErrors.push("dropped item: no entryId");
				continue;
			}
			const cls = chunk.find((c) => c.entry.id === item.entryId);
			if (!cls) {
				runErrors.push(`dropped item: unknown entryId ${item.entryId}`);
				continue;
			}
			buildDecisionAndRecord(cls, item, byEntry, decisions, chunkRecords, chunkPlan);
		}
		// Entries the LLM omitted entirely are recorded as skipped (created
		// only when the item is a mis-indexed duplicate of another entry).
		for (const cls of chunk) {
			if (!byEntry.has(cls)) {
				decisions.push({
					entryId: cls.entry.id,
					vote: "skip",
					type: "pattern",
					title: "",
					detail: "",
					date: null,
					tags: [],
					targetCardId: null,
					reason: "omitted by the extractor",
				});
			}
		}

		// Converge per chunk (idempotent by canonical id; add_only contract
		// enforced by the decision layer ABOVE — ingest must not wiki-merge
		// behind its back, so `wikiAware` stays OFF for the extract lane
		// (reviewer D14-F3): the distinct-id create for an event must never
		// collapse into an existing card under the 0.85 wiki match).
		let ingestFailed = false;
		if (!opts.dryRun && chunkRecords.length > 0) {
			try {
				const summary = await ingestRecords(chunkRecords, {
					vaultPath: opts.vaultPath,
					source: "hermes", // the loop's source IS the hermes journal (D28); the extract origin rides the label
					sourceLabel: `extract:${opts.trigger ?? "on-demand"}`,
					wikiAware: false,
					indexRebuild: opts.indexRebuild,
				});
				writes.push(...summary.cards.map((c) => ({ cardId: c.id, path: c.path, outcome: c.status })));
				records.push(...chunkRecords);
			} catch (e) {
				ingestFailed = true;
				runErrors.push(`ingest failed: ${(e as Error).message}`);
			}
		} else if (opts.dryRun) {
			records.push(...chunkRecords);
		}
		if (ingestFailed) break; // no cursor advance for this chunk — it retries.

		// Mechanism B: supersede raw upgrade cards (idempotent per card).
		for (const plan of chunkPlan) {
			const res = markSuperseded(plan.rawCardId, plan.byCardId, opts.vaultPath, {
				indexRebuild: opts.indexRebuild,
			});
			superseded.push({ ...plan, found: res.found, updated: res.updated });
		}

		// Per-chunk cursor advance (real runs only): this chunk's entries plus
		// the pending killed ids (first ok chunk only). An INGEST failure
		// breaks above BEFORE this — the curated cards never landed, the
		// entries' knowledge exists only as raw hermes:* cards, which the next
		// run's gate upgrades (reviewer D14-F4).
		if (!opts.dryRun) {
			seenIdsNow = [...new Set([...seenIdsNow, ...chunk.map((c) => c.entry.id), ...killedPending])]
				.slice(-SEEN_CAP);
			killedPending = [];
			writeExtractState(opts.vaultPath, {
				seenIds: seenIdsNow,
				lastRun: tsStr,
				runs: state.runs + 1,
				consecutiveFailures: 0, // any successful chunk resets the backoff
			});
		}
		chunksProcessed++;
	}

	// Zero-survivor batch (all killed / nothing fresh to extract): no LLM
	// call, cursor advances for the killed ids — deterministic rejection is
	// final, it must not re-gate the same entries every run forever.
	if (chunks.length === 0 && !opts.dryRun && killedPending.length > 0) {
		seenIdsNow = [...new Set([...seenIdsNow, ...killedPending])].slice(-SEEN_CAP);
		killedPending = [];
		writeExtractState(opts.vaultPath, {
			seenIds: seenIdsNow,
			lastRun: tsStr,
			runs: state.runs + 1,
			consecutiveFailures: 0,
		});
	}

	// Backoff bookkeeping (2026-08-24 perf fix): a run where NO chunk
	// succeeded records the failure WITHOUT advancing the cursor (the batch
	// must retry) so shutdown runs can stop re-paying the timeout budget on a
	// batch that keeps failing. Any successful chunk already reset the counter.
	if (!opts.dryRun && llmFailed && chunksProcessed === 0) {
		writeExtractState(opts.vaultPath, {
			seenIds: state.seenIds,
			lastRun: state.lastRun,
			runs: state.runs,
			consecutiveFailures: state.consecutiveFailures + 1,
		});
	}

	// Audit diff (D30) — gitignored scratch, receipts precedent.
	let diffFile: string | null = null;
	try {
		const dir = opts.outputDir ?? join(process.cwd(), "output", "kcard-extract");
		mkdirSync(dir, { recursive: true });
		diffFile = join(dir, `run-${runId}.json`);
		writeFileSync(
			diffFile,
			JSON.stringify(
				{ runId, ts: tsStr, trigger: opts.trigger ?? "on-demand", dryRun: !!opts.dryRun, seenBefore: seen.length, seenAfter: seenIdsNow.length, cursorExcluded, candidates: gate.candidates, killed: gate.killed.length, survivors: gate.survivors.length, chunksPlanned: plannedChunks, chunksProcessed, chunkEntries: EXTRACT_CHUNK_ENTRIES, consecutiveFailures: llmFailed && chunksProcessed === 0 ? state.consecutiveFailures + 1 : 0, decisions, writes, superseded, llmFailed },
				null,
				2,
			),
		);
	} catch {
		diffFile = null; // diff is advisory; never fail the run over it.
	}

	return {
		runId,
		ts: tsStr,
		trigger: opts.trigger ?? "on-demand",
		dryRun: !!opts.dryRun,
		seenBefore: seen.length,
		seenAfter: seenIdsNow.length,
		cursorExcluded,
		candidates: gate.candidates,
		killed: gate.killed.length,
		survivors: gate.survivors.length,
		chunksPlanned: plannedChunks,
		chunksProcessed,
		decisions,
		writes,
		superseded,
		errors: [
			...gate.killed.filter((k) => k.reason === "malformed").map((k) => k.detail),
			...runErrors,
		],
		llmFailed,
		skippedBackoff: false,
		diffFile,
	};
}

/** One LLM item → decision (+ record, when it survives the deterministic
 *  layer). byEntry tracks which classified entries the LLM answered so the
 *  runner can fill omitted entries with skip.
 *
 *  D29 deterministic-first, enforced in code (never merely in the prompt):
 *   1. add_only (event): merge AND delete → create (never merges/deletes);
 *      merging INTO an existing event card is likewise forbidden.
 *   2. upgrade: merge/delete → create (mechanism B is authoritative).
 *   3. merge/delete outside the evidence set → create (no permissible target).
 *   4. delete of raw cards / event cards / delete without reason → create.
 *   5. merge only into same-kind targets (type mismatch → create).
 *   6. A VALID merge reuses the TARGET's canonical id → ingestRecords upserts
 *      it in place (MERGE_OPS) — the merge lane is a real write, not a no-op.
 *   7. A VALID delete decodes to create + supersede-target-by-the-replacement
 *      (md-canonical: nothing is destroyed; `status: superseded` is the
 *      retract state — the LLM's delete intent survives in the decision). */
function buildDecisionAndRecord(
	cls: ClassifiedEntry,
	item: ExtractionItem,
	byEntry: Map<ClassifiedEntry, ExtractionItem>,
	decisions: ExtractDecision[],
	records: KnowledgeRecord[],
	supersedePlan: { rawCardId: string; byCardId: string }[],
): void {
	const def = CARD_TYPES[item.type as keyof typeof CARD_TYPES] ?? CARD_TYPES.pattern;
	const addOnly = def.operationMode === "add_only";
	const forced: string[] = [];

	let vote: ExtractDecision["vote"] = item.vote;
	let deleteTarget: string | null = null;
	/** Valid merge target (in-evidence, same-kind) — the record then carries
	 *  the TARGET's canonical id so ingestRecords upserts it in place (D29). */
	let mergeTarget: string | null = null;
	if (vote === "merge" || vote === "delete") {
		const targetInEvidence = cls.evidence.some((ev) => ev.id === item.targetCardId);
		const targetRaw = isRawCardId(item.targetCardId ?? "");
		const targetEvent =
			cls.evidence.find((ev) => ev.id === item.targetCardId)?.recordType === "event";
		const targetType = cls.evidence.find((ev) => ev.id === item.targetCardId)?.recordType ?? "";
		if (addOnly) {
			// D29: add_only never merges AND never deletes — both forced create.
			vote = "create";
			forced.push("add_only");
		} else if (cls.cls === "upgrade") {
			vote = "create";
			forced.push("upgrade_must_create");
			item.targetCardId = null;
		} else if (!targetInEvidence) {
			vote = "create";
			forced.push("target_not_in_evidence");
		} else if (vote === "delete" && (targetRaw || targetEvent || !item.reason)) {
			vote = "create";
			forced.push(targetRaw ? "delete_raw_forbidden" : targetEvent ? "delete_event_forbidden" : "delete_needs_reason");
		} else if (vote === "merge" && targetEvent) {
			// Never merge INTO an existing event card (add_only record).
			vote = "create";
			forced.push("merge_event_forbidden");
		} else if (vote === "merge" && targetType && targetType !== item.type) {
			// Same-kind only: merging a pattern record into a gotcha card would
			// retype history — fall back to create (types stay D15-stable).
			vote = "create";
			forced.push("merge_type_mismatch");
		} else if (vote === "merge") {
			mergeTarget = item.targetCardId;
		} else if (vote === "delete") {
			deleteTarget = item.targetCardId;
		}
	}
	if (item.type === "experience" && !item.experience) {
		// Contract: experience carries the SAR payload; without it, downgrade.
		item.type = "pattern";
		forced.push("experience_without_sar_downgraded");
	}
	if (!item.title && (vote === "create" || deleteTarget)) {
		item.title = item.detail.slice(0, 80) || item.type;
		forced.push("title_inferred");
	}

	// Canonical id (deterministic scheme; add_only ids carry the date so the
	// same event re-extracted converges on the same card — idempotency).
	// A valid MERGE reuses the TARGET's id — ingestRecords upserts in place
	// (MERGE_OPS per-field semantics) — the LLM's refined content becomes the
	// card, no new id, no supersede (the target IS the merged card).
	const date = item.date ?? extractDate(cls.entry.last, cls.entry.created);
	const slug = slugify(item.title);
	const id = mergeTarget ?? (addOnly
		? `distill:${item.type}:${date || "undated"}:${slug}`
		: `distill:${item.type}:${slug}`);

	const record: KnowledgeRecord = {
		id,
		type: item.type,
		title: item.title,
		detail: item.detail,
		tags: ["extract", ...item.tags.filter((t) => t && !t.startsWith("extract"))].slice(0, 8),
		dimension: cls.entry.category || cls.entry.target || null,
		confidence: 0.8,
		status: "active",
		superseded_by: null,
		evidence: {
			first_seen: date || undefined,
			extracted_at: new Date().toISOString().slice(0, 10),
		},
	};
	if (item.experience) {
		record.experience = {
			situation: item.experience.situation,
			approach: item.experience.approach,
			reflection: item.experience.reflection,
		};
	}

	const decision: ExtractDecision = {
		entryId: item.entryId,
		vote,
		type: item.type,
		title: item.title,
		detail: item.detail,
		date: item.date,
		tags: item.tags,
		targetCardId: deleteTarget,
		reason: item.reason,
		experience: item.experience,
		forced: forced.length ? forced.join(" > ") : undefined,
	};
	byEntry.set(cls, item);
	decisions.push(decision);
	if (deleteTarget) {
		// Valid delete → create the replacement + retire the target (5).
		decision.vote = "delete";
		decision.forced = forced.length ? `${forced.join(" > ")} > delete_via_supersede` : "delete_via_supersede";
		supersedePlan.push({ rawCardId: deleteTarget, byCardId: id });
		records.push(record);
	} else if (mergeTarget) {
		// Valid merge → upsert the target in place (already inside `records`).
		decision.forced = forced.length ? `${forced.join(" > ")} > merge_in_place` : "merge_in_place";
		records.push(record);
	} else if (vote === "create") {
		records.push(record);
		if (cls.supersedesCardId) supersedePlan.push({ rawCardId: cls.supersedesCardId, byCardId: id });
	}
}
