# 02 — Report medium: Markdown+Mermaid under .planning/ + offline HTML converter

## Question

Matt-Pocock's step 2 presents candidates as a self-contained HTML report (Tailwind+Mermaid via CDN) written to the OS temp dir and auto-opened in a browser. This repo is TUI-centric, offline-first (`--offline` posture), and its pi skills are Markdown-native with `.planning/` committed. How should C present its candidates?

## Resolution (2026-08-08)

**Markdown + Mermaid under `.planning/` as the committed source-of-truth, PLUS a deterministic offline converter that renders it to a self-contained HTML file (Tailwind + Mermaid vendored/embedded locally, NO CDN, no network).** Best of both: idiomatic committed Markdown (greppable, renders on GitHub, benefits from the `.planning/` standing rule) + rich offline visual render on demand. The converter is a build sub-deliverable (likely a Bun script in the wayfind package) — see [04](04-offline-converter-design.md). Rejected: CDN HTML (fights `--offline`, browser-open idiom, transient); committed-HTML-as-source (unusual artifact class, harder to diff).

type: grilling
closed: 2026-08-08
blocked by: (none — independent of 01)
