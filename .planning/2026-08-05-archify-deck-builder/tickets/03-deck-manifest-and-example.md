---
type: prototype
blocked by:
  - "02"
claimed: pi-agent (example)
status: closed
resolved: 2026-08-05
---

## Question

Author the **deck-manifest JSON schema** and the **canonical 5-slide SAS/MAS example manifest** — a cheap, concrete artifact to react to (the fixture later tickets build and test against).

Produce:
- The schema: `{ output, theme?, defaults?: { font }, slides: [{ ir, title, subtitle }] }` and the CLI shape `bun run deck [manifest]` (default `deck.config.json`), with `--theme` / `--output` overrides.
- The example `deck.config.json` pointing at the 5 IRs (paths, titles, subtitles from the redesigned deck).

Per ticket 02 (resolved): **densify** the 5 IRs — real item IDs (e.g. `APU.SYS3.IF`), denser annotation cards, sub-paths — while **preserving the approved 5-slide structure**; default style `signal-flow` + light. Link the manifest file as an asset in the resolution; the answer records the finalized schema + example path.

## Resolution (2026-08-05)

- **Schema:** finalized + implemented as the `Manifest` interface in `scripts/deck.ts` (`{ output, theme?, tag?, defaults?{font,scale}, slides:[{ir,title,subtitle?}] }`); CLI `bun run deck [manifest] [--theme] [--output]`. No separate schema file — the code IS the schema (locked by `__tests__/deck.test.ts`).
- **Example:** `bun-apps/pi-agent-ext-archify/examples/deck/` — `deck.config.json` (signal-flow via IR `meta.visual_preset`, light, scale 3, PingFang TC) + `ir/slide{1-5}.json`.
- **Densified** per ticket 02: each slide gained a 3rd annotation card with real coded item IDs (`APU.SYS3.IF`, `MRD.SYS.1`, `ISP.SYS3.BW`, `MAS.HWE2.*` …) + a worked example. Diagram geometry/nodes/flows unchanged (only `cards` enriched) — structure preserved.
- **Build:** `bun run deck examples/deck/deck.config.json` → valid 688 KB / 5-slide `.pptx` (each IR validated via `deliver`); generated `.pptx` gitignored. User's study deck refreshed at `study-news/content/sas-mas-itemize-incose-aspice.pptx`.
- Committed + pushed (PR #1037, 3rd commit).
