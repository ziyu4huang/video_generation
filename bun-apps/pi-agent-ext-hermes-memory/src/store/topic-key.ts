/**
 * Topic-key extraction + recurrence detection for failureModel "v1"
 * (wayfind effort 2026-08-05, ticket 04 — hybrid identity).
 *
 * Containment (near-dup.ts) catches wording-variants but misses *evolving
 * families* — the same subject re-captured across different incidents with low
 * token overlap (e.g. the `await_pr_merge` ×7 cluster). The TOPIC-KEY is the
 * subject entity used to group such families; it is also the signal the
 * recurrence→skill graduation prompt rule (the MEMORY_POLICY_PROMPT in constants.ts) keys on.
 *
 * Deterministic (no LLM) so the backlog canonicalization is auditable.
 * tool-quirk → the subject tool name; other categories → the first few
 * distinctive content tokens.
 */
import type { MemoryCategory } from "../types.js";
import { nearDupTokens } from "./near-dup.js";

const CATEGORY_PREFIX_RE = /^\s*\[([^\]]+)\]\s*/;
const KNOWN_CATEGORIES: MemoryCategory[] = [
  "failure", "correction", "insight", "preference", "convention", "tool-quirk",
];

/** Derive the failure category from a leading `[category]` prefix, or null. */
export function deriveCategory(content: string): MemoryCategory | null {
  const m = content.match(CATEGORY_PREFIX_RE);
  if (!m) return null;
  return (KNOWN_CATEGORIES as string[]).includes(m[1]) ? (m[1] as MemoryCategory) : null;
}

function stripCategoryPrefix(text: string): string {
  return text.replace(CATEGORY_PREFIX_RE, "");
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 64);
}

/**
 * Deterministic topic-key for recurrence grouping.
 * - tool-quirk → subject tool/command: first backtick code span, else the first
 *   identifier-like token. (e.g. "`await_pr_merge` merges …" → "await_pr_merge".)
 * - other categories → first 3 distinctive content tokens (positional), joined "_".
 * Returns "" when no distinctive token is found (too short to group).
 */
export function topicKey(content: string): string {
  const category = deriveCategory(content);
  const body = stripCategoryPrefix(content).trim();
  if (category === "tool-quirk") {
    const codeSpan = body.match(/`([^`]+)`/);
    if (codeSpan) return normalizeKey(codeSpan[1]);
    const ident = body.match(/\b([a-z][a-z0-9_]+(?:[\s-][a-z][a-z0-9_-]+)?)\b/i);
    if (ident) return normalizeKey(ident[1]);
  }
  const tokens = [...nearDupTokens(body)];
  return tokens.slice(0, 3).join("_");
}

export interface TopicRecurrenceHit {
  /** Index into the `existing` array of the matched entry. */
  index: number;
  /** The shared topic-key. */
  topicKey: string;
  /** First ~60 chars of the matched existing entry. */
  preview: string;
}

/**
 * Find the first existing entry sharing `content`'s topic-key. `existing` entries
 * are assumed already metadata-stripped by the caller. Returns null when
 * `content` has no topic-key or no existing entry shares it. Mirrors
 * `findNearDuplicate`'s shape.
 */
export function findTopicRecurrence(
  content: string,
  existing: string[],
): TopicRecurrenceHit | null {
  const key = topicKey(content);
  if (!key) return null;
  for (let i = 0; i < existing.length; i++) {
    const entry = existing[i] ?? "";
    if (topicKey(entry) === key) {
      return { index: i, topicKey: key, preview: entry.slice(0, 60).trim() };
    }
  }
  return null;
}

/** Format the write-time recurrence warning (warn-don't-block). Pure + unit-tested
 *  so the _addInner wiring (Task 3) needs no store-harness test. */
export function formatTopicRecurrenceWarning(hit: TopicRecurrenceHit): string {
  return ` ⚠ recurring topic "${hit.topicKey}" (already captured: "${hit.preview}…"). A lesson needed ≥2× is procedural → consider graduating it to a skill (skill_manage) and consolidating these entries.`;
}
