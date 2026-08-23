/**
 * src/hotness.ts — OpenViking memory-lifecycle hotness scoring (kcard-parity
 * ticket 08, D37–D39; upstream reference `openviking/retrieve/memory_lifecycle.py`
 * + `hierarchical_retriever.py`, capability port — no code copy).
 *
 * Formula (D38, upstream verbatim):
 *
 *     hotness = sigmoid(log1p(activeCount)) · exp(−ln2/halfLifeDays · ageDays)
 *
 *   - frequency: `1/(1+e^(−log1p(n)))` maps the usage count into (0,1) —
 *     log-compressed, so the 1st and 2nd use matter far more than the 99th
 *     vs 100th;
 *   - recency: exponential decay with a 7-day half-life (upstream
 *     `DEFAULT_HALF_LIFE_DAYS = 7.0`, D38) — a card used now scores 1.0,
 *     one used 7d ago 0.5, 14d ago 0.25 …;
 *   - a card with NO usage timestamp scores 0.0 (upstream's
 *     missing-`updated_at` behaviour) — never-used is cold, not neutral.
 *
 * Blend (D39, upstream `(1−alpha)·score + alpha·hotness`): opt-in via
 * `hotnessAlpha`, default 0 = OFF — upstream's own `hotness_alpha` default is
 * 0.0, which aligns with the bounded-feedback rule (context-lifecycle D8:
 * beat the count baseline on the eval set BEFORE any default flip, which
 * routes through the ticket 09 gate). When enabled, alpha is capped at
 * 0.10: on the flat lane's integer-ish scores that bound reorders ties
 * (equal score ± hotness contribution) but never displaces a strictly higher
 * score — feedback re-ranks, it never dominates.
 *
 * Pure module — no IO, no ExtensionAPI. The usage FEED is D37: the
 * SurrealDB `usage` append-only table (src/usage.ts), fed by explicit
 * `zk_card` reads and (downstream, context-lifecycle) the auto-recall
 * injector; retrieval itself stays read-only.
 */

/** Recency half-life in days (D38; upstream DEFAULT_HALF_LIFE_DAYS = 7.0). */
export const HOTNESS_HALF_LIFE_DAYS = 7;

/** Upper bound on the blend weight when hotness is enabled (D39, the ≤±10%
 *  score-contribution rule). Default (0) = OFF. */
export const HOTNESS_ALPHA_MAX = 0.1;

/** Validate + normalize a caller-passed blend weight. undefined → 0 (OFF).
 *  Throws RangeError outside [0, HOTNESS_ALPHA_MAX] — a config error should
 *  fail loud at the boundary, not silently clamp a typo into a ranking
 *  change. */
export function resolveHotnessAlpha(alpha: number | undefined): number {
	if (alpha === undefined) return 0;
	if (!Number.isFinite(alpha) || alpha < 0 || alpha > HOTNESS_ALPHA_MAX) {
		throw new RangeError(`hotnessAlpha must be within [0, ${HOTNESS_ALPHA_MAX}] (D39 bound) — got ${alpha}`);
	}
	return alpha;
}

/** Milliseconds per day (age normalization). */
const MS_PER_DAY = 86_400_000;

/**
 * The 0–1 hotness score (D38). `lastUsedAt` is the LAST USE timestamp
 * (D37 — max usage-event ts from the ledger, NOT card mtime: a content edit
 * is not a retrieval). Accepts epoch ms or an ISO string; null/undefined →
 * 0.0 (never-used is cold). `now` is injectable for deterministic tests.
 */
export function hotnessScore(
	activeCount: number,
	lastUsedAt: number | string | null | undefined,
	now: number | string | Date = Date.now(),
	halfLifeDays: number = HOTNESS_HALF_LIFE_DAYS,
): number {
	if (activeCount <= 0) return 0;
	const ts = typeof lastUsedAt === "string" ? Date.parse(lastUsedAt) : lastUsedAt;
	if (ts === null || ts === undefined || !Number.isFinite(ts)) return 0;
	const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
	const ageDays = Math.max((nowMs - ts) / MS_PER_DAY, 0);
	// Frequency: sigmoid(log1p(n)) — log-compressed count into (0,1).
	const freq = 1 / (1 + Math.exp(-Math.log1p(activeCount)));
	// Recency: exp(−ln2/T · age) — half-life T.
	const recency = Math.exp((-Math.LN2 / halfLifeDays) * ageDays);
	return freq * recency;
}

/**
 * Blend a retrieval score with hotness, upstream formula
 * `(1−alpha)·score + alpha·hotness` (D39). Alpha is trusted already
 * validated (resolveHotnessAlpha) — this is the hot inner path.
 */
export function blendWithHotness(score: number, hotness: number, alpha: number): number {
	return (1 - alpha) * score + alpha * hotness;
}
