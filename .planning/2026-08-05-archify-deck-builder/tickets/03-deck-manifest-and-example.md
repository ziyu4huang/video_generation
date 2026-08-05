---
type: prototype
blocked by:
  - "02"
claimed:
---

## Question

Author the **deck-manifest JSON schema** and the **canonical 5-slide SAS/MAS example manifest** — a cheap, concrete artifact to react to (the fixture later tickets build and test against).

Produce:
- The schema: `{ output, theme?, defaults?: { font }, slides: [{ ir, title, subtitle }] }` and the CLI shape `bun run deck [manifest]` (default `deck.config.json`), with `--theme` / `--output` overrides.
- The example `deck.config.json` pointing at the 5 IRs (paths, titles, subtitles from the redesigned deck).

Per ticket 02 (resolved): **densify** the 5 IRs — real item IDs (e.g. `APU.SYS3.IF`), denser annotation cards, sub-paths — while **preserving the approved 5-slide structure**; default style `signal-flow` + light. Link the manifest file as an asset in the resolution; the answer records the finalized schema + example path.
