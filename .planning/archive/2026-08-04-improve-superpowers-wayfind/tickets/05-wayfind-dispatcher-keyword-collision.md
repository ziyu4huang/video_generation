---
type: grilling
status: closed
decision: "Option 1 (chosen 2026-08-05 grilling): introduce a `--` separator that forces charting — `/wayfind -- <destination>` always charts (even when the destination starts with a reserved keyword), while bare `/wayfind sync` and `/wayfind sync <effort>` keep working unchanged (keyword wins by default). Backward-compatible, conventional (-- is the /grill done --seed-plan precedent in the same family), no capability loss. Rejected: Option 2 chart-wins-by-default (drops /wayfind <keyword> <effort>) and Option 3 existence-heuristic (breaks seed, which creates efforts, and status-of-a-new effort)."
resolution: "Decision (Option 1) implemented + merged via PR #1039 (mergeCommit e81d9ddf) -- '/wayfind -- <destination>' now force-charts, escaping reserved keywords; bare /wayfind sync and /wayfind sync <effort> keep working (keyword wins by default); +3 dispatcher collision tests; README + procedures/wayfinder.md document the -- escape; suite 263->266"
---
# /wayfind dispatcher misroutes keyword-prefixed free-text destinations

## Question

`/wayfind` (`src/commands.ts`) routes on the first whitespace token against `WAYFIND_KEYWORDS` (`status`/`spec`/`tickets`/`seed`/`sync`/`done`/`validate`), passing the rest as the *effort*. So `/wayfind sync the database` → `handleChainSync("the database")`; `/wayfind validate the new design` → validate effort `"the new design"`; `/wayfind seed vault integration` → seed with effort `"vault integration"`. Destinations are free-text by design, so plausible efforts are silently treated as subcommands → confusing `no map at .planning/the database/` instead of charting. A genuine fork — grill the disambiguation design:

- require keywords unambiguous (sole-token for the no-arg subcommands; e.g. `/wayfind status` charts nothing, `/wayfind status <effort>` only when exactly 2 tokens); or
- introduce a `--` / `@effort` separator.

Then implement + add dispatcher collision tests (`/wayfind sync the database` charts, not syncs).
