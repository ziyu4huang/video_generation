// src/tools/grill-decision-tool.ts
import type { MemoryStore } from "../store/memory-store.js";
import type { CardStore } from "../store/card-store.js";
import { mirrorMemoryAdd } from "../store/memory-card-mirror.js";
import type { MemoryCategory } from "../types.js";

export type GrillSignal = "reject" | "refine" | "confirm" | "preference" | "insight";

export interface GrillGateInput {
  signal: GrillSignal;
  content: string;
  notes?: string;
  existingEntries: string[];
  dedupThreshold?: number;
}

export interface GrillGateResult {
  fire: boolean;
  category?: MemoryCategory;
  reason: string;
}

// Fired grill signals all resolve to a single topical label — `preference` —
// because grill captures are user-traits (the user's preferences/priorities),
// not lessons. The signal still drives the gate (confirm/refine suppress); the
// stored category is uniform. (Experience-type labels failure/correction/insight
// are lesson-only per the memory model and don't fit a user-trait.)
const SIGNAL_TO_CATEGORY: Record<GrillSignal, MemoryCategory | null> = {
  reject: "preference",
  preference: "preference",
  insight: "preference",
  confirm: null,
  refine: null,
};

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/** Word-level Jaccard overlap on normalized tokens. Metadata prefixes contribute
 *  few tokens, so this is robust to the store's entry format without needing
 *  the exact metadata shape. */
export function lexicalOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const PROJECT_SCOPED_RE = /\b(project(?:-scoped)?|repo|this\s+(?:repo|project))\b/i;

/** Compose a durable, behavioral-pattern line from the grill fields.
 *  Prefers the agent-supplied `notes` (already durable); falls back to a
 *  composed sentence so the stored entry reads as a trait, not a transcript. */
export function composeMemoryContent(fields: {
  decision: string;
  recommendation: string;
  userAnswer: string;
  notes?: string;
}): string {
  if (fields.notes && fields.notes.trim()) return fields.notes.trim();
  return `${fields.userAnswer.trim()} (decision: ${fields.decision.trim()}; rejected: ${fields.recommendation.trim()})`;
}

export function evaluateGrillSignal(input: GrillGateInput): GrillGateResult {
  const { signal, content, notes, existingEntries } = input;
  const threshold = input.dedupThreshold ?? 0.8;

  const category = SIGNAL_TO_CATEGORY[signal];
  if (category === null) {
    return { fire: false, reason: `signal '${signal}' (confirm/refine) — no durable learning` };
  }

  if (notes && PROJECT_SCOPED_RE.test(notes)) {
    return { fire: false, reason: "project-scoped — belongs in CONTEXT.md/ADR, not portable memory" };
  }

  for (const existing of existingEntries) {
    if (lexicalOverlap(content, existing) >= threshold) {
      return { fire: false, reason: "duplicate of existing memory (overlap ≥ threshold)" };
    }
  }

  return { fire: true, category, reason: `signal '${signal}' → category '${category}'` };
}

/** Parameters for executeGrillDecision (was the grill_decision tool schema). */
export interface GrillDecisionParams {
  /** The sub-decision being grilled */
  decision: string;
  /** Your recommended answer */
  recommendation: string;
  /** The user's actual answer */
  userAnswer: string;
  /** Your semantic read of the user's answer (drives the gate) */
  signal: GrillSignal;
  /** Durable phrasing for the memory, or a project-scope flag */
  notes?: string;
}

/** Execute the grill_decision capture. `store` is the MemoryStore (USER.md
 *  stays canonical); `cardStore` is the kp13 Wave B mirror target (md_id-keyed
 *  upsert through the registered MemoryDedupStrategy). */
export async function executeGrillDecision(
  store: MemoryStore,
  // kp13 Wave B: the mirror target is the bundle CardStore (md_id-keyed upsert
  // through the registered MemoryDedupStrategy). The legacy
  // memoryRepo.syncMemoryEntry content-keyed mirror is retired on this path —
  // md stays canonical; USER.md is still written by the MemoryStore above.
  cardStore: CardStore | null = null,
  params: GrillDecisionParams,
): Promise<string> {
  const { decision, recommendation, userAnswer, signal, notes } = params;
  const content = composeMemoryContent({ decision, recommendation, userAnswer, notes });
  const gate = evaluateGrillSignal({
    signal,
    content,
    notes,
    existingEntries: store.getUserEntries(),
  });

  if (!gate.fire) {
    return JSON.stringify({ written: false, reason: gate.reason });
  }

  const category = gate.category!; // "preference" for every fired grill signal
  try {
    // Grill captures are user-traits: write to the `user` home carrying the
    // topical category label (per the memory model — not the failure/lesson target).
    const result = await store.add("user", content, { category });
    if (result.success && cardStore) {
      try {
        await mirrorMemoryAdd(cardStore, "user", {
          mdId: result.added_md_id,
          content: `[${category}] ${content}`,
        });
      } catch {
        // best-effort card-store mirror — must not block the grill
      }
    }
    return JSON.stringify({ written: result.success, category, reason: gate.reason });
  } catch (err) {
    // A memory write must never block the interview.
    return JSON.stringify({ written: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
