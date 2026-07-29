/**
 * Backend-neutral pure memory formatting / parsing helpers.
 *
 * This module is deliberately free of any DB coupling — no `bun:sqlite`, no
 * `SqliteBackend`, no driver calls. It exists so that upstream callers
 * (`index.ts`, `handlers/*`, `tools/*`) can format and parse memory entries
 * without importing a SQLite implementation module, preserving the
 * backend-abstraction seam established by the repository refactor.
 *
 * The SQLite repository (`store/sqlite/sqlite-memory-repo.ts`) imports these
 * same helpers back from here — they were originally defined inline in that
 * file and were moved out to keep the seam clean (DRY: single source of truth).
 */

import type { MemoryCategory, Provenance, MemorySource } from "../types.js";
import type { MemoryTarget } from "./repository.js";

// ---------------------------------------------------------------------------
// Pure helpers (copied verbatim from the former sqlite-memory-store.ts).
// ---------------------------------------------------------------------------

export const FAILURE_CATEGORY_SET = new Set<MemoryCategory>([
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
]);

export function today(): string {
  return new Date().toISOString().split("T")[0];
}

export function normalizeNullable(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCategory(value?: MemoryCategory | null): MemoryCategory | null {
  return value ?? null;
}

export function parseMetadataComment(raw: string): {
  text: string;
  created: string;
  lastReferenced: string;
  provenance?: Provenance;
  sources?: MemorySource[];
} {
  let rest = raw;
  let provenance: Provenance | undefined;
  let sources: MemorySource[] | undefined;

  // Stage 1: optional trailing <!-- meta:{...} --> (always last).
  const metaMatch = rest.match(/<!--\s*meta:(\{.*\})\s*-->\s*$/);
  if (metaMatch && metaMatch.index !== undefined) {
    try {
      const parsed = JSON.parse(metaMatch[1]) as { provenance?: Provenance; sources?: MemorySource[] };
      provenance = parsed.provenance;
      sources = Array.isArray(parsed.sources) ? parsed.sources : undefined;
    } catch {
      // malformed meta — ignore, keep created/last below
    }
    rest = rest.slice(0, metaMatch.index).trimEnd();
  }

  // Stage 2: unchanged created/last regex on the remainder.
  const match = rest.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^>]+)\s*-->\s*$/);
  if (match) {
    return {
      text: match[1].trim(),
      created: match[2].trim(),
      lastReferenced: match[3].trim(),
      ...(provenance ? { provenance } : {}),
      ...(sources ? { sources } : {}),
    };
  }

  const fallback = today();
  return {
    text: rest.trim(),
    created: fallback,
    lastReferenced: fallback,
    ...(provenance ? { provenance } : {}),
    ...(sources ? { sources } : {}),
  };
}

export function formatFailureMemoryContent(
  content: string,
  options: {
    category: MemoryCategory;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    project?: string | null;
  },
): string {
  const categoryTag = `[${options.category}]`;
  const parts = [`${categoryTag} ${content.trim()}`.trim()];
  if (options.failureReason) parts.push(`Failed: ${options.failureReason}`);
  if (options.toolState) parts.push(`Tool state: ${options.toolState}`);
  if (options.correctedTo) parts.push(`Corrected to: ${options.correctedTo}`);
  if (options.project) parts.push(`Project: ${options.project}`);
  return parts.join(" — ");
}

export interface ParsedMarkdownMemoryEntry {
  content: string;
  target: MemoryTarget;
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
  provenance?: Provenance | null;
  sources?: MemorySource[] | null;
}

export function parseMarkdownMemoryEntry(
  rawEntry: string,
  target: MemoryTarget,
  project: string | null = null,
): ParsedMarkdownMemoryEntry {
  const { text, created, lastReferenced, provenance, sources } = parseMetadataComment(rawEntry);
  const parsedProject = normalizeNullable(project);

  if (target !== "failure") {
    return {
      content: text,
      target,
      project: parsedProject,
      created,
      lastReferenced,
      ...(provenance ? { provenance } : {}),
      ...(sources ? { sources } : {}),
    };
  }

  let category: MemoryCategory | null = null;
  let failureReason: string | null = null;
  let toolState: string | null = null;
  let correctedTo: string | null = null;

  const categoryMatch = text.match(/^\[([^\]]+)\]\s+/);
  if (categoryMatch && FAILURE_CATEGORY_SET.has(categoryMatch[1] as MemoryCategory)) {
    category = categoryMatch[1] as MemoryCategory;
  }

  const segments = text.split(" — ");
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("Failed: ") && !failureReason) {
      failureReason = segment.slice("Failed: ".length).trim() || null;
      continue;
    }
    if (segment.startsWith("Tool state: ") && !toolState) {
      toolState = segment.slice("Tool state: ".length).trim() || null;
      continue;
    }
    if (segment.startsWith("Corrected to: ") && !correctedTo) {
      correctedTo = segment.slice("Corrected to: ".length).trim() || null;
    }
  }

  return {
    content: text,
    target: "failure",
    project: parsedProject,
    category,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
    ...(provenance ? { provenance } : {}),
    ...(sources ? { sources } : {}),
  };
}
