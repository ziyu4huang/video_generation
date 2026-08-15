---
type: grilling
blocked by: []
claimed: pi (grilling, 2026-07-31)
status: closed
resolved: 2026-07-31
---

## Question

Pin the **YAML frontmatter field schema** for a `.md` memory entry — the ubiquitous language of the new format: field names, value shapes, ordering, and optionality. Graduated from fog by ticket 00's frontmatter-migrate-everything decision. This is the domain-modeling pin every downstream ticket (parser 06, backfill 01) codes against.

## Resolution (2026-07-31)

### Schema (canonical)

```yaml
---
id: 01846a3e-7c9b-4f2a-9e1d-2b5f8a1c3d47   # uuid v4, REQUIRED post-backfill
created: 2026-07-31                          # date, REQUIRED
last: 2026-07-31                             # date, REQUIRED  (renamed from lastReferenced)
provenance: verified                         # OPTIONAL — enum: verified | unverified | none
sources:                                     # OPTIONAL — sequence of maps
  - kind: quote
    locator: session:01J9X...
    capture: "verbatim anchor"
memworth:                                    # OPTIONAL — map  (renamed from mwSuccess/mwFail)
  success: 3
  fail: 1
---
<body markdown>
```

### Rules

- **Order**: `id` → `created` → `last` → `provenance` → `sources` → `memworth`. Identity first, then temporal, trust, grounding, usage.
- **Shapes**: native YAML — `provenance` is a scalar string enum; `sources` is a sequence of maps; `memworth` is a map. **No JSON-in-string** (the whole point of frontmatter is native parseability).
- **Optionality / leanness**: **omit absent or empty fields.** A minimal entry carries only `id` + `created` + `last`.
  - `provenance: none` (the "no provenance" sentinel) is **omitted**, not written — absence encodes "none".
  - `memworth` with `success: 0` / `fail: 0` is **omitted entirely** (zero usage = no field).
  - empty `sources: []` is **omitted**.
- **`id`** is REQUIRED on every frontmatter entry (post-backfill). Pre-backfill legacy entries have no frontmatter at all — the dual-shape parser (06) handles them.
- **Dates**: `YYYY-MM-DD` (unchanged from today).

### Renames (vs current HTML-comment fields)

- `lastReferenced` → **`last`** (matches the existing `last=` display token; leaner).
- `mwSuccess` / `mwFail` → **`memworth: { success, fail }`** — collapses the two related counters under the domain concept "memworth" (memory worth). Backfill (01) maps old→new during the rewrite (free, since 01 rewrites every entry anyway).

### Map consequences

- **Ticket 06** (dual-shape parser) — was blocked-by 05; **now frontier**. Its serialize/parse must round-trip this exact schema and YAML-quote `capture` / values containing `:` or newlines.
- **Ticket 01** (backfill) — was blocked-by 05 + 06; now blocked-by **06 only**. Must apply the renames (`lastReferenced`→`last`, `mwSuccess/mwFail`→`memworth`) and the omit-empties rule during rewrite.
- No new tickets; no fog graduated (the rename-mapping and omit-empties rules fold into 01 + this schema note).
