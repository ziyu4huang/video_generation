// src/tools/grill-decision-tool.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import { formatFailureMemoryContent, syncMemoryEntry } from "../store/sqlite-memory-store.js";
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

const SIGNAL_TO_CATEGORY: Record<GrillSignal, MemoryCategory | null> = {
  reject: "correction",
  preference: "preference",
  insight: "insight",
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

// registerGrillDecisionTool is added in Task 3.
