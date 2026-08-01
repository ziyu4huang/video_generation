---
type: grilling
blocked by: []
claimed: pi (grilling, 2026-07-31)
status: closed
resolved: 2026-07-31
---

## Question

What is the **stable id** for a `.md` memory entry, and where does it live? Pin the identity model: the id's *kind* (content-hash / uuid / sequential / portable-synthetic) **and** its *home* in `.md` (extend the existing `<!-- created=…, last=… -->` HTML comment / switch to YAML frontmatter — a format break / separate id marker / other). These are co-determined, so resolve them as one model.

## Why

This is the foundational ticket — every other decision (backfill, dual-backend shape, capacity-loop interaction, retiring the content-key bridge) hangs on what the id *is* and *where* it sits. 5b's content-key bridge exists only because `.md` has no identity today; 5d's whole point is to add one that survives a body edit and survives dedup.

## Resolution (2026-07-31)

**Kind — assigned-immutable, `crypto.randomUUID()` (uuid v4).** Zero new dependency (Web Crypto global in Node + Bun, no import); collision-proof; immutable across content edits by construction — the exact fragility 5d exists to fix. `.md` already carries `created=`, so no time-ordering is needed → uuid v4 over v7/ULID.
- *Rejected — content-hash of body:* an edit changes the hash = the id changes = reproduces 5b's fragility. Self-defeating for the stated goal.
- *Rejected — sequential:* DB-coupled (SQLite autoincrement vs Surreal record-id differ), non-portable across backends (see ticket 02), unstable under rebuild/reorder.

**Home — YAML frontmatter, migrate-everything.** *All* metadata (`id`, `created`, `last`, `provenance`, `sources`, `mwSuccess`, `mwFail`) moves to a frontmatter block at the top of each entry; the HTML comment is **retired**. Driver (user): **standard / tooling parseability** — Obsidian and YAML-native tooling parse frontmatter natively; the HTML comment does not. That benefit only pays off when *all* metadata is frontmatter, so `id`-alone-in-frontmatter was rejected as incoherent (split source-of-truth, two parsers).
- *Rejected — extend the HTML comment:* smallest blast radius, and `serializeMetadataComment`/`parseMetadataComment` (memory-format.ts) is already an optional-field chokepoint — but it forgoes the tooling-parseability driver the user is choosing 5d to capture.

**Migration — lazy, riding on backfill.** Backfill (ticket 01, now expanded) assigns the uuid *and* rewrites the entry to frontmatter in the same per-entry pass. A **dual-shape transition parser** (new ticket 06) reads frontmatter OR the legacy comment during the transition window, until backfill completes. No big-bang rewrite of the vault.

**FTS / content-key safety — confirmed by construction.** `stripMetadata` (→ `parseMetadataComment(…).text`) drops the *entire* metadata block today; under frontmatter it drops the frontmatter block the same way. So `id` + metadata stay out of the indexed body and out of `dedupNormalize`. (Clears the map's "FTS / recall impact" fog.)

### Map consequences (applied this session)

- **Destination redrawn** — 5d is now "migrate `.md` metadata to YAML frontmatter (retire the HTML comment) + stable id anchor, via lazy backfill-riding migration; retire 5b's content-key bridge."
- **Ticket 01 expanded** — backfill does double duty: assign uuid + rewrite to frontmatter; blocked-by the new 05 + 06.
- **Graduated from fog → ticket 05** (frontmatter field schema: names/types/order — the ubiquitous language of the new format). Frontier.
- **Graduated from fog → ticket 06** (dual-shape transition parser: frontmatter-vs-comment detection, §-delimiter safety, legacy-comment retirement criteria). Blocked-by 05.
- Tickets 02 (dual-backend), 03 (capacity-loop lifecycle), 04 (retire content-key) unchanged in substance; 02 and 03 are now frontier.
