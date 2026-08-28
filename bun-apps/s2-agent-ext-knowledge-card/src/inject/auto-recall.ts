/**
 * src/inject/auto-recall.ts — budgeted per-turn knowledge recall (ticket 08,
 * context-lifecycle P2). The measured WRITE side (ingest/distill/tier ladder)
 * only pays off at USE time if knowledge reaches the prompt; this module is
 * the USE-side loop: on every `before_agent_start`, gate → retrieve → budget
 * → render a small L0 block appended to the systemPrompt tail.
 *
 * Design constraints (ticket 08, D6/D7):
 *   - Deterministic trigger gate ONLY — no LLM intent analysis. Skip on short
 *     prompts, chitchat vocab, or a top-score floor miss.
 *   - Single retrieval path: `retrieveRecords` (the same library
 *     knowledge_query serves) — no parallel RAG stack.
 *   - Hard token budget: 350 tok/turn default; per-entry cap 2× the average
 *     share; overflow DEMOTES (L1→L0) or drops the tail — never truncates
 *     mid-sentence (the ladder's demote-not-truncate rule, applied to the
 *     injection block as a whole).
 *   - Subagent-child guard (review round 2, D9 re-decided): spawnSubagent
 *     children load extensions fresh from disk and their AgentSession fires
 *     the same hook (probe 2026-08-28) — and `fork:true` background dispatch
 *     runs children DETACHED in the parent's process while the parent's turn
 *     loop continues, so a process.env marker CANNOT distinguish parent from
 *     child (parent false-positives + overlapping restore races; reviewer
 *     finding, PR #2119). The guard is therefore PER-SESSION: every child
 *     path (in-process `createAgentSession` via `SessionManager.inMemory()`,
 *     subprocess `pi -p --no-session`) runs on an in-memory session whose
 *     `sessionManager.getSessionFile()` is "" — the wiring reads its OWN ctx
 *     and passes `sessionFile` here; falsy ⇒ child ⇒ skip. Known limits
 *     (conservative direction): a user-run headless `--no-session` MAIN
 *     session also looks in-memory (recall skips there); a caller overriding
 *     a child's sessionManager with a persisted manager would defeat it (no
 *     such caller exists today).
 *   - Default OFF (`KC_AUTORECALL`); the /knowledge-recall command toggles.
 *   - The block is prefix-stable in FORMAT (fixed header/footer, ranked
 *     order, one line per card) so prefix caching sees a stable shape.
 */

import { retrieveRecords, type RetrievedCard, type RetrieveOptions } from "../retrieve.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Deterministic token estimate: ~4 chars/token (English+zh mix on this vault
 *  measured coarsely; the cap has 2× headroom via the per-entry rule, so the
 *  estimate only needs to be consistent, not exact). */
export const CHARS_PER_TOKEN = 4;

export interface AutoRecallConfig {
	/** Master switch (KC_AUTORECALL=1 or the /knowledge-recall toggle). */
	enabled: boolean;
	/** Prompts shorter than this are not worth a retrieval pass. */
	minPromptChars: number;
	/** Top card must share at least this many tags with the query-derived
	 *  tokens (RetrievedCard.sharedTags IS the ranking score before the
	 *  callout boost) — a precision floor for unprompted injection. */
	scoreFloor: number;
	/** Hard per-turn injection budget, in estimated tokens. */
	tokenCap: number;
	/** How many cards feed the budget pass (pre-budget candidate count). */
	topK: number;
	/** Wall-clock bound on the whole retrieve+render pass. An injector that
	 *  misses it injects nothing — the turn loop must never wait on recall. */
	timeoutMs: number;
}

export const AUTORECALL_DEFAULTS: AutoRecallConfig = {
	enabled: false,
	minPromptChars: 40,
	scoreFloor: 2,
	tokenCap: 350,
	topK: 3,
	timeoutMs: 3_000,
};

/** Chitchat that never merits retrieval even past the length gate. Anchored
 *  whole-string matches only — a greeting inside a real question ("hi, what
 *  broke in the lora run?") must NOT be skipped. */
const CHITCHAT_RE =
	/^(?:hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|nice|got it|continue|好的|謝謝|嗯|哈囉|收到|繼續|沒事|再見)[\s!!.。??,,~～]*$/i;

