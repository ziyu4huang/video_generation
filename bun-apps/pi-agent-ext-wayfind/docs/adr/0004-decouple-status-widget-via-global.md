**ID:** `ADR-wayfind-0004` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0004: Decouple the status widget via the `globalThis` singleton (reverse ADR-0002 Decision 1)

Date: 2026-07-26
Status: accepted
Supersedes: [ADR-0002](./0002-shared-status-widget-and-command-consolidation.md) Decision 1 (only)

## Context

ADR-0002 made `pi-agent-ext-wayfind` take a `workspace:*` dependency on
`pi-agent-ext-task` to call `getSharedStatusWidget()` and register a
`StatusSection` (order 2) on the shared composite status widget. That was the
right call at the time: two external consumers (wayfind + planning-with-files)
were both writing the TUI footer and colliding, and command namespaces overlapped.

Two things changed:

1. **`planning-with-files` was removed (PR #620).** wayfind is now the *only*
   external section in the widget (goal=0, todo=1, wayfind=2, plan-coordinator=3).
2. **The coupling is asymmetric across the family.** `pi-agent-ext-superpowers`
   ships with zero dependencies and no runtime seam because it does no
   cross-extension coordination; wayfind carried the one `workspace:*` dep purely
   for status display. The asymmetry read as inconsistency, and the dep is
   heavier than the use warrants — a single import used in exactly one place
   (`src/index.ts`).

The jiti constraint that *forced* the `globalThis`-backed singleton in ADR-0002
still holds: pi loads extensions via jiti, and module identity across a
jiti-loaded extension and a native `import()` of the same package is not
guaranteed, so any cross-extension singleton MUST live on `globalThis` (a
module-level `let instance` silently breaks into disconnected instances). ADR-0002
already relied on this; the reversal does not weaken it.

## Decision

**Drop the `workspace:*` dependency. Read the shared widget via its
`globalThis` singleton instead of importing it.**

`src/index.ts` no longer imports `getSharedStatusWidget()`. Instead it reads
`globalThis.__piCoreTaskStatusWidget` through a local structural interface
(existence-checked, never `instanceof` — the same cross-loader discipline
ext-task's own singleton guard uses) and registers wayfind's section exactly as
before when the widget is present:

```ts
interface SharedStatusWidget {
  addSection(section: { id: string; order?: number; render(theme, width): string[] }): void;
  setUICtx(ctx): void;
  update(): void;
}
const widget = readSharedStatusWidget();   // globalThis.__piCoreTaskStatusWidget
if (widget) widget.addSection({ id: "wayfind", order: 2, render: ... });
```

**No fallback.** When ext-task's widget is not on the global, wayfind's status
section simply does not render — ADR-0002's accepted consequence, retained. This
is theoretical in practice: ext-task is the earliest-loaded core package (first
in `run-dir/manifest.json`) and creates the widget in its own factory body, so
the global is populated before wayfind's factory runs.

ADR-0002 **Decision 2** (command consolidation: `/grill [me|docs|done|domain]`,
`/wayfind [...]`) is **unaffected** — it stands on its own merits and stays.

## Consequences

- **Build-time coupling gone; runtime coupling loosened.** wayfind's
  `package.json` no longer lists ext-task. A residual *runtime* string+shape
  contract remains (the global key `__piCoreTaskStatusWidget` + the
  `{ addSection, setUICtx, update }` / `StatusSection` surface) — deliberately.
  This is the intended trade-off: decoupled at build time, loosely coordinated at
  runtime, unified widget UX preserved.
- **Contract-drift surface is small but real.** The global key + the section
  shape are ext-task's internal implementation detail, not a published API. If
  ext-task renames the key or reshapes `StatusSection`, wayfind's status stops
  rendering (silently, not crashing — the existence-check guards it). Acceptable:
  the shape is small, stable, and documented here + in `status-widget.ts`.
- **Tests unaffected.** `overlay.test.ts` exercises `WayfindOverlay` in
  isolation; `chain.test.ts` + `plan-seed-contract.test.ts` cover the
  grill→plan-seed handoff (a separate, older contract) via a relative-path import
  that does not go through the package dependency. All 177 tests pass.
- **The `__piWayfindActive` seam has since been removed.** That seam was the
  documented plan-coordinator handoff (ADR-wayfind-0003 territory), whose "yield"
  was never implemented — it was dead output (0 consumers) and was deleted
  (see ADR-0006). At the time of this decision it was untouched; reversing
  ADR-0002 did not affect it.
