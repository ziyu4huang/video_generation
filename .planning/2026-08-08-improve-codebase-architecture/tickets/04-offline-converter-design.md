# 04 — Offline Markdown->HTML converter design (prototype)

## Question

The report medium is decided (02): Markdown+Mermaid under `.planning/` + a deterministic **offline** HTML converter (vendored Tailwind+Mermaid, no CDN). How exactly is that converter built? Open choices that shape the spec:

1. **Tailwind offline** — (a) pre-build a static Tailwind CSS with the classes the report uses, or (b) vendor the play-CDN JIT JS locally? (Static CSS is smaller + truly offline; play-CDN JS is closer to Matt-Pocock but heavier.)
2. **Mermaid offline** — inline `mermaid.min.js` (render diagrams client-side from code-fences) vs ESM bundle?
3. **Editorial visuals** — Matt-Pocock's hand-built SVG/div visuals (mass diagram, cross-section, call-graph collapse) don't map to Mermaid. Do they become (a) ASCII art in the Markdown (converted verbatim), (b) Mermaid approximations, or (c) a small fixed set of renderer-supported visual types?
4. **Converter shape** — a Bun script in `pi-agent-ext-wayfind`? CLI (`bun run architecture:render <report.md>`)? Where do vendored assets live?

## Plan

Raise fidelity with a cheap prototype: take the candidate-card Markdown structure, build a minimal converter that emits one self-contained offline HTML (static Tailwind CSS + inlined `mermaid.min.js` + the before/after as Mermaid), open it locally, react. Decide 1-4 from what the prototype shows.

type: prototype
blocked by: 02 (report medium decided)

## Resolution (2026-08-08)

**Resolved by prototype** (`.planning/2026-08-08-improve-codebase-architecture/brainstorm/`, commit bf122d1c). A minimal Bun converter was built + run on a realistic sample; it emits a self-contained offline HTML (no CDN) that opens in a browser. The 4 choices:

1. **Tailwind offline -> static CSS** (prototype hand-written; production = curated static Tailwind build, inlined). Play-CDN JIT rejected.
2. **Mermaid offline -> inlined vendored `mermaid.min.js`** (UMD global, `mermaid.initialize` startOnLoad).
3. **Editorial visuals -> Mermaid where graph-shaped, ASCII `<pre>` where editorial.**
4. **Converter shape -> Bun script, CLI `render <in.md> [out.html]`, default `$TMPDIR`, self-contained offline HTML.**

Production caveats (deferred to spec/SDD): real Markdown parser, real Tailwind build, mermaid vendored in the package, golden-HTML snapshot test, Playwright render-check. HTML is ~3.4 MiB (~99% inlined mermaid) — acceptable for a one-time render.

closed: 2026-08-08
