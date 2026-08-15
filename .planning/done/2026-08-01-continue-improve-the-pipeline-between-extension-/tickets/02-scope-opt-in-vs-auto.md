# 02 — Scope: opt-in vs auto-converge

## Question

Should EVERY file2md conversion become a knowledge card, or only opt-in ones?

## Resolution

**Closed during the charting grill (2026-08-01).**

**Opt-in per conversion** — a `knowledge` flag (default `false`) on the file2md tool marks a
conversion for convergence. Protects the curated graph: a throwaway scan / receipt / meme
never enters it.

Rejected alternatives:
- **Auto-converge all (opt-out)** — graph-pollution risk; file2md content is heterogeneous
  (any PDF/image) unlike hermes' curated knowledge entries, and "everything queryable" isn't
  worth polluting the shared graph.
- **Auto into a separate folder** (`Zettelkasten/file2md/`) — breaks the PRD invariant that
  all WRITE paths land in the SAME folder (`Zettelkasten/knowledge-graph/`) so cross-source
  `[[edges]]` form; isolated cards wouldn't link to hermes/workflow cards.

hermes stays auto-on (opt-out via `OB_HERMES_AUTOCONVERGE`); file2md is opt-in.
