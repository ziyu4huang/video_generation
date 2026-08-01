---
type: prototype
blocked by: [05-frontmatter-field-schema]
claimed: pi (prototype, 2026-07-31)
status: closed
resolved: 2026-07-31
---

## Question

The **dual-shape transition parser**: during the lazy-migration window, `.md` holds a mix of **new YAML-frontmatter** entries and **legacy HTML-comment** entries. Pin how the reader detects + handles both shapes, prove §-delimiter safety isn't broken by frontmatter's leading `---`, and decide the **legacy-comment retirement criteria**. Graduated from fog by ticket 00's lazy-migration decision.

## Resolution (2026-07-31)

### Delimiter safety — VERIFIED (load-bearing check passes)

`ENTRY_DELIMITER = "\n§\n"` (constants.ts). Entries split on newline-§-newline. **YAML frontmatter fences are `---`; `§` is not a YAML structural character and the split token `\n§\n` requires a standalone `§` line, which the pinned schema (05) never produces.** So frontmatter `---` cannot collide with the entry split. Empirically confirmed by a 3-entry dual-shape prototype (frontmatter + legacy-comment + a `---`-prefixed legacy body): split count = 3, round-trip `split → join === original`, no delimiter leak.

### Detection rule (robust)

An entry is **frontmatter** iff:
1. `lines[0] === "---"` (opens with a fence), **AND**
2. a **closing `---` fence line exists at index > 0** (matched fence pair at the entry top).

The closing-fence requirement is what makes it robust: a legacy body that merely *starts* with a markdown horizontal rule `---` (no closing fence) is correctly **not** detected as frontmatter. (Empirically: the `---`-prefixed-no-fence prototype entry → `frontmatter=false`.) Absent or malformed frontmatter → fall through to the legacy-comment parse path.

### Read paths (dual-shape)

- **Frontmatter entry** → parse the YAML block (between the fences) per schema 05; body = everything after the closing fence.
- **Legacy entry** → existing `parseMetadataComment` path (unchanged) — trailing `<!-- … -->` + `<!-- meta:{…} -->`.
- **`stripMetadata` parity**: stripping frontmatter must yield the **identical body** that stripping the comment yields today, so FTS indexing + `dedupNormalize` behave identically pre/post migration. (Implementation must verify with a round-trip test.)

### Retirement criteria — DECIDED

**Backfill (ticket 01) completion is the trigger:** once backfill reports `0` legacy-comment entries remaining, the vault is 100% frontmatter. **Keep the read-only legacy fallback for one more release as a safety net** (catches any straggler / manually-added legacy entry), then **delete the legacy read-path**. Rationale: backfill completion is a natural, verifiable node; the one-release net absorbs edge cases without carrying dual-shape complexity permanently.

### Implementation note (for the plan, not a ticket)

Serialize/parse YAML frontmatter: pick a `yaml`/`js-yaml` dependency **vs** hand-rolling for the fixed schema (05 is simple — scalars, one sequence-of-maps, one map). This is a build-time how, resolved when writing the implementation plan — not a route-blocking decision, so it stays out of the wayfinder map.

### Map consequences

- **Ticket 01 (backfill)** — schema (05) + parser (06) now closed; its **binding blocker is now 02** (dual-backend id shape), since 01's DB-row-coupling sub-question depends on how the id joins across SQLite/Surreal. Edge rewired: 01 blocked-by `[02-dual-backend-id-reconciliation]`.
- No new tickets; no fog graduated.
