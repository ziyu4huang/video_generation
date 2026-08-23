# Archify — Real-Result Structural Evaluation (Design)

- **Date:** 2026-07-25
- **Scope:** `bun-apps/pi-agent-ext-archify/`
- **Status:** Approved (design)
- **Context:** The integration-layer e2e (#794) verified *plumbing* — that
  `execute()` runs and an HTML file appears. It did **not** evaluate the
  *quality of the generated artifact*. A real-result probe (rendering
  `production-deployment.architecture.json` and inspecting the output) exposed
  a false-confidence gap: the spec promised "no external/network refs" but the
  rendered HTML references Google Fonts + an external archify URL. This design
  adds an automated, CI-able evaluation of generated-HTML structural fidelity.

## Goal

Generate real HTML artifacts for every diagram type and assert their
**structural correctness**: IR→HTML round-trip integrity, functional
self-containment, non-triviality, and passage of the vendored tool's own
`archify check`. Deterministic, gated, regression-gating.

## Non-goals

- No visual/VLM fidelity review (settled: automated structural only).
- No edits to `vendored/` — external refs are baked into
  `vendored/assets/template.html`; the vendored snapshot policy forbids
  patching them. The eval *documents* this; it does not fix it.
- No edits to `lib/render.ts` — this layer measures output, it does not change
  rendering.
- No deep per-type IR round-trip beyond `architecture` (v1; other types use
  uniform assertions).

## File layout

- **New:** `lib/inspect-artifact.ts` — pure HTML→facts parser (string/regex,
  no DOM/browser). Unit-tested.
- **New:** `__tests__/inspect-artifact.test.ts` — unit tests for the parser.
- **New:** `__tests__/real-result.test.ts` — gated `PI_AGENT_E2E=1`; renders
  real HTML per type via `archifyRender`, inspects, asserts, runs
  `archify check`.
- **New:** `receipts/archify-real-result-eval-2026-07-25.md` — per-type facts
  + verdict (written from the gated run).
- **Existing reused:** `lib/render.ts` (`archifyRender`), `lib/run.ts`
  (`runArchify`), `vendored/examples/*.json`.

## Component: `inspectArtifact(html: string): ArtifactFacts`

Pure function. Input: the generated HTML string. Output:

```ts
interface ExternalRef {
  kind: "script" | "stylesheet" | "preconnect" | "image" | "anchor";
  url: string;
  blocking: boolean; // true = absence breaks offline rendering
}
interface ArtifactFacts {
  bytes: number;
  hasDoctype: boolean;
  hasSvg: boolean;
  svgViewBox?: string;
  title?: string;            // <title>
  generator?: string;        // <meta name="generator"> e.g. "archify 2.12.0"
  nodeKinds: string[];       // distinct data-kind values on SVG groups
  nodeCount: number;         // count of groups carrying data-kind
  textLabels: string[];      // <text> contents, trimmed + de-duped
  inlineScripts: number;     // <script> without src
  externalScripts: number;   // <script src=...>
  externalRefs: ExternalRef[];
  requiredExternalRefs: ExternalRef[]; // externalRefs.filter(r => r.blocking)
}
```

## Self-containment classification rules

`blocking` (required — absence breaks offline rendering):
- External `<script src="...">` → required.
- External `<img src="...">` → required.
- Any external ref not on the optional allowlist → required.

Non-blocking allowlist (cosmetic/help; system-monospace fallback or nav link,
diagram renders fully offline without them):
- `fonts.googleapis.com`
- `fonts.gstatic.com`
- `tt-a1i.github.io/archify`

Net effect on current vendored output: `requiredExternalRefs === []` (passes),
while optional Google-Fonts + help-URL refs are recorded as non-blocking. A
future vendored version adding an external script/img would fail the
`requiredExternalRefs` assertion.

This corrects spec #794's over-claim: "no external/network refs" →
**"no *required* external refs; functionally offline-capable."**

## Test: `real-result.test.ts`

Gated `PI_AGENT_E2E=1` (`describe.skip` default). For each diagram type
(architecture/sequence/workflow/dataflow/lifecycle), render the matching
vendored example via `archifyRender({ ir, type }, { cwd: tempDir })`, read the
HTML, run `inspectArtifact`, and assert:

**Uniform (all 5 types):**
- `hasDoctype && hasSvg`
- `nodeCount > 0`
- `textLabels.length > 0`
- `title` is non-empty
- `bytes > 10_000`
- `requiredExternalRefs` is empty
- `runArchify(["check", htmlPath], cwd).status === 0`

**Architecture only (deep round-trip):**
- `nodeCount >= ir.components.length`
- every `component.label` appears in `textLabels`

A failing `archify check` or round-trip is a **finding** (recorded in the
receipt), not a reason to weaken assertions.

## Receipt

`receipts/archify-real-result-eval-2026-07-25.md`: a per-type table
(`type × { nodeCount, label sample, externalRefs classified, archify check,
bytes }`), a self-containment note documenting the optional Google-Fonts +
help-URL refs and offline-capable verdict, and an overall verdict.

## Gating & boundaries

- Gate: `PI_AGENT_E2E=1`; default `bun test` and CI skip the suite (CI stays
  green, no slowdown).
- The only new `lib/` code is `inspect-artifact.ts` (pure parser, no side
  effects). `lib/render.ts` and `vendored/` are untouched.
- Inspector is unit-tested independently of the gated render suite, so parsing
  correctness is verified even when the gate is off.
