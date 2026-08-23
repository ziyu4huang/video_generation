---
name: archify
description: Author typed-JSON-IR technical diagrams (architecture / workflow / sequence / data-flow / lifecycle), render them to self-contained validated HTML, and compose them into a meeting deck (.pptx + slide HTML) via a discoverable layout library. Use archify_validate before archify_render; archify_delta to review architecture changes; archify_deck_lint to ask what layouts exist and to check a deck without building it; archify_export_pptx to build a deck. Accept Mermaid input or repository evidence when asked. Loads deep IR-authoring guidance on demand from the vendored SKILL.md + schemas.
---

# Archify (condensed)

Author a typed-JSON-IR diagram, validate it, render it to a self-contained HTML artifact.

## Choose a type

- **architecture** — components + connections topology (services, data stores, boundaries).
- **workflow** — steps / branches / decisions (approval, CI/CD).
- **sequence** — temporal messages between actors (API call sequences, request lifecycles).
- **dataflow** — pipeline transforms (ETL/ELT, data lineage).
- **lifecycle** — states + transitions (state machines).

## IR skeleton (common to all types)

```json
{ "schema_version": 1, "diagram_type": "<type>",
  "meta": { "title": "...", "subtitle": "...", "output": "<file>.html" },
  "<type-specific arrays>": [ ... ] }
```

Shared vocabulary:
- `componentType` ∈ {frontend, backend, database, cloud, security, messagebus, external}
- `variant` ∈ {default, emphasis, security, dashed} — VISUAL emphasis (line style / weight)
- `role` ∈ {spec, verify} (components + connections) — DOMAIN side: `spec` derives the artifact, `verify` checks it. Role overlays the type palette (role wins the color, the type keeps its sigil) and composes with `variant` — a dashed verify crossbar is `role: "verify"` + `variant: "dashed"`. Never encode a side by mis-picking `componentType`.
- `id` = `^[a-zA-Z][a-zA-Z0-9_-]*$`

## Layout essentials

1. **Cardinal rule:** set semantic `type` + `variant` on components/connections — the renderer maps these to theme colors. **Never invent inline colors.**
2. **Placement:** lay components left→right along the primary request path; group related ones with `boundaries`. For a literal V (V-model: left arm derives downward to an apex, right arm verifies upward), declare `meta.archetype: { "kind": "v-model", "leftArm": [ids…], "rightArm": [ids…] }` and OMIT pos/size on arm components — the archetype pre-pass places them (explicit pos wins). Verify pairings are ordinary connections: `{ "route": "straight", "variant": "dashed", "role": "verify" }` from a right-arm node to its left-arm spec node.
3. **Two arrows, two meanings:** solid = derivation/flow; dashed = verification pairing (point it at the spec node). `meta.legend: "variants"` charts a line-sample legend when an IR mixes ≥2 connection variants (opt-in — pre-existing decks render byte-identical); `meta.legend: false` suppresses the whole auto legend.

## Minimal example (architecture)

Copy `examples/minimal.architecture.json` — 3 components, 2 connections, the whole
type's vocabulary in one small file — and edit it. Components need `pos` + `size`;
connections reference component `id`s via `from`/`to`.

## The loop

1. **`archify_validate`** the IR against its schema → fix any diagnostics.
2. **`archify_render`** the validated IR → HTML (default honors `meta.output`, else `<cwd>/<type>.html`).
3. For change review: **`archify_delta`** two architecture IR snapshots → before/delta/after HTML (architecture-only).

**Validate before render. Never deliver unvalidated IR.**

## Compose a deck

A deck manifest turns IRs *and prose* into a 16:9 `.pptx` of native editable shapes plus
browsable slide HTML. The layout set is **discoverable, never hardcoded here**: the six code
layouts plus any `*.layout.json` template on the search path (see `authoring-templates.md`).
Ask the catalog first — never guess a layout name.

> **Ask, then build:** `archify_deck_lint` with no arguments lists every layout (code +
> template) and every deck skeleton with its description and slots. Then `archify_export_pptx`
> builds the deck. Full deck-writing rules, the Markdown outline dialect, and the sample decks
> live in **`deck.md`**. How to write a new `*.layout.json` → **`authoring-templates.md`**.

## On-demand depth (read these LOCAL vendored paths when needed)

- Copy-adapt IR source (validated examples per diagram type + flagship deck) → `examples/ir-library/library.catalog.json` (listed by `archify_deck_lint`)
- Layout craft / design system / self-review / delivery gate → `vendored/SKILL.md` (§ Layout principles, § Architecture Mode).
- Per-mode deep vocabulary (workflow/sequence/dataflow/lifecycle) → `vendored/SKILL.md` (§ Renderer Modes + each mode's section).
- Mermaid input → `vendored/SKILL.md` (§ Mermaid as an Input Dialect); or convert mechanically with `bun run mermaid:convert <file.mmd> [--type workflow|architecture|dataflow]` — convert + validate in one call, unbounded syntax errors the line, style dropped.
- Map real code (repository evidence) → `vendored/SKILL.md` (§ Optional verified repository evidence).
- Full field vocabulary per type → `vendored/schemas/<type>.schema.json` + `vendored/schemas/common.schema.json`.

> Everything above is LOCAL to this package (`vendored/`). Never reference the upstream archify source.
