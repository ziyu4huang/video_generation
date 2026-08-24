# 03 — cli/sessions/discover.ts + cli/format.ts

Phase B · risk LOW-MED · gate: package gates + boot-smoke byte-identical · depends: none

## Receipt (2026-08-24)

Implemented on branch `s2-agent-simplify-t03-discover-format`. Net −167/+39.

- Walk equivalence proven empirically: real archive has all 4,730 .jsonl at depth 2; old 2-level walk vs shared recursive walk → identical list AND order.
- Env precedence unified: PI_SESSIONS_DIR (legacy alias, kept exactly) ?? resolveAgentDir(env)/sessions. Deltas (no-env users byte-identical): sessions cmd gains env honor; tools-metrics gains PI_SESSIONS_DIR-first; agent-trends gains PI_CODING_AGENT_DIR. --sessions-dir flag still overrides.
- printTable: independent reviewer re-verified byte-identity with 4,000 randomized adversarial cases vs BOTH old copies — zero deltas. boot-smoke baseline is a JSON-structure pin (never touches printTable); direct `tools-metrics --schema-cost --json` smoke exit 0, valid JSON, human table right-aligned.
- clipSnippet parameterized (radius 80 sessions / 120 memory) — character-for-character exact.
- Known LOW (reviewer, theoretical): loadSessionFiles cap now counts unreadable .jsonl against the 500 budget (old didn't) — not reproducible on the real archive; acceptable.
- Gates: tsc clean; bun test 1048 pass / 0 fail; e2e help-dispatch+misc+meta 33 pass. Reviewer verdict READY.

## Scope

`cli/sessions/discover.ts` (transcript discovery ×3 → 1; zero external importers verified 2026-08-24):

- `resolveSessionsDir()` — PI_SESSIONS_DIR legacy alias first, then PI_CODING_AGENT_DIR, then ~/.pi/agent/sessions (reconciles tools-metrics vs agent-trends vs sessions.ts behaviors; sessions.ts gains env support = flagged delta).
- `listSessionFiles(dir)` — the recursive jsonl walk (superset of agent-trends' 2-level walk).
- `loadSessionFiles()` — sessions.ts's loader on top of the above.
- Rewire cli/commands/{tools-metrics,agent-trends,sessions}.ts; delete the three local copies.

`cli/format.ts`:

- `printTable` (numeric right-align option) — replaces dispatch.ts:288-298 and tools-metrics.ts:291-312 copies.
- snippet-clip helper — sessions.ts:82-88 + memory.ts:57-64 identical radius-clip logic.

## Done-when

Package gates green; boot-smoke `tools-metrics --schema-cost --json` byte-identical to `baselines/` pin; grep shows one listSessionFiles / one printTable definition.
