---
name: archify
description: Author typed-JSON-IR technical diagrams (architecture / workflow / sequence / data-flow / lifecycle), render them to self-contained validated HTML, and compose them into a meeting deck (.pptx + slide HTML) with six slide layouts. Use archify_validate before archify_render; archify_delta to review architecture changes; archify_export_pptx to build a deck. Accept Mermaid input or repository evidence when asked. Loads deep IR-authoring guidance on demand from the vendored SKILL.md + schemas.
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

See the worked architecture IR (3 components, 2 connections) — copy + edit it. Components need `pos` + `size`; connections reference component `id`s via `from`/`to`.

## The loop

1. **`archify_validate`** the IR against its schema → fix any diagnostics.
2. **`archify_render`** the validated IR → HTML (default honors `meta.output`, else `<cwd>/<type>.html`).
3. For change review: **`archify_delta`** two architecture IR snapshots → before/delta/after HTML (architecture-only).

**Validate before render. Never deliver unvalidated IR.**

## Compose a deck (`archify_export_pptx`)

A deck manifest turns IRs *and prose* into a 16:9 `.pptx` of native editable shapes plus
browsable slide HTML. Six layouts:

| `layout` | use it for | key fields |
|---|---|---|
| `title` | cover | `eyebrow`, `subtitle`, `date` |
| `section` | chapter divider | `sectionNumber` |
| `bullets` | one idea, ≤6 points, ≤2 levels | `bullets`, `takeaway` |
| `split` | diagram + its points, **60/40** | `ir`, `bullets`, `ratio` |
| `diagram` | full-width diagram | `ir` |
| `statement` | one large claim | `statement`, `attribution` |

```json
{ "output": "deck.pptx", "theme": "light", "tag": "…", "defaults": { "font": "PingFang TC" },
  "slides": [
    { "layout": "title", "title": "…", "subtitle": "…", "date": "…" },
    { "layout": "split", "title": "…", "takeaway": "…", "source": "…",
      "ir": "flow.dataflow.json", "bullets": ["…", { "text": "…", "level": 1 }] }
  ] }
```

### Output layout — one deliverable = one folder

Keep every artifact of one deck inside a single named project folder: the
`deck.config.json`, the IR `.json` files, the exported `.pptx`, its `*.slides/`
HTML, and every rendered diagram HTML. Concretely: put `deck.config.json` in the
project folder and leave manifest-relative paths (`"output": "deck.pptx"`,
`"ir": "ir/flow.json"`) alone — do NOT pass an absolute `outputPath` that points
outside it. The export tool warns (advisory) when the output leaves the manifest
folder; treat that warning as a defect to fix, not a note to ignore.

### Writing rules (these are checked, advisorily)

1. **`title` is an ACTION TITLE** — the takeaway as a complete claim ("Cold-path latency is
   what users feel"), never a topic label ("Latency"). Read in order, the titles must BE the
   argument; that is what the reviewer checks first.
2. **One idea per slide.** More than 6 bullets, or nesting past level 1, means two slides.
3. **`takeaway` is the "so what"**, `source` is the attribution. An exhibit without either is
   hard to defend in the room.
4. **Never write a colour into copy.** Same Cardinal Rule as the IR: semantic role in, theme
   colour out.
5. `split` defaults to 60/40, not 50/50. Leave `ratio` alone unless the diagram demands it.

A slide with `ir` and no `layout` is a `diagram` slide — old manifests need no edit.

## On-demand depth (read these LOCAL vendored paths when needed)

- Layout craft / design system / self-review / delivery gate → `vendored/SKILL.md` (§ Layout principles, § Architecture Mode).
- Per-mode deep vocabulary (workflow/sequence/dataflow/lifecycle) → `vendored/SKILL.md` (§ Renderer Modes + each mode's section).
- Mermaid input → `vendored/SKILL.md` (§ Mermaid as an Input Dialect).
- Map real code (repository evidence) → `vendored/SKILL.md` (§ Optional verified repository evidence).
- Full field vocabulary per type → `vendored/schemas/<type>.schema.json` + `vendored/schemas/common.schema.json`.

> Everything above is LOCAL to this package (`vendored/`). Never reference the upstream archify source.
