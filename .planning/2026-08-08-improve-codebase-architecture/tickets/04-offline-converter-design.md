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
