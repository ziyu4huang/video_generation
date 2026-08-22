# s2-agent-core-interface

The ubiquitous language of `@repo/s2-agent-core-interface` — the shared-contract
package that sits BELOW every s2-agent package. It owns the cross-package
`__pi*` seam registry, the knowledge-layer contract types + deterministic
primitives, and the tool-gate declaration surface. It is deliberately NOT a
types-only package: some agreements only stay structural if a shared VALUE
(a registry object, a normalize function) lives here rather than being mirrored
in each consumer.

## Language

### Seams

**Seam**:
A `globalThis` slot named `__pi*` through which two packages communicate at
runtime WITHOUT importing each other — one publishes (`publishSeam`), the other
reads (`readSeam`). The mechanism that keeps extension packages independently
removable while still cooperating.
_Avoid_: hook, event bus, plugin API (it is a typed two-endpoint handoff on one named slot, not a broadcast or lifecycle callback)

**SEAM_KEYS**:
The canonical seam-key registry — the single source of truth for every legal
`__pi*` literal, each with a `crossPackage` flag. Consumed by
`bun-apps/tests/seam-contract.test.ts` (no orphans, no self-only cross seams)
and by `SeamKey` for compile-time exhaustiveness.
_Avoid_: constants file, key list (it is the registry that makes an unregistered seam a CI failure, not a lookup table)

**crossPackage**:
The `SEAM_KEYS` flag meaning "the key LITERAL is duplicated verbatim in ≥2
packages" — i.e. there is a real drift surface for the registry to pin. `false`
means the literal is owned by one package (no duplicated text, nothing to pin).
_Avoid_: shared, public, exported (it describes where the literal is spelled, not who may call it)

**SeamImplMap**:
The key → implementation-type map, total over `SeamKey`. Migrating a seam from
`unknown` to its typed contract happens here, one key at a time.
_Avoid_: interface table, typings (it is the per-key typing ledger of an incremental migration)

### The knowledge layer

**KnowledgePipeline**:
The `__piKnowledgePipeline` seam contract — knowledge-card (zk) publishes,
hermes-memory consumes: collectInputFiles / ingestRecords / healGraph /
buildHierarchy / retrieveRecords, plus the optional `entityAugment` leaf.
_Avoid_: API, service, client (it is a one-publisher-one-consumer seam contract, not a general interface)

**Contract-subset promise**:
The pattern every contract type here follows: the CONTRACT type declares a
SUBSET of the implementer's richer fields, and the impl assigns structurally at
the `publishSeam` call site. Contracts under-promise; they never mirror the
impl field-for-field (mirroring is what made the old draft contracts drift).
_Avoid_: mirror, copy, 1:1 type (the subset relation is the load-bearing part)

**Tier rule**:
The knowledge-layer dependency invariant: TIER-0 foundations (obsidian,
hermes-memory) import NOTHING from the TIER-1 hub (knowledge-card) — edges
point DOWN only. Encoded in `bun-apps/tests/dep-guard.test.ts` (real import
statements + tsconfig `types` edges), so an inversion fails CI instead of
recurring.
_Avoid_: layering, dependency direction (it is the specific TIER-0/TIER-1 ban, not general hygiene)

**Hoisted leaf (L2)**:
A primitive that two packages on OPPOSITE sides of the tier boundary need to
agree on, placed here below both so both edges point down and the agreement is
structural — `entities.ts` (both sides must call the same `normEntity` or the
signal dies) and `embedding-leaf.ts` (the ONE embedder/cosine/fence-split).
Hoisting is a tier-boundary decision, never a convenience dedup.
_Avoid_: utils, shared helpers (it is where a cross-tier agreement lives, not a junk drawer)

**Entity primitives**:
The deterministic typed-entity extraction + IDF-weighted ranking core
(`extractEntities` / `normEntity` / `computeIdf` / `scoreOverlap`) — dictionary
based, no LLM at ingest, SAG's deterministic tier ported to developer-knowledge.
Shared BY VALUE across the boundary (see hoisted leaf).
_Avoid_: NER, tagging, metadata (it is typed-entity + IDF ranking with a shared normalizer, not label extraction)

**resolveSemanticEmbedConfig**:
The single resolution point for which embedding endpoint + model the knowledge
layer uses (canonical: LM Studio `text-embedding-bge-m3`; env overrides
`SEMANTIC_EMBED_BASE`/`SEMANTIC_EMBED_MODEL`, legacy `LMSTUDIO_BASE_URL` alias).
Never throws — blank env falls through to defaults.
_Avoid_: embed client, embedding settings (it is the one resolver, so there is no second place to disagree)

### Tool gating

**GATE_DEFS**:
The shared gate registry each owning extension populates at module load
(`{ id, keywords?, requires?, description }`, declared ONCE by id); tools
reference a family via `gating: { gate: "<id>" }`; tool-gate resolves it. The
single source of truth that replaced the old hardcoded `GATES` array.
_Avoid_: GATES, gate config, core-tools set (it is the id-referenced declaration surface tool-gate resolves at runtime)

**ToolGateStatus**:
The live-state shape tool-gate publishes on `__piToolGateStatus` and power-tool
renders — per-gate fired/dormant, keywords, token cost, sticky set. The seam's
type lives here so both ends import it without crossing packages.
_Avoid_: gate report, diagnostics payload (it is the live per-session state contract between exactly two packages)
