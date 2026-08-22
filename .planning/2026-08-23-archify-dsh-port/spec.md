# archify-dsh-port spec

## Problem Statement

The repo already has a mature diagram + deck authoring capability (`bun-apps/s2-agent-ext-archify`),
but it only reaches an s2-agent session. A DeepSeek Harness agent has no way to author a
typed-JSON-IR technical diagram, render it to validated HTML, diff two architecture snapshots, or
export a native-shape PowerPoint deck — it must either re-implement the tooling or leave DSH for an
s2-agent session. DSH agents need those four tools with the same behaviour and the same "no browser
download, no rasterization" guarantees, wired into DSH's own tool registry.

## Solution

Ship a self-contained **DSH bundle** at `dsh-plugin/archify/` that registers the four archify tools on
`ctx.tools` for every agent in the profile. The engine is the existing archify source, unchanged
(`vendored/` snapshot + the deck `lib/*.ts`); the only new surface is the harness-facing adapter. All
CPU/rendering work — the diagram CLI *and* the deck builder — runs as a **Bun** subprocess, so the
Bun-only builtins the deck path needs (`HTMLRewriter`, `Bun.XML`, `Bun.file`/`Bun.write`,
`Bun.spawn`/`Bun.which`/`Bun.Glob`) execute on the real Bun runtime. The Node side is a thin
`ctx.tools.register` wrapper that spawns Bun and parses `--json` receipts; no archify logic runs in the
DSH Node process. (`ARCHIFY_RUNTIME=node` remains a documented escape hatch, since the vendored CLI is
verified Bun- and Node-compatible.)

## User Stories

1. As a DSH agent, I want to `archify_validate` a diagram IR so I can confirm it is schema-valid before rendering.
2. As a DSH agent, I want to `archify_render` a validated IR (inline JSON or a workspace file) to a self-contained HTML diagram so I can present it.
3. As a DSH agent, I want to `archify_delta` two architecture IR snapshots into a before/delta/after HTML so I can review a change.
4. As a DSH agent, I want to `archify_export_pptx` a manifest (or a list of IRs) into a native-shape 16:9 deck so I can hand a real editable deck to a stakeholder.
5. As a DSH agent, I want the tool inputs to resolve workspace-relative paths (`irPath`, `outputPath`, `basePath`, `headPath`) against the session workspace, not the DSH process cwd.
6. As a DSH agent, I want a model-facing render that is size-capped so a huge diagram never floods the context.
7. As an operator, I want the bundle installed with one `dsh plugin --profile <name> add` and auto-activated, so a profile restart exposes the tools with no manual composition.
8. As an operator, I want a build/install script (not a bash `build.sh`) that assembles the tarball and validates the patch layer, matching the repo's Bun-first stack.

## Implementation Decisions

- **SD1 — Runtime: Bun everywhere for archify work.** All four tools run their engine as a Bun
  subprocess. Runtime resolution is `ARCHIFY_RUNTIME` env override → `bun` on PATH → a clear error (never
  a silent fallback to another runtime). This matches the s2-agent `run.ts` ladder and the repo preference.
- **SD2 — Node adapter is thin and sits inside the DSH process.** The bundle's `index.js` (inject
  `['tools']`, then `ctx.tools.register` per tool) plus the tool wrappers are Node ESM evaluated by DSH;
  they use only `node:child_process` (spawn), `node:path`, `node:fs` (temp IR + output resolution), and
  the DSH tool `execute(args, exec)` whose `exec.agent.session.header.cwd` is the workspace root
  (sv-analyzer's convention). No archify logic runs in Node.
- **SD3 — Vendored CLI is the engine for the three core tools.** `archify_validate` / `archify_render` /
  `archify_delta` re-use the vendored `bin/archify.mjs` (`validate`/`deliver`/`compare`) via subprocess,
  passing `--json`, and parse the receipt. Inline `ir` JSON is written to a temp file first.
- **SD4 — Deck path reuses the s2-agent deck code under a Bun subprocess.** `archify_export_pptx` spawns a
  thin `deck-cli.ts` (Bun) that reads args-json on argv, calls `buildDeck` / `manifestFromIrPaths` from the
  copied deck `lib/*.ts`, and prints a JSON receipt. The deck lib must be the s2-agent code with two
  DSH adaptations: the `#pi/ext-dir` resolution in its `run.ts` replaced by a bundle-relative resolution,
  and the `webui` announce bus passed as a no-op.
- **SD5 — Tool schemas are raw JSON Schema, not the typebox DSL.** `parameters` and `output.schema` are
  plain JSON Schema for `ctx.tools.register` (sv-analyzer's comment: authoring DSL shapes here corrupts the
  model-facing schema). Keep the four tools' parameter shapes + render semantics identical to the s2-agent
  versions.
- **SD6 — Bundle layout mirrors sv-analyzer.** `plugin/` npm package declaring `dsh.bundle.patch`
  (`cordis.patch.yml`), `index.js` at `main`, `lib/` (Node adapter + Bun deck-cli + deck lib), `vendored/`,
  `examples/`, `test/`. The build/install is a Bun script (`scripts/build.ts`), not a bash `build.sh`.
- **SD7 — Ship `pptxgenjs` + `marked` as bundle deps** (the deck half's npm deps) so the Bun deck-cli can
  resolve them; `HTMLRewriter` / `Bun.XML` / `Bun.spawn` are Bun builtins, not deps.

## Testing Decisions

- **Plugin smoke (Node).** Register the four tools against a `ctx` stub, assert each schema, then run one
  real `validate` through the vendored CLI under Bun; assert a clean JSON receipt. Mirrors
  `sv-analyzer/test/plugin-smoke.mjs`.
- **Deck smoke (Bun).** Run `deck-cli.ts` on `examples/deck/`, assert a `.pptx` is written and contains
  zero `<a:blip>` (no rasterization) — the s2-agent `pptx-shapes` acceptance contract.
- **Seam: external behaviour, not internals.** Assert tool outputs (`details.path`, `details.type`, `valid`,
  the rendered receipt) rather than internal adapter wiring; test at the highest seam (the DSH tool
  boundary) where possible.
- **Patch validation.** `scripts/build.ts --check-patch <profile>` composes `cordis.patch.yml` against a
  dsh profile dump (no boot), like sv-analyzer's `--check-patch`.
- **Coverage gate** is a line-free smoke + e2e, sized to a single fresh context (not a full re-derivation of
  the s2-agent suite, which stays the upstream's responsibility).

## Out of Scope

- The three s2-agent archify **tests** and the deck unit suite — the s2-agent package remains the upstream
  and its suite already covers the engine.
- `webui:open` / `webui:deck` announce (no DSH webui; no-op bus).
- `thumbnails` (`Bun.WebView`/`Bun.Image`) and the `deck render` PNG preview (need a WebView / real
  renderer; off by default).
- Upstream re-sync (vendoring policy is D6 / re-copy; not part of this port).
- A full Node port of the deck half (rejected — Bun subprocess reuse, SD4).
- Any new diagram layout, type, or deck feature (the engine is already feature-complete for this port).

## Further Notes

- The bundle is self-contained in **Bun**, not Node; the only external runtime requirement is `bun` on the
  host (D5/SD1), which the repo already treats as canonical.
- Every tool must still honour `signal?.aborted` and report bin-missing vs IR-invalid distinctly (empty
  stdout = vendored bin missing; non-zero exit + receipt = surface diagnostics).
- This spec is the synthesis preamble to `tickets/`; the wayfind chain is map → spec → tickets → seed.
