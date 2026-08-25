**ID:** `ADR-archify-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# Code layouts outrank templates and cannot be shadowed

**Status:** accepted (effort `2026-08-22-archify-general-deck`, decision D3; locked 2026-08-23)

In archify the six code layouts — `title`, `section`, `bullets`, `split`, `diagram`,
`statement` — are pure `Slide → PlacedBlock[]` functions built into the package. A
`*.layout.json` template is data on a search path. We decided the code layouts **win the name
lookup unconditionally**: a template named after one is a **load error**, never an override.

## Context

The package guarantees the D3 byte-identity lock: a `diagram` slide's XML must match a
pre-composition capture exactly, so every manifest written before layouts existed builds
unchanged. A user may drop a template anywhere on the search path (`$ARCHIFY_TEMPLATES`, a
project's `templates/`, the packaged tier) — including, in principle, outside the repository
altogether. If a template could shadow `diagram`, a file the repo does not control could break
that byte-identity lock from outside, silently and irreversibly.

## Considered options

- **Code layouts outrank templates; a shadowed name is a load error** ✅ — the built-in set is
  the stable contract; the byte lock is untouchable from the search path.
- **Templates outrank code (allow shadowing)** — rejected. The D3 lock would live at the mercy
  of a search-path file; and a template redefining `diagram` could change shape semantics for a
  deck built months later.
- **Only `diagram` protected, everything else shadowable** — rejected. The six code layouts are
  the shared core; allowing a data file to silently redefine `split`'s geometry creates a second,
  unversioned definition of a built-in that no manifest signals it is using.

## Consequences

- Overriding a code layout's geometry means taking a **new name** (a template file). The cost of
  D3 is asymmetric by design: the byte lock is worth more than in-place override convenience.
- A template is discoverable and self-describing; an agent finds what it can use from
  `archify_deck_lint`'s catalog and never has to guess whether a name is the built-in or the
  data.
- The search-path precedence (code → `$ARCHIFY_TEMPLATES` → `<manifestDir>/templates/` →
  packaged tier) is part of the same contract and is documented in
  `skills/archify/authoring-templates.md`.
