# pi-agent-ext-power-tool

A **pi extension** for agent self-diagnostics, in two complementary modes:

- **Static diagnostics** — what is loaded, and where the tokens go.
- **Failure pathology** — how the agent is failing *this session* (retry loops,
  error storms, context saturation), from accumulated tool-call history.

Plus `schema-cost`, a static tool-schema token estimator exported as a standalone
submodule and consumed by `pi-agent`'s CLI and `pi-agent-ext-tool-gate`.

## Where the facts live

**This README does not list the tools, their parameters, or their checks.** That
inventory lives in the code and is authoritative there:

| Question | Answer lives in |
|---|---|
| Which tools exist? | `src/index.ts` → `TOOL_FACTORIES` / `POWER_TOOL_NAMES` |
| What does a tool do, and what are its parameters? | that tool's `defineTool({ description, parameters })` |
| Which health checks does `inspect_extensions` run? | `analyzeExtensions()` in `src/tools/inspect-extensions.ts` |
| Which pathologies are detected? | `analyzePathology()` in `src/pathology/detector.ts` |
| Which lifecycle events are considered known? | `KNOWN_EVENTS` in `src/runner-hooks.ts` |

The README used to mirror all of it and went stale in every direction at once — a
severity documented as `medium` that the code emitted as `info`, a "Phase 2
(future)" section describing shipped behaviour, a tool count that was wrong in
four files. Prose that restates code is prose that will lie. Browse the live
surface instead: `/extensions power-tool` in a session, or `call inspect_agent`.

## Design

- **Pure core, thin tool.** Every diagnostic is a pure analyzer over a typed input
  (`analyzeExtensions`, `analyzeHooks`, `analyzePathology`) plus a pure formatter.
  `execute()` only projects the live context into that input. This is what makes
  the suite unit-testable with no SDK and no session.
- **One estimator.** `schema-cost/` owns the tool-schema cost formula; `src/cost.ts`
  is the adapter the live instruments use. Nothing else computes it.
- **One-way layering.** `tools/` → `{cost, report, gating, findings}` → `schema-cost/`;
  `sdk-patch` → `runner-hooks`. Infra never imports a tool module.
- **`self_test: true`** on any tool runs it against a deterministic fixture, with no
  live session required.

## Layout

```
pi-agent-ext-power-tool/
├── extensions/
│   ├── power-tool.ts       # the registered entry (+ tool-gate QA probes)
│   └── cli-subcommand.ts   # `pi-agent cli power-tool` wiring
└── src/
    ├── index.ts            # ExtensionFactory + TOOL_FACTORIES (the tool inventory)
    ├── cost.ts             # the one tool-schema cost measurement
    ├── gating.ts           # the one tool-gate predicate the suite shares
    ├── report.ts           # token/bar formatting + shared report chrome
    ├── findings.ts         # Finding / Severity vocabulary
    ├── runner-hooks.ts     # runner-shape adapters (hook collection + firing counts)
    ├── sdk-patch.ts        # getSystemPromptOptions()/getHooks() shim on the tool ctx
    ├── extensions-command.ts  # the /extensions slash command
    ├── tools/              # one module per inspect_* tool
    ├── schema-cost/        # static tool-token estimator (exported; publishable)
    └── pathology/          # failure-pattern detection (accumulator + detector)
```

## Usage

```bash
# Auto-loaded via pi-agent's static extension set — just run a session.
bun bun-apps/pi-agent/src/cli.ts

# Standalone, one-shot:
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/extensions/power-tool.ts \
  -p "call inspect_context"

# As a CLI subcommand (natural language, agent picks the tool):
bun bun-apps/pi-agent/src/cli.ts cli power-tool "which extension is heaviest?"
```

## Testing

```bash
./run-test.sh                  # medium (default): unit + typecheck
./run-test.sh quick            # unit only, no typecheck
./run-test.sh high             # + PI_RUN_L2=1 (blocked services SKIP)
./run-test.sh readonly         # PI_RUN_L2=1, l2-e2e.test.ts only (skip allowed)
./run-test.sh full             # + PI_REQUIRE_L2=1 (blocked services FAIL, not skip)
./run-test.sh --list           # print the tier table
```

`high`/`full` spawn the real `pi-agent` CLI and call a real LM Studio model
(`google/gemma-4-12b` by default, override via `PI_L2_MODEL`). There is no
standalone "real CLI, no model" tier: invoking a tool through the CLI always
triggers model inference, so `high` and `full` run the same suite and differ only
in whether a blocked service skips (`high`) or fails (`full`). See
`src/__tests__/l2-e2e.test.ts` for the per-tool gate list.

## Design notes

- `docs/extension-analyzer.PRD.md` — the extension-lint design.
- `docs/schema-cost.md` — the estimator's contract.
- `docs/extension-ui-conventions.md` — report/UI conventions.
- `CONTEXT.md` — the ubiquitous language for this domain.
