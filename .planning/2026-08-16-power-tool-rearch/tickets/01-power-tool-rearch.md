---
type: task
status: open
blocked by:
---
# 01 — power-tool simplification + re-architecture

Findings from the first architecture pass over `bun-apps/pi-agent-ext-power-tool`
(2026-08-16). Severity is impact-on-user, not size-of-diff.

## P1 · HIGH — `inspect_extensions` declares a `self_test` it never implements

`tools/inspect-extensions.ts` exposes `self_test` in its schema, but `execute()` has no
`params.self_test` branch (:417-483). The 47-line `SELF_TEST_ANALYSIS_INPUT` fixture
(:63) is dead — the only other repo reference is a comment. The other five tools all
honour `self_test`; this one falls through to live `getSystemPromptOptions()` and
throws off-session. Fix: implement the branch against the existing fixture.

## P2 · HIGH — two implementations of the same measurement, already drifted

`schema-cost/estimateToolCost()` is the canonical estimator, with four external
consumers (`pi-agent/src/cli/commands/schema-cost.ts`, `pi-agent-ext-tool-gate` x3).
The inspect_* tools never call it — they inline the formula four times
(`inspect-extensions.ts:172,246,276`, `inspect-context.ts:103`) and borrow only the
ratio constant through `format.ts`.

`format.ts:8-11` claims the two "can NEVER drift apart". Only the ratio is shared; the
formula is copied, and it already disagrees:

```
parameters: undefined  ->  inline:      JSON.stringify({}).length = 2
                           schema-cost: 0
```

Fix: `src/cost.ts` as the single tool-cost surface, delegating to `estimateToolCost`.

## P3 · MEDIUM — the gating object is copy-pasted six times

The same 8-line `gating: { keywords, requires }` literal appears verbatim in all six
tool modules, down to the `tui` / `工具` nouns. Fix: `src/gating.ts`.

## P4 · MEDIUM — five files disagree about how many tools exist

Actual: 6 (`inspect_context`, `inspect_agent`, `inspect_extensions`, `inspect_hooks`,
`inspect_tui`, `inspect_pathology`).

| Where | Claims |
|---|---|
| `extensions/cli-subcommand.ts` `POWER_TOOLS` | 4 |
| `package.json` description | 4 |
| `PRD.md` tools table | 5 |
| `CONTEXT.md` | 4 |
| `static-extensions.ts:87` comment | 4 + "…" |

`POWER_TOOLS` is not a doc — it is the CLI **allowlist**, so
`pi-agent cli power-tool` cannot reach `inspect_hooks` or `inspect_tui` at all. Fix:
derive the list from the registered tools; delete the enumerations from the prose.

## P5 · MEDIUM — `pi.extensions` points at a phantom entry

`package.json` has `"pi": { "extensions": ["./src/index.ts"] }`, which CLAUDE.md
explicitly forbids ("never `src/index.ts`"). Live registration goes through
`static-extensions.ts:67 -> extensions/power-tool.ts`. A package-based loader picking
up the `pi` field double-registers and skips `__GATE_PROBES__`. Same shape as wayfind
finding #1 in `REVIEW-2026-08-15-ext-four-packages.md`.

## P6 · MEDIUM — inverted layering in the SDK shim

`sdk-patch.ts:18` imports `tools/inspect-hooks.js`. The lowest-level runtime shim
depends on a tool module. `collectHooks` / `wrapHookHandlers` / `KNOWN_EVENTS` are
runner-shape adapters, not rendering. Fix: `src/runner-hooks.ts`.

## P7 · LOW — the report header box is hand-built five times

`╔═╗ / ║ Title ║ / ╚═╝` is re-typed in five modules with two different widths
(`inspect-tui` 37, the rest 38) and unaligned padding
(`║        Inspect Agent                ║`).

## P8 · LOW — two findings-report renderers and a redundant facade

`formatExtensionReport` and `formatHooksReport` each re-implement the summary line and
the severity sections. `tools/inspect-hooks.ts:18` re-exports `Finding` / `Severity` /
`summarizeFindings` — a second facade over `findings.ts` that nothing needs.
