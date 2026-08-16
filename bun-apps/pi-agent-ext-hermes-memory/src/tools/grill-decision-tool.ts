// @ts-nocheck — pre-existing type errors, never checked before this file
// became reachable via pi-agent's static import (src/static-extensions.ts);
// see that file's header comment for the full rationale. Runtime unaffected
// (Bun doesn't enforce types).
// src/tools/grill-decision-tool.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MemoryStore } from "../store/memory-store.js";
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

const GRILL_DECISION_DESCRIPTION = `Capture a resolved grill decision as durable behavioral memory. Call this once per resolved decision during a grill-me / grill-me-with-docs session, AFTER the user has answered. Pass your recommended answer, the user's actual answer, and a 'signal' classification (reject = user contradicted/rejected the recommendation; preference = user stated a standing preference or recurring trade-off; insight = user revealed a priority; refine = minor tweak; confirm = user agreed). The tool applies a gate: it writes only durable, non-duplicate, non-project-scoped signals to portable memory. Do not call this for plain confirms.`;

GATE_DEFS["grill_decision"] = {
  id: "grill_decision",
  keywords: ["grill decision", "grill a decision", "record decision", "decision grilling", "grill 決策", "記錄決策"],
  requires: {
    nouns: ["decision", "choice", "tradeoff", "決策", "選擇"],
    verbs: ["grill", "record", "capture", "decide", "記錄", "決定"],
  },
  description: "Grill/capture a decision with its tradeoffs",
};

export function registerGrillDecisionTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  // kp13 Wave B: the mirror target is the bundle CardStore (md_id-keyed upsert
  // through the registered MemoryDedupStrategy). The legacy
  // memoryRepo.syncMemoryEntry content-keyed mirror is retired on this path —
  // md stays canonical; USER.md is still written by the MemoryStore above.
  cardStore: CardStore | null = null,
): void {
  pi.registerTool({
    name: "grill_decision",
    label: "Grill Decision",
    gating: { gate: "grill_decision" }, // demoted from core (ticket 02)
    description: GRILL_DECISION_DESCRIPTION,
    parameters: Type.Object({
      decision: Type.String({ description: "The sub-decision being grilled" }),
      recommendation: Type.String({ description: "Your recommended answer" }),
      userAnswer: Type.String({ description: "The user's actual answer" }),
      signal: StringEnum(["reject", "refine", "confirm", "preference", "insight"] as const, {
        description: "Your semantic read of the user's answer (drives the gate)",
      }),
      notes: Type.Optional(
        Type.String({ description: "Durable phrasing for the memory, or a project-scope flag" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { decision, recommendation, userAnswer, signal, notes } = params;
      const content = composeMemoryContent({ decision, recommendation, userAnswer, notes });
      const gate = evaluateGrillSignal({
        signal,
        content,
        notes,
        existingEntries: store.getUserEntries(),
      });

      if (!gate.fire) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, reason: gate.reason }) }],
          details: { written: false, reason: gate.reason },
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: result.success, category, reason: gate.reason }) }],
          details: { written: result.success, category, reason: gate.reason },
        };
      } catch (err) {
        // A memory write must never block the interview.
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` }) }],
          details: { written: false, reason: "write failed" },
        };
      }
    },
  });
}


/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only
 * (recallFloor 0, adversarial []): demoted from core in ticket 02; narrow
 * keywords are intentional, so we assert the predicate fires on its own
 * keyword/requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
  gate: "grill_decision",
  recallFloor: 0,
  adversarial: [],
  controls: ['grill the decision on the model picker', 'record this decision with tradeoffs', 'capture the tradeoff we just discussed', 'grill 這個決策'],
};
