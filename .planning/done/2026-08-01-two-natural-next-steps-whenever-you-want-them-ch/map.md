> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-08-01-two-natural-next-steps-whenever-you-want-them-ch

> **Slug note:** auto-derived from the `/wayfind` invocation text. The real
> destination is the **response-language issue-audit** — a severity-ranked
> disposition map of the forced-response-language per-turn-injection mechanism.

## Destination

A **severity-ranked disposition map** of the forced-response-language
per-turn-injection mechanism (shipped in #979) — for each open candidate:
**cold-set severity** (impact-*if*-real) × **research reality** (is it actually
a problem in the current code?) → **disposition** (fix spec to one-PR granularity
/ mitigate / accept-as-wontfix). **Planning only — this map decides, it does not
build.** Ends when every open candidate has a disposition and the matrix is
written back to the patch's docs.

## Notes

- **Domain:**
  - `bun-apps/pi-agent/src/patches/force-response-language.ts` — the patch
    (`mapLanguageTag` / `resolveForcedBlock` pure core + the
    `wrapInstallAgentNextTurnRefresh` per-turn prototype wrap).
  - `bun-apps/pi-agent/src/patches/force-response-language.test.ts` — 24 green
    unit tests (pure core + mechanism on stubs).
  - `bun-apps/pi-agent/src/patches/index.ts` — `PATCH_TABLE` +
    `resolvePatchPlan` (env-gating).
  - `bun-apps/pi-agent-ext-response-language/src/{command,settings}.ts` — the
    `/response-language` command (writes settings.json; no `ctx.reload()` since #979).
- **Skills every session should consult:** `grilling` + `domain-modeling`
  (HITL disposition tickets), `systematic-debugging` (research tickets tracing
  the SDK pipeline in `agent-session.js`), `test-driven-development` (ticket 06
  integration test).
- **Standing preferences:** conversation in 繁體中文; all written artifacts in
  English; project decisions live here in `.planning/` (wayfinder), not the
  `memory` tool.
- **Fact freshness:** charted at `origin/main` (0 behind). Both referenced
  features shipped: #979 (per-turn injection — replaced the heavyweight
  `ctx.reload()`) and `6867e6ef` (await_pr_merge live-progress). The
  `wrapInstallAgentNextTurnRefresh` "8/9 todo" is a **phantom** — its 24 unit
  tests are green; there is no live loose end from #979.
- **Cold-set discipline (mirror 2026-07-26 tool-gate map):** the severity-rank
  (ticket 00) is set BEFORE the research tickets (01–05) land, so impact isn't
  rationalized to whatever the research finds. Severity = impact-IF-real;
  research = IS-it-real; disposition combines both.

## Decisions so far

<!-- index — one line per closed ticket -->

<!-- none yet -->

## Not yet specified

<!-- the dispositions graduate from research as reality lands -->

- The **dispositions** themselves (fix/mitigate/accept per candidate) — they
  graduate from tickets 01–05 as each research pass confirms real-vs-already-closed.
- **Per-type fix tickets** graduate if ticket 02 (session-reach) finds a session
  type that bypasses the wrap.
- **Escalation signal:** if ticket 06 (integration test) shows the block does NOT
  reach even the main session, the whole mechanism is suspect → re-pin severity
  (P0) and re-open the lighter-alternative effort's "reached by construction"
  assumption.

## Out of scope

<!-- ruled out of this effort; closed, never graduates -->

- **#1 BTW stale-cache leak** — mitigated by #979 (the patch re-reads
  `settings.json` fresh every turn; no cached prompt). Closed.
- **#5 Invalid / garbage `responseLanguage` handling** — already covered by the
  green unit suite: `resolveForcedBlock` no-ops on non-string / blank / missing;
  `mapLanguageTag` handles unknown tags (literal reference) and empty (undefined);
  `readUserSettings` catches JSON-parse errors → undefined. No ticket; nothing to
  decide.
- **Upstream changes to the SDK's `_installAgentNextTurnRefresh` / pipeline
  shape** — out of scope unless a research ticket proves the current shape is
  fragile against it.