// ---------------------------------------------------------------------------
// Gate (pure)
// ---------------------------------------------------------------------------

/** Deterministic trigger gate: length + chitchat. No LLM, no retrieval. */
export function shouldRecall(prompt: string, cfg: AutoRecallConfig = AUTORECALL_DEFAULTS): boolean {
	if (!cfg.enabled) return false;
	const trimmed = prompt.trim();
	if (trimmed.length < cfg.minPromptChars) return false;
	if (CHITCHAT_RE.test(trimmed)) return false;
	return true;
}

/** Subagent-child guard (per-session, review round 2): every spawnSubagent
 *  child path runs on an in-memory session — `sessionManager.getSessionFile()`
 *  returns "" — while a persisted main session carries a real file path. The
 *  wiring reads its OWN ExtensionContext and passes the value here. */
export function isChildSession(sessionFile: string | undefined): boolean {
	return !sessionFile;
}

// ---------------------------------------------------------------------------
// Budget (pure)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BudgetedEntry {
	/** The card's L0 abstract line (already rendered). */
	line: string;
	/** Effective tier after budget demotion — L0 is the floor, so a line
	 *  that still overflows its share is DROPPED (tail-first), not sliced. */
	kept: boolean;
	/** Why an entry was dropped (trace/debug). */
	reason?: "per-entry-overflow" | "turn-cap";
}

export interface BudgetResult {
	/** Rendered lines that fit the budget, in ranked order. */
	lines: string[];
	/** Full per-entry accounting (kept + dropped), ranked order. */
	entries: BudgetedEntry[];
	/** Estimated tokens of the kept lines. */
	tokensUsed: number;
}

/**
 * Apply the two-level budget to rendered L0 lines:
 *   - per-entry cap = 2 × (tokenCap / n) — one card may take at most double
 *     its fair share, so a single high-signal card cannot eat the whole turn;
 *   - turn cap = tokenCap — the walk visits lines in RANKED order and drops
 *     any line that does not fit, KEEPING the scan going (a shorter
 *     lower-ranked line may still fit). A higher-ranked line can therefore
 *     be dropped while a shorter lower-ranked one survives; that is the
 *     intended token-efficiency, not a tail-only rule.
 * L0 is the shallowest tier, so "demote" degenerates to "drop" here; the
 * demote-not-truncate discipline is preserved by never slicing a line.
 * Note: the cap governs the card LINES only — the block chrome (fixed
 * open/hint/close, ~25 tok) rides on top.
 */
export function budgetLines(lines: string[], tokenCap: number): BudgetResult {
	const n = lines.length;
	if (n === 0) return { lines: [], entries: [], tokensUsed: 0 };
	const perEntryCap = Math.max(1, 2 * (tokenCap / n));
	const entries: BudgetedEntry[] = lines.map((line) => ({
		line,
		kept: estimateTokens(line) <= perEntryCap,
		reason: estimateTokens(line) <= perEntryCap ? undefined : "per-entry-overflow",
	}));
	// Walk ranked order, keep what fits the TURN cap; a line already killed by
	// the per-entry rule stays dead.
	let used = 0;
	const kept: string[] = [];
	for (const e of entries) {
		if (!e.kept) continue;
		const t = estimateTokens(e.line);
		if (used + t > tokenCap) {
			e.kept = false;
			e.reason = "turn-cap";
			continue; // keep scanning: a shorter lower-ranked line may still fit
		}
		used += t;
		kept.push(e.line);
	}
	return { lines: kept, entries, tokensUsed: used };
}

// ---------------------------------------------------------------------------
// Render (pure, prefix-stable)
// ---------------------------------------------------------------------------

/** Fixed block header/footer — the format is cache-stable by construction;
 * only the card lines between them vary per turn. */
export const RECALL_BLOCK_OPEN = "<knowledge-recall>";
export const RECALL_BLOCK_CLOSE = "</knowledge-recall>";
const RECALL_BLOCK_HINT =
	"Auto-recalled from the vault knowledge graph (ranked; may be irrelevant — ignore if so):";

/** One L0 line per card: `[type] title — tags (abstract)`. Tags capped at 3
 *  (TIER_ABSTRACT_TAG_HEAD is 5 for the ladder; injection lines run tighter). */
