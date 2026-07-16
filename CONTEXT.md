# CONTEXT — Video Generation Monorepo

Glossary of ubiquitous language for the whole monorepo. **Definitions only** —
no implementation details (file paths, config keys, or code). Terms are added as
they resolve in design sessions.

## Memory model (pi-ext-memory / hermes-memory)

The agent's durable memory is organised along **two orthogonal axes**. The four
storage *targets* are convenience aliases for cells of this grid.

### Kind
The type-of-knowledge axis. A memory entry is one of:
- **user-trait** — who the user is: identity, preferences, communication style, standing habits.
- **agent-note** — general facts the agent keeps: environment, tool behaviour, working notes.
- **lesson** — a learning with no durable-fact home: a pure avoid ('don't do X') or a stand-alone insight. Carries an experience-type *category* (`failure` / `correction` / `insight`). (A correction/insight that yields a durable fact is stored as that *fact* in its Kind-home with a topical label — not as a lesson.)

### Scope
The audience axis: **global** (applies everywhere, across all projects) or
**project** (scoped to one codebase).

### target
A storage location (the entry's *home*); an alias for one **Kind × Scope** cell:
- `user` = user-trait × global
- `memory` = agent-note × global
- `project` = agent-note × project
- `lesson` = lesson × global  *(formerly `failure`)*
- `lesson-project` = lesson × project

`user-trait × project` is intentionally empty: user-trait is always global (the
user is one person across repos; a project-scoped "personal preference" is really
a *convention* — `agent-note × project` labelled `preference`).

### category
A retrieval **label** on any memory entry (any Kind). It does **not** decide where an entry lives — the Kind × Scope home does. An entry carries **zero or more** category labels (multi-label). Six labels:
`failure` · `correction` · `insight` (experience-type, typical on *lesson*) · `preference` · `convention` · `tool-quirk` (topical, on any Kind).
