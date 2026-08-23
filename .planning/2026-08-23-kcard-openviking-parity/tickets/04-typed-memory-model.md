# 04 — typed memory model

type: grilling
blocked by: 02 (types land as schema fields/tables in the index)

## Question

OpenViking types memory as `profile, preferences, entities, events, identity, soul, cases, trajectories, experiences` under a schema registry for custom types. Map this onto kcard — questions to settle:

- Do OpenViking types become kcard **card kinds** (schema v2 already has `kind:` incl. `experience`), vault **folders**, frontmatter **tags**, or a mix?
- Which types matter for this user's vault? `entities`/`events`/`cases`/`experiences` look near-existing (entity-summary, extractor relations, experience kind); `identity`/`soul` look SaaS-user-profile-shaped and possibly out of scope.
- Schema registry: is kcard's existing frontmatter schema extensible enough (schema v2 MERGE_OPS) or does typing need a registry layer like OpenViking's `memory_type_registry`?
- How do typed queries interact with retrieval when D5/D6 forbid an LLM intent analyzer — is the type a filter parameter the caller passes (deterministic), mirroring how `knowledge_query` takes `tier` today?

## Resolution (2026-08-23, grilled on measured facts — CLOSED)

Facts measured this session (local OpenViking clone + this worktree, 2026-08-23):

- OpenViking ships **11 memory types** as per-type YAML in the registry (`openviking/prompts/templates/memory/`): 9 enabled (cases, entities, events, experiences, identity, preferences, profile, soul, trajectories), 2 disabled (skills, tools). Each YAML declares: typed `fields` with per-field `merge_op` (**immutable/replace/sum/union — the exact vocabulary of kcard's `MERGE_OPS`**, card-format.ts:195, whose header already says "OpenViking merge_ops, as DATA"), `operation_mode` (`add_only` | `upsert`), `directory` (each type = a directory under `viking://user/<ns>/memories/`), `filename_template`, `embedding_template`, `stage` (`agent` | user), `agent_only`, `enabled`.
- `experiences`' Situation/Approach/Reflect contract is ALREADY ported (schema v2, PR #1839: `type: "experience"` + structured `experience:` payload).
- kcard frontmatter `type` today: `lever | avoid | pattern | gotcha | metric | false_positive | experience` (types.ts:12) — a loose string; `retrieve.ts:861` falls back `c.type || "pattern"`. Typed entities (`entities: [{type,name}]`) + `relations:` block already exist. Vault: 1925 cards, 4-layer agg hierarchy; folders are organizational, not typed.
- `RetrieveOptions` (core-interface) has `tags`/`folder`/`queryText`/`semantic` but NO type filter; `knowledge_query` takes `tier` — the deterministic-filter precedent.
- D9 index: single `card` table with a `kind` column + `is_leaf`.

**D15 — types are card frontmatter `type` values (one discriminator), NOT vault folders and NOT tags.** The index `card.kind` column mirrors frontmatter `type` 1:1 (build-time mapping, documented once here; no md churn across 1925 cards). OpenViking's type=directory coupling is an artifact of its FS-native store; kcard's vault already has a typed hierarchy (agg nodes) a folder split would fight. Ticket 05's FS read surface exposes VIRTUAL type directories (`ls …/experiences` → filter `type=experience`) over the flat frontmatter discriminator — physical layout untouched.

**D16 — type mapping: 4 ported, 1 renamed-in, 3 out of scope.**
- Already here: `experience` (#1839); `entities` (entity-summary + typed `entities:` frontmatter — the per-entity CARD is `entity-summary`'s output, not a new type).
- Port: `event` (atomic real-world occurrence, `add_only`, date-normalized — the hermes-journal extraction loop of ticket 06 is its writer), `case` (multi-step troubleshooting case, `upsert`), `preference` (user preference record, `upsert`).
- Deferred: `trajectory` (`stage: agent`, `agent_only`, add_only op-contract) — its consumer is agent self-training, not this stack's retrieval; revisit only if ticket 06's extraction wants it.
- OUT (per D1): `identity` / `profile` / `soul` — single-file upsert types at the memories root of a SaaS multi-tenant user model; this stack's user model lives in agent memory + CLAUDE.md, not the knowledge vault. `skills`/`tools` stay disabled upstream and out here.
- The existing 7 kcard values stay untouched (additive union: `lever|avoid|pattern|gotcha|metric|false_positive|experience|event|case|preference`).

**D17 — registry = one typed TS const (`CARD_TYPES`) in kcard src, NOT a YAML/plugin layer.** Per type: `operationMode` (add_only → immutable canonical id path; upsert → MERGE_OPS path), required fields, per-type merge-op overrides, tier-ladder rendering hint (e.g. `event` renders date+summary at L0), ingestion stage tag. MERGE_OPS stays the shared by-field table; the const extends the pattern OpenViking itself uses (types as data), minus the YAML/custom-dir machinery — that exists for third-party extension, which a single version-controlled repo does not need. Typecheck + the D14 A/B gate police it.

**D18 — typed queries are a deterministic `type` filter parameter, mirroring `tier`.** `RetrieveOptions` gains `type?: string` (single value; the registry makes it an enum at the tool layer); the D9 `kind` column is the index-side filter. No LLM intent analyzer (D5/D6 hold): the CALLER passes the type — a subagent choosing a filter value through the tool-call schema is an ordinary tool argument, not a pipeline stage. Default scope = leaf cards only (`is_leaf = true`); agg nodes are navigational and reached via the hierarchy, not type filters. Ticket 07 inherits this as its first-class filter; ticket 09's recall-audit extends with per-type slices.

The BUILD lands in the Phase B tickets: 05 (virtual type dirs over the filter), 06 (event writer), 07 (kind-column filter in hierarchical retrieval) — per D14 each with A/B vs the 17/20 baseline + independent reviewer.