export function renderCardLine(card: RetrievedCard): string {
	const tags = card.tags.slice(0, 3).join(",");
	const head = `[${card.type}] ${card.title}`;
	return tags ? `${head} — ${tags}: ${card.detail}` : `${head}: ${card.detail}`;
}

export function renderInjectionBlock(lines: string[]): string {
	if (lines.length === 0) return "";
	return [RECALL_BLOCK_OPEN, RECALL_BLOCK_HINT, ...lines.map((l) => `- ${l}`), RECALL_BLOCK_CLOSE].join(
		"\n",
	);
}

// ---------------------------------------------------------------------------
// Pipeline (the one async fn the hook calls)
// ---------------------------------------------------------------------------

export interface AutoRecallDeps {
	/** Absolute vault path (resolved by the wiring, not here). */
	vaultPath: string;
	/** Convergence folder (default Zettelkasten/knowledge-graph). */
	folder?: string;
	/** The caller's OWN `sessionManager.getSessionFile()` — falsy (in-memory
	 *  session) marks a spawnSubagent child, which never injects. The wiring
	 *  reads its ExtensionContext; tests pass it directly. */
	sessionFile?: string;
	/** Retrieve implementation — retrieveRecords by default; injectable for
	 *  tests. */
	retrieve?: (opts: RetrieveOptions) => Promise<{ count: number; cards: RetrievedCard[] }>;
}

/**
 * Full auto-recall pass for one turn. Returns the injection block ("" when
 * nothing survives the gates), plus a machine-readable trace for tests and
 * the /knowledge-recall status view. NEVER throws — a failed retrieval means
 * no injection, not a broken turn.
 */
export async function buildAutoRecallBlock(
	prompt: string,
	deps: AutoRecallDeps,
	cfg: AutoRecallConfig = AUTORECALL_DEFAULTS,
): Promise<{ block: string; trace: { gated: boolean; retrieved: number; kept: number; tokensUsed: number; timedOut: boolean } }> {
	const trace = { gated: false, retrieved: 0, kept: 0, tokensUsed: 0, timedOut: false };
	if (!shouldRecall(prompt, cfg) || isChildSession(deps.sessionFile)) {
		trace.gated = true;
		return { block: "", trace };
	}
	// Query→tags derivation mirrors knowledge_query's no-tags path (tokenize,
	// length-filter, cap) so retrieval sees the same query shape the explicit
	// tool produces.
	const tags = prompt
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((t) => t.length >= 3 && t.length <= 30)
		.slice(0, 10);
	if (tags.length === 0) {
		trace.gated = true;
		return { block: "", trace };
	}
	const retrieve = deps.retrieve ?? retrieveRecords;
	try {
		const result = await Promise.race([
			retrieve({
				vaultPath: deps.vaultPath,
				folder: deps.folder ?? "Zettelkasten/knowledge-graph",
				tags,
				topK: cfg.topK,
				tier: "abstract",
				bodyMatch: true,
				slugDom: true,
				semantic: true,
				queryText: prompt,
				usageLog: false, // t09's recall ledger is the injector's feed, not the usage ledger
			}),
			new Promise<never>((_, reject) => {
				const t = setTimeout(() => reject(new Error("autorecall-timeout")), cfg.timeoutMs);
				// A pending timer must not hold the process open for timeoutMs
				// after the turn ends (Bun honors unref on timers).
				(t as { unref?: () => void }).unref?.();
			}),
		]);
		trace.retrieved = result.cards.length;
		// Score floor: RetrievedCard.sharedTags is the ranking score before the
		// callout boost — the top card must clear it or nothing injects.
		const top = result.cards[0];
		if (!top || top.sharedTags < cfg.scoreFloor) {
			trace.gated = true;
			return { block: "", trace };
		}
		const budget = budgetLines(result.cards.map(renderCardLine), cfg.tokenCap);
		trace.kept = budget.lines.length;
		trace.tokensUsed = budget.tokensUsed;
		return { block: renderInjectionBlock(budget.lines), trace };
	} catch (e) {
		// timeout / retrieval failure — inject nothing, never break the turn
		trace.timedOut = (e as Error).message === "autorecall-timeout";
		return { block: "", trace };
	}
}
