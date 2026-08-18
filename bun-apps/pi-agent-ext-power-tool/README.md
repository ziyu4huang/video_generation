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

## webui audit (Playwright)

The `webui` tool audits the LIVE webui extension (pi-agent-ext-webui) in one
call: it opens `http://localhost:<port>` in headless system Chrome (same engine
as the browser tool — never downloads one), exercises every tab, screenshots
each into `~/.pi/power-browser/runs/`, and evaluates the design invariants.

```bash
# In a session: just say "call webui" (gated: power_browser family).
# Default port 8890; publish on by default:
#   call webui {port: 8890, publish: true}
```

**Invariants (7).** The tool DETECTS the live layout — it never assumes which
shell generation is running (v2/v3 family-tolerant):

1. `panes-exclusive` — at most one visible pane.
2. `ask-cards-located` — ask cards live in inbox-family panes.
3. `viewer-cards-located` — viewer cards live in data panes.
4. `report-articles-located` — report panes hold report-* articles only.
5. `report-iframe-sized` — report iframes >= 320x300 (the #1576 bug class:
   a browser-default 300x150 iframe passed every earlier invariant; geometry
   is measured with each pane actually SHOWN — a hidden pane measures 0x0 and
   counts as unmeasured, never a failure).
6. `zero-page-errors` / 7. `zero-console-errors` — the shell loads clean
   (boot noise like a favicon 404 or an empty main-slot 404 fails here).

**Dogfood (audit → report loop).** After auditing, the tool PUBLISHES its own
markdown report into the audited webui's Report tab (`POST /api/report`,
source `webui-audit`) — findings appear in the browser you are looking at, and
the webui's persistence mirror accumulates audit history across restarts.
Best-effort by contract: a publish failure never fails the audit it reports
on; opt out with `publish: false`.

**Verification playbook** (proven across the webui-v3 arc): drive the REAL
`makeWebuiTool().execute()` from a script for CI-style audits; for
composition-level proof boot the real `wireWebui` against a seeded
`WEBUI_REPORT_DIR` and fire `session_start` (the server starts lazily there);
`page.on("console")` messages carry `msg.location()` with the URL Chromium
strips from the text (how the favicon 404 was found); download menus prove out
via `page.waitForEvent("download")` with `acceptDownloads: true`.

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

## Longitudinal analysis

`pi-agent cli agent-trends` replays the pathology detectors over historical session
transcripts and reports occurrence-rate trends with regression verdicts. Nothing is
uploaded and nothing derived is persisted — every number is recomputed from
transcripts on each run (1,166 sessions in ~1.4 s), so changing a threshold
re-derives the whole history consistently.

Measured base rates over 1,165 tool-using sessions (49 days, 2026-06-28 → 2026-08-16):

| pathology | rate | sessions |
|---|---:|---:|
| long-session-recall-risk | 37.0% | 431 |
| consecutive-error | 5.7% | 66 |
| error-storm | 1.8% | 21 |
| retry-loop | 0.9% | 10 |
| context-saturation | 0% | 0 |

Three things to know before reading a report:

- **`retry-loop` and `error-storm` are too sparse for a verdict** at this data
  volume — they report `insufficient signal` rather than a direction. Designed
  behaviour, not a missing feature.
- **`context-saturation` has never fired.** Peak context fill across the whole
  archive is 56.2% against an 85% threshold, so it is excluded from the trend views.
- **Each check is judged against its own volatility, not a global constant.** The
  checks differ by an order of magnitude: `long-session-recall-risk` runs
  15.5 · 3 · 53 · 39 · 44.5 · 73.4 (50pp swings are its normal state) while
  `consecutive-error` runs 5 · 2 · 12 · 3 · 10.5 · 0.6. A single 10pp rule
  over-reported the first and under-reported the second, so the threshold is now
  the largest window-to-window move that check made *before* the pair under
  judgement, floored by `--delta`. Every verdict prints the threshold it used
  (`stable (vs 50pp own volatility)`), so a surprising verdict is self-explaining.

Known limitation: the threshold compares one step at a time, so it sees a jump but
not a march. `long-session-recall-risk` has climbed 3% → 73.4% across four windows
without any single step exceeding its historical maximum — correctly not flagged as
a regression, and still worth watching. Read the series, not only the verdict.
