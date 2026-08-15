# Spec — power-tool re-architecture

## Problem

`pi-agent-ext-power-tool` grew one tool at a time across five efforts and nobody ever
looked at the whole. The result: one measurement duplicated four ways, one gating
object copied six times, one render vocabulary hand-built five times, a tool count that
five files each got wrong, a declared-but-unimplemented parameter, and an SDK shim that
depends on a tool module.

## Target module shape

```
src/
  gating.ts        DIAGNOSTIC_GATING — the one gating object for all inspect_* tools
  cost.ts          toolApiCost() — the one tool-schema measurement, over schema-cost/
  report.ts        header/summary/severity-section render helpers + token formatting
  findings.ts      Finding / Severity / summarizeFindings / shortPath   (unchanged)
  runner-hooks.ts  collectHooks / wrapHookHandlers / KNOWN_EVENTS — runner-shape adapters
  sdk-patch.ts     imports runner-hooks.ts  (was: imports tools/inspect-hooks.ts)
  tools/*.ts       thin: derive input -> analyze -> render
  schema-cost/     the estimator, now single-sourced          (unchanged)
  pathology/       failure-pathology diagnostics              (unchanged)
```

Dependency direction is strictly one-way: `tools/` -> `{cost, report, gating,
findings}` -> `schema-cost/`; `sdk-patch` -> `runner-hooks` (never into `tools/`).

## Invariants

1. **One estimator.** No file outside `schema-cost/` and `cost.ts` may compute
   `description.length + JSON.stringify(parameters).length`.
2. **One gating object.** No `gating: { keywords: [...] }` literal in a tool module.
3. **Docs state only what cannot drift.** No tool list, tool count, or per-tool
   description in PRD.md / CONTEXT.md / package.json / cli-subcommand prose.
4. **One registration entry**, `extensions/power-tool.ts`, in both
   `static-extensions.ts` and `package.json` `pi.extensions`.
5. `bun test` stays green with no test weakened.

## Non-goals

- Changing what any tool reports. This is a shape change, not a behavior change —
  except where the old behavior was a defect (`self_test` on `inspect_extensions`,
  the CLI allowlist missing two tools).
