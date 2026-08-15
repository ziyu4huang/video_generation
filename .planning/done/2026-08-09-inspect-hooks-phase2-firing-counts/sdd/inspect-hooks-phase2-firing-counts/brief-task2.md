# Task 2 — `never-fired` finding + report rendering

See ../../spec.md + ../../plan.md. Depends on Task 1's `fired` field existing in HookRegistration. Pure additive.

## commitScope
- bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts (analyzeHooks: never-fired finding; formatHooksReport: fires column + never-fired section)
- bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts (never-fired + report pure-fn tests)
- .planning/<effort>/sdd/<plan>/report-task2.md (report ONLY)

## Steps
1. analyzeHooks: after existing findings, for each hook entry with `fired === 0`, push `{ severity:"low", check:"never-fired", message: \`\${shortPath(path)} handler on "\${event}" never fired (0/\${count})\`, detail:{path,event,count,fired:0} }`.
2. formatHooksReport: add a "fires" column to inventory tables (by-extension + by-event); add a low-severity never-fired section.
3. TDD: pure-fn tests on analyzeHooks (snapshot mixing fired>0 / fired===0) + formatHooksReport substring asserts.

## Acceptance
- never-fired ONLY for fired===0; report shows fires + never-fired section; all existing+Task1 tests green; package typecheck+test green; additive.
- Return SDD status (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED).
