/**
 * MemorySerializer — the `CardSerializer` for kinds memory/user/failure.
 *
 * This is an EXTRACT (relocation), NOT a rewrite: every byte is produced by the
 * existing pure codec in `memory-format.ts` (`serializeMetadataFrontmatter` /
 * `parseMetadataFrontmatter` / `parseMetadataComment` / `detectEntryShape`).
 * The store keeps calling `memory-format.ts` directly today (full rewire is
 * 06b); both this adapter and the store share the single source of truth, so
 * memory-cards stay byte-for-byte unchanged.
 *
 * `serialize(card)` maps a `Card` → `serializeMetadataFrontmatter(...)` reading
 * the envelope from `card.frontmatter`. `deserialize(fileBytes)` mirrors
 * `MemoryStore.decodeEntry`'s shape-aware parse (frontmatter vs comment) over
 * each `ENTRY_DELIMITER`-split fragment, mapping to `Card[]` with the
 * constructor kind. The id fallback for legacy comment-shape entries (no id) is
 * a freshly-minted UUID, mirroring how the store mints ids at backfill time.
 */

import { randomUUID } from "node:crypto";
import type { Card } from "./card.js";
import type { CardSerializer } from "./card-serializer.js";
import type { MemorySource, Provenance } from "../types.js";
import {
  normalizeFailureState,
  serializeMetadataFrontmatter,
  today,
  decodeMemoryEntry,
} from "./memory-format.js";
import { ENTRY_DELIMITER } from "../constants.js";

type MemoryKind = "memory" | "user" | "failure";

/** Safe runtime coercion of an opaque envelope value to `Provenance | null`.
 *  Literal comparisons so TS auto-narrows `v` to the union — no `as`. */
function coerceProvenance(v: unknown): Provenance | null {
  if (v === "verified" || v === "unverified" || v === "none") return v;
  return null;
}

/** Type guard for a `MemorySource` ({kind,locator,capture} all string). */
function isMemorySource(v: unknown): v is MemorySource {
  if (v === null || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  return typeof rec.kind === "string" && typeof rec.locator === "string" && typeof rec.capture === "string";
}

/** Safe runtime coercion of an opaque envelope value to `MemorySource[] | null`.
 *  Validates each item via `isMemorySource`; drops malformed items. */
function coerceSources(v: unknown): MemorySource[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(isMemorySource);
  return out.length > 0 ? out : null;
}

export class MemorySerializer implements CardSerializer<MemoryKind> {
  readonly kind: MemoryKind;

  constructor(kind: MemoryKind = "memory") {
    this.kind = kind;
  }

  serialize(card: Card): string {
    const fm = card.frontmatter;
    const created = typeof fm.created === "string" ? fm.created : today();
    const last =
      typeof fm.last === "string" ? fm.last : typeof fm.lastReferenced === "string" ? fm.lastReferenced : created;
    // Only surface `state` when the envelope actually carries one — absent must
    // NOT default to `active` here (that would emit `state: active` on memory
    // cards and break byte-identity; the default applies to the failure decode
    // path, not the encode path).
    const state = typeof fm.state === "string" ? normalizeFailureState(fm.state) : null;
    const severity = typeof fm.severity === "number" && fm.severity >= 1 && fm.severity <= 3 ? fm.severity : null;
    return serializeMetadataFrontmatter({
      id: typeof fm.id === "string" ? fm.id : card.id,
      text: card.content,
      created,
      last,
      state,
      severity,
      pin: fm.pin === true ? true : null,
      provenance: coerceProvenance(fm.provenance),
      sources: coerceSources(fm.sources),
      mwSuccess: typeof fm.mwSuccess === "number" ? fm.mwSuccess : null,
      mwFail: typeof fm.mwFail === "number" ? fm.mwFail : null,
    });
  }

  deserialize(fileBytes: string): Card[] {
    const cards: Card[] = [];
    for (const fragment of fileBytes.split(ENTRY_DELIMITER)) {
      const trimmed = fragment.trim();
      if (trimmed.length === 0) continue;
      // Unified decode (architecture-deepening C1 v2): shape-aware + lenient
      // per fragment — a malformed-frontmatter fragment no longer THROWS
      // (baked-in fix (a)); it degrades to a comment-shape minimal entry.
      // Comment-shape entries (incl. that lenient fallback) carry no id → mint
      // a fresh UUID, mirroring store backfill (preserved behavior). A
      // frontmatter entry whose `id` is missing / non-string (baked-in fix
      // (b)) likewise mints one — the Card.id join key must be a real string,
      // never the literal "undefined" the legacy String() coerce produced.
      const d = decodeMemoryEntry(fragment);
      const id = d.id || randomUUID();
      const envelope: Record<string, unknown> = {
        id,
        created: d.created,
        last: d.lastReferenced,
      };
      if (d.state) envelope.state = d.state;
      if (typeof d.severity === "number") envelope.severity = d.severity;
      if (d.pin === true) envelope.pin = true;
      if (d.provenance) envelope.provenance = d.provenance;
      if (Array.isArray(d.sources)) envelope.sources = d.sources;
      if (typeof d.mwSuccess === "number") envelope.mwSuccess = d.mwSuccess;
      if (typeof d.mwFail === "number") envelope.mwFail = d.mwFail;
      cards.push({ id, kind: this.kind, content: d.text, frontmatter: envelope });
    }
    return cards;
  }
}
