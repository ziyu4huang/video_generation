# 03 — cli/sessions/discover.ts + cli/format.ts

Phase B · risk LOW-MED · gate: package gates + boot-smoke byte-identical · depends: none

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
