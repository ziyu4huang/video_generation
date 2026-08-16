/**
 * src/handlers/vector-backfill.ts — delta-keyed background backfill of the
 * card_vectors HNSW index (ticket 14 phase B / T3).
 *
 * WARMS the Phase-A HNSW side-table: enumerates the card-store, computes the
 * staleness delta (mdId absent OR stored contentHash ≠ current), batch-embeds
 * ONLY the delta, and upserts. Unchanged cards are NOT re-embedded — this is
 * the fix for zk's whole-cache rebuild on every boot.
 *
 * The delta-key is the SAME contentHash the 09/10 sync uses (planningContentHash
 * — sha256 of the canonical {kind,content,frontmatter} bytes), so a content/
 * frontmatter change OR a modelVersion swap (new lineage tag) flips a card stale.
 *
 * House-style is a VERBATIM mirror of session-backfill.ts / planning-backfill.ts:
 *   - `if (state.inProgress) return false` coalesces concurrent schedules;
 *   - the work runs in a `setTimeoutFn(..., 0)` deferred task so the caller
 *     (session_start / ingest receipt) resolves first;
 *   - the delta is RE-DERIVED inside the deferred task (NOT trusted from
 *     schedule time — mirrors session-backfill's in-task `needsBackfill` re-check);
 *   - try/catch error-isolated: a throw never escapes (best-effort notify);
 *   - `finally` clears inProgress + promise;
 *   - `waitForVectorBackfill` is a Promise.race shutdown drain.
 *
 * All seams are injectable for deterministic unit tests (setTimeoutFn, state,
 * a fake embedder, a mock vectorStore, a mock cardStore). NO live SurrealDB /
 * LM Studio in unit tests.
 */

import type { TimedFn } from "../perf.js";
import type { Card, CardKind } from "../store/card.js";
import type { CardStore } from "../store/card-store.js";
import type { VectorStore } from "../store/surreal/vector-store.js";
import type { Embedder } from "../store/surreal/embedder.js";
import { planningContentHash } from "../store/planning-sync-state.js";
import { upsertCachedCardVectors } from "../store/card-vectors-cache.js";

export const VECTOR_BACKFILL_SHUTDOWN_TIMEOUT_MS = 5000;
/** Embedding batch size — matches the embedder default (LM Studio /v1/embeddings
 *  is batched). Each batch is one embed call + one upsert. */
export const VECTOR_BACKFILL_EMBED_BATCH = 32;

type NotifyLevel = "info" | "warning" | "error";
type NotifyFn = (message: string, level: NotifyLevel) => void;

type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

/** Minimal card-store seam the backfill needs (enumerate cards by kind).
 *  Tests pass a mock; production passes a real CardStore. */
export type VectorBackfillCardStore = Pick<CardStore, "getCardsByKind">;

/** Minimal vector-store seam the backfill needs (read the staleness delta +
 *  write the embeddings). Tests pass a mock; production passes a real
 *  VectorStore. */
export type VectorBackfillVectorStore = Pick<VectorStore, "getStoredHashes" | "upsertVectors">;

export interface VectorBackfillState {
  inProgress: boolean;
  promise: Promise<void> | null;
}

/** Module-level singleton (mirrors sessionBackfillState / planningBackfillState).
 *  Cross-call coalescing: two concurrent schedules share this state so only one
 *  backfill runs at a time per process. */
export const vectorBackfillState: VectorBackfillState = {
  inProgress: false,
  promise: null,
};

/** Build a fresh backfill state (for tests / isolated runs). */
export function createVectorBackfillState(): VectorBackfillState {
  return { inProgress: false, promise: null };
}

export interface ScheduleVectorBackfillOptions {
  /** kp18 T5b: mirror target dir for `card-vectors-cache.json`. Optional — unset → no mirror. */
  memoryDir?: string;
  notify?: NotifyFn;
  state?: VectorBackfillState;
  setTimeoutFn?: SetTimeoutFn;
  /** Perf wrapper (default pass-through). index.ts injects the real recorder. */
  timed?: TimedFn;
}

/** One card resolved for the delta compute: its stable id, kind, embeddable
 *  text, and current content-hash (the delta-key). */
interface ResolvedCard {
  mdId: string;
  kind: CardKind;
  text: string;
  contentHash: string;
}

/** Build the embeddable text for a Card. Captures the title (knowledge cards
 *  carry `frontmatter.title`) + tags + the body content, whitespace-normalised
 *  and capped at 1000 chars (mirrors zk's cardEmbedText convention). The
 *  content-hash (planningContentHash) already covers kind+content+frontmatter,
 *  so this only decides WHAT gets embedded; the delta-key is independent. */
