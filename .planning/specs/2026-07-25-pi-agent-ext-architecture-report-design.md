# pi-agent Extension Architecture HTML Report — Design

**Date:** 2026-07-25
**Branch (planned):** `archify/ext-architecture-report` (off `main`)
**Tool:** `pi-agent-ext-archify` vendored CLI (`archify@2.12.0`) — used as-is, no source changes.

## 1. Goal

Produce a self-contained HTML architecture report depicting all 21 pi-agent
extensions: their **registration topology** (static vs dynamic) and their
**runtime dependency / load-order relationships**. The report is rendered by
archify from an authored JSON IR — archify is an IR→HTML diagram renderer, not a
codebase scanner, so the IR is hand-authored from the known extension tree.

Secondary deliverable: the IR JSON itself, kept in-tree so future extension
growth can be diffed via `archify compare` (delta reports).

## 2. Why IR (not "template")

The JSON input is an **Intermediate Representation**: a typed, schema-validated,
declarative description of the diagram's *semantics* (nodes, edges, groups). The
archify renderer owns *how* to draw it (layout, theme, SVG paths). One IR can
render to multiple targets/presets, and two IR snapshots can be diffed. This
makes the IR the canonical, version-controllable artifact — not a fill-in
template.

## 3. Diagram type & view model

- `diagram_type: architecture`
- Primary grouping axis: **registration kind** (static vs dynamic), modeled as
  two top-level `boundaries` (lanes).
- Secondary navigation: `meta.views` — focus subgraphs the reader can switch
  between without changing the underlying IR.

## 4. IR content

### 4.1 Boundaries (two lanes)

| Lane | Meaning | Members (9–12) |
|------|---------|----------------|
| **Static — native import · in `--exe` binary** | Imported via `pi-agent/src/static-extensions.ts`; bundled into the single-exe build; present in every mode. | core-task, hermes-memory, superpowers, wayfind, web-access, obsidian, btw, file2md, subagent, workflow, knowledge-card, power-tool |
| **Dynamic — jiti `-e` · source/bundle only** | Loaded via manifest `-e <path>.ts`; **not** emitted as `-e` in `--exe` mode, so absent from the compiled binary. | tool-gate, flux2, krea2, ltx, research-tool, zai-mcp, movie-director, deploy, archify |

### 4.2 Components (21)

Each component:
- `label` — extension short name (folder minus `pi-agent-ext-`).
- `sublabel` — one-line role (from `package.json` description).
- `tag` — `bundleMode` when declared (`thin`), plus registration detail where
  noteworthy (e.g. `skills`, `binarySkills` membership).

### 4.3 Connections — verified by grep (primary work)

**Rule:** only runtime import / mandatory load-order edges become solid lines.
Edges are added ONLY after grepping the extension's `extensions/<X>.ts` and
`src/` for real imports of another extension's entry. Candidate set to confirm
or reject during implementation:

- `subagent → workflow` (declared "must load before workflow")
- `workflow → subagent`, `workflow → hermes-memory`
- `knowledge-card → hermes-memory` (graph-enhanced RAG)
- `research-tool → hermes-memory`, `research-tool → obsidian`
- `movie-director → flux2 / krea2 / ltx` (orchestrates native directors)
- `tool-gate → flux2 / krea2 / ltx / movie-director` (keyword-gated heavy tools)

**Meta / build-time relationship (NOT drawn as 9 edges):**
`deploy` builds every extension bundle, but this is not a runtime import.
Represent it as: deploy node `sublabel` notes "builds all extension bundles",
plus a single dashed edge from `deploy` to a conceptual `bundles` node (or
omit if it clutters). No per-extension dashed fan-out.

Provenance-only facts (btw extracted-from power-tool; subagent extracted-from
workflow) are captured in legend cards, not as edges.

### 4.4 Cards (legend)

- **Static vs Dynamic** — what each lane means, and *why* dynamic extensions
  cannot enter `--exe` (jiti `-e` flags are dropped in binary mode; pi does not
  dedup across native-import vs jiti-load paths).
- **bundleMode** — `thin` vs default.
- **Surfaces** — distinction between `extensions[]` (dynamic), `staticExtensions`
  (static), `skills[]`, and `binarySkills[]` (subset carried into the binary).

### 4.5 meta.views

1. `registration-topology` — full graph (default focus).
2. `memory-knowledge` — hermes-memory, knowledge-card, research-tool, obsidian.
3. `media-gen` — flux2, krea2, ltx, movie-director, tool-gate.
4. `agent-infra` — core-task, subagent, workflow, power-tool, btw, superpowers,
   wayfind.

## 5. Workflow

1. **Verify edges** — grep each extension entry for cross-extension imports;
   freeze the confirmed edge list.
2. **Author IR** — write `pi-agent-extensions.architecture.json`.
3. **Validate** — `archify validate architecture <ir> --json`.
4. **Render** — `archify deliver architecture <ir> <out.html> --json --quality showcase`.
5. **Check** — `archify check <out.html>`.
6. **Eyeball** — open the HTML, confirm lanes/views/edges render correctly.

## 6. File locations

- IR: `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.json`
- HTML: `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html`

Colocated with the archify extension so `archify compare` deltas stay
self-contained for future evolution.

## 7. Git / cleanup

- Current worktree `video_generation__archify` is stale (its work merged to
  `main` as #809). Retire it; branch new work off `main`.
- New branch: `archify/ext-architecture-report`.

## 8. Out of scope (YAGNI)

- No changes to archify itself (pure `deliver` usage).
- No multi-diagram composite report (single architecture diagram + views).
- No auto-IR-from-source (archify does not support it; hand-authored IR carries
  the static/dynamic semantics a scanner cannot infer).
- No per-extension dashed fan-out for `deploy` (kept as a sublabel note).

## 9. Acceptance criteria

- `archify validate` passes on the IR with zero errors.
- `archify deliver` produces a self-contained HTML; `archify check` passes.
- HTML correctly partitions 21 extensions into Static (12) / Dynamic (9) lanes.
- Every solid connection edge in the IR corresponds to a real, grep-verified
  cross-extension import or documented mandatory load order.
- At least the 4 `meta.views` are switchable in the rendered output.
