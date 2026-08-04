type: task
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

`bun test` failure (side-effect of ticket 07's wiring): capturing 3 more heavy tools raised real savings 8,738→9,791 tok/req, which is >20% above the README's pinned `CLAIMED_SAVED_TOK`/`~8,050` claim → the `savings-prose-lock` prose-drift guard trips (`intendedPass` within-drift-band fails). This is the prose-lock working as designed — it exists to force a *deliberate* sanctioned-claim update.

Update the sanctioned savings claim to the new measured value (~9,791, or ~9,800 rounded to match the `~8,050` style) across ALL pinned locations: README `~8,050` mentions + `CLAIMED_SAVED_TOK` + `SANCTIONED_PROSE_TOK` + the `savings-prose-lock.test.ts` that pins `~8,050` literally. This is a deliberate author act (value + prose coherence), not a mechanical fix — confirm the target value before applying.

## Resolution

**Closed (2026-08-04).** Raised the canonical gross claim so real measured savings (9,791 tok/req, 52.1%) pass the ±20% drift band. Target value chosen: **`CLAIMED_SAVED_TOK = 9800`** (prose `~9,800`; 9,791 deviates only −9, far inside the ±1,960 band). Derived net claim = 9800 − 243 = **9,557** → prose `~9,600` (round-to-100); gross pct `~45%` → `~52%`.

`SANCTIONED_PROSE_TOK` is *computed* (not hand-pinned) from `CLAIMED_SAVED_TOK` + `CLAIMED_NET_TOK`, so it auto-recomputed to `{9800, 9600, 18000, 10000}` — only the prose + `CLAIMED_SAVED_TOK` needed author edits; every `~N,NNN` literal in the 4 prose surfaces was then re-sanctioned.

Every location updated (old → new):

- `qa/savings.ts` — `CLAIMED_SAVED_TOK = 8050` → `9800`; header-question + claim-doc comments `~8,050` → `~9,800`; `CLAIMED_NET_TOK` trailing comment `7,807` → `9,557`; net-prose comment `~7,800` → `~9,600`; `SANCTIONED_PROSE_TOK` inline comments `~8,050 gross`/`~7,800 net` → `~9,800 gross`/`~9,600 net`; `DRIFT_BAND` rationale numbers refreshed (zai share `≈14%` → `≈11%`, with-zai measured `9,208` → `10,891`, upper edge `9,660` → `11,760`, headroom `~5%` → `~7%`).
- `qa/savings.test.ts` — band comment `±20% of 8,050 = ±1,610` → `±20% of 9,800 = ±1,960`; measured-gross fixture `withinDriftBand(8108)` → `withinDriftBand(9791)` (the stale-value + edges tests all re-derive from `CLAIMED_SAVED_TOK`, so only comments/fixtures changed).
- `qa/savings-prose-lock.test.ts` — removal-guard assertion `expect(readme).toContain("~8,050")` → `"~9,800"`; its comment `~8,050 claim` → `~9,800 claim`.
- `README.md` — banner `~8,050 / ~45%` → `~9,800 / ~52%`; gated line `~8,050 tok/turn gross, ~45%; net ~7,800` → `~9,800 gross, ~52%; net ~9,600`; ASCII banner `saves ~8050 tok/req` → `saves ~9800 tok/req`; QA section `"~8,050 tok/req saved"` → `"~9,800 tok/req saved"`.
- `CONTEXT.md` — `(~45%; gross ~8,050 saved)` → `(~52%; gross ~9,800 saved)`.
- `extensions/tool-gate.ts` — header `(saves ~8,050 tok/turn, ~45%; net ~7,800;` → `(saves ~9,800 tok/turn, ~52%; net ~9,600;`.
- `PRD.md` — net-effect line `(~45% saved; gross ~8,050, net ~7,800` → `(~52% saved; gross ~9,800, net ~9,600`; ASCII diagram `saves ~8,050 tok/req` → `saves ~9,800 tok/req`.

Left intact (intentional): the historical drift-incident narrative `(~7,900 / ~7,940 / ~8,050)` in `qa/savings.ts` and `qa/savings-prose-lock.test.ts` — those three values are the past-incident's interlocked stale numbers, not the current claim.

Drift-band confirmation: `bun run qa:savings` → `vs ~9,800: -9  (±20% band = ±1,960; within ✓)`; net 9,548 vs `CLAIMED_NET_TOK` 9,557 (within ±1,911). `bun test qa/savings.test.ts qa/savings-prose-lock.test.ts` → 12 pass / 0 fail.