function cardEmbedText(card: Card): string {
  const fm = card.frontmatter ?? {};
  const parts: string[] = [];
  const title = typeof fm.title === "string" ? fm.title.trim() : "";
  if (title) parts.push(title);
  if (Array.isArray(fm.tags)) {
    const tags = fm.tags.filter((t): t is string => typeof t === "string");
    if (tags.length > 0) parts.push(tags.join(" "));
  }
  const body = typeof card.content === "string" ? card.content.trim() : "";
  if (body) parts.push(body);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function notifyBestEffort(notify: NotifyFn | undefined, message: string, level: NotifyLevel): void {
  try {
    notify?.(message, level);
  } catch {
    // Notification failures must never affect backfill.
  }
}

/** Enumerate the cards of `kinds` from the store, resolving each to
 *  {mdId, kind, text, contentHash}. Cards with a falsy id are skipped (no stable
 *  join key). Wrapped in `timed` so the enumeration is observable. */
async function resolveCards(
  cardStore: VectorBackfillCardStore,
  kinds: CardKind[],
  timed: TimedFn,
): Promise<ResolvedCard[]> {
  const out: ResolvedCard[] = [];
  for (const kind of kinds) {
    const rows = await timed("vectorBackfill.getCardsByKind", () => cardStore.getCardsByKind(kind));
    for (const card of rows) {
      if (!card || typeof card.id !== "string" || !card.id) continue;
      out.push({
        mdId: card.id,
        kind: card.kind,
        text: cardEmbedText(card),
        contentHash: planningContentHash(card),
      });
    }
  }
  return out;
}

/**
 * Schedule a best-effort, delta-keyed background backfill of the card_vectors
 * HNSW index. Mirrors scheduleSessionBackfill: inProgress guard + setTimeout(0)
 * deferral + in-task delta re-check + error isolation + finally clears state.
 *
 * The deferred task:
 *   1. enumerates cards of `kinds` → resolve {mdId, text, contentHash};
 *   2. reads `stored = vectorStore.getStoredHashes(modelVersion)`;
 *   3. delta = cards absent from `stored` OR whose stored hash ≠ current hash;
 *   4. if delta empty → done (no embed work);
 *   5. else batch-embed (≤ EMBED_BATCH) + upsert, looping until the delta is
 *      consumed (the local `stored` map is updated per batch so a re-derivation
 *      would exclude just-upserted cards — the in-task re-check discipline).
 *
 * @returns true when a backfill task was scheduled; false when it was skipped
 *          (another backfill is already in progress — the coalescing guard).
 */
export function scheduleVectorBackfill(
  cardStore: VectorBackfillCardStore,
  vectorStore: VectorBackfillVectorStore,
  embedder: Embedder,
  kinds: CardKind[],
  modelVersion: string,
  embedModel: string,
  options: ScheduleVectorBackfillOptions = {},
): boolean {
  const state = options.state ?? vectorBackfillState;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const timed: TimedFn = options.timed ?? ((_op, fn) => fn());

  if (state.inProgress) {
    return false;
  }

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(async () => {
      let embedded = 0;
      try {
        // RE-CHECK inside the deferred task: derive the delta NOW, not at
        // schedule time (mirrors session-backfill's in-task needsBackfill
        // re-check — by the time this fires, store state is authoritative).
        const cards = await timed("vectorBackfill.resolveCards", () =>
          resolveCards(cardStore, kinds, timed),
        );
        if (cards.length === 0) return;

        const stored = await timed("vectorBackfill.getStoredHashes", () =>
          vectorStore.getStoredHashes(modelVersion),
        );

        // Delta: absent OR stale (stored hash ≠ current). Unchanged cards are
        // excluded — the whole point of the contentHash delta-key.
        const delta: ResolvedCard[] = [];
        for (const c of cards) {
          const prev = stored.get(c.mdId);
          if (prev === undefined || prev !== c.contentHash) delta.push(c);
        }
        if (delta.length === 0) return;

        // Batch-embed + upsert, reflecting each batch into the local `stored`
        // map so a re-derivation would exclude just-written cards (re-check
        // after each batch). One getStoredHashes round-trip total.
        for (let i = 0; i < delta.length; i += VECTOR_BACKFILL_EMBED_BATCH) {
          const batch = delta.slice(i, i + VECTOR_BACKFILL_EMBED_BATCH);
          const texts = batch.map((c) => c.text);
          const vecs = await timed("vectorBackfill.embed", () => embedder(texts, embedModel));
          if (!Array.isArray(vecs) || vecs.length !== batch.length) {
            throw new Error(
              `embedder returned ${Array.isArray(vecs) ? vecs.length : "non-array"} vectors for ${batch.length} texts`,
            );
          }
          const entries = batch.map((c, j) => ({
            mdId: c.mdId,
            kind: c.kind,
            vec: vecs[j]!,
            contentHash: c.contentHash,
            modelVersion,
          }));
          await timed("vectorBackfill.upsertVectors", () => vectorStore.upsertVectors(entries));
          // kp18 T5b: mirror the batch into the hermes-side JSON cache so the memory
          // cold path can cosine locally while SurrealDB is down. Best-effort — a
          // mirror failure never breaks the backfill.
          if (options.memoryDir) {
            try {
              upsertCachedCardVectors(
                options.memoryDir,
                entries.map((e) => ({
                  mdId: e.mdId,
                  kind: e.kind,
                  embedModel,
                  contentHash: e.contentHash,
                  vec: Array.from(e.vec ?? []),
                })),
              );
            } catch {
              /* best-effort mirror */
            }
          }
          for (const c of batch) stored.set(c.mdId, c.contentHash);
          embedded += batch.length;
        }

        notifyBestEffort(
          options.notify,
          `🧠 Vector backfill complete: ${embedded} embedded, ${cards.length - embedded} unchanged.`,
          "info",
        );
      } catch (err) {
        notifyBestEffort(
          options.notify,
          `⚠️ Vector backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      } finally {
        state.inProgress = false;
        state.promise = null;
        resolve();
      }
    }, 0);
  });

  return true;
}

/**
 * Wait briefly for an in-progress vector backfill before shutdown (mirrors
 * waitForSessionBackfill / waitForPlanningBackfill).
 *
 * @returns true if no backfill was running or it completed before the timeout;
 * false if the timeout elapsed first.
 */
export async function waitForVectorBackfill(
  timeoutMs = VECTOR_BACKFILL_SHUTDOWN_TIMEOUT_MS,
  state: VectorBackfillState = vectorBackfillState,
): Promise<boolean> {
  const promise = state.promise;
  if (!state.inProgress || !promise) {
    return true;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
