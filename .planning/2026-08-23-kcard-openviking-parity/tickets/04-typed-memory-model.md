# 04 — typed memory model

type: grilling
blocked by: 02 (types land as schema fields/tables in the index)

## Question

OpenViking types memory as `profile, preferences, entities, events, identity, soul, cases, trajectories, experiences` under a schema registry for custom types. Map this onto kcard — questions to settle:

- Do OpenViking types become kcard **card kinds** (schema v2 already has `kind:` incl. `experience`), vault **folders**, frontmatter **tags**, or a mix?
- Which types matter for this user's vault? `entities`/`events`/`cases`/`experiences` look near-existing (entity-summary, extractor relations, experience kind); `identity`/`soul` look SaaS-user-profile-shaped and possibly out of scope.
- Schema registry: is kcard's existing frontmatter schema extensible enough (schema v2 MERGE_OPS) or does typing need a registry layer like OpenViking's `memory_type_registry`?
- How do typed queries interact with retrieval when D5/D6 forbid an LLM intent analyzer — is the type a filter parameter the caller passes (deterministic), mirroring how `knowledge_query` takes `tier` today?
