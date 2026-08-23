# Spec — Snapshot Row Single Source (workflow presentation)

> STATUS: approved 2026-08-15. Evidence line refs verified at `origin/main` (`ec98b13e`,
> immediately after prerequisite #1362).

---

## §1 Scope

Kill the **last untrusted projections** in workflow presentation. After the RunView Phase 2
effort (#1345/#1347/#1351, archived `2026-08-15-runview-phase2-agentrow`) unified the
subagent-side render stack, the workflow package still hand-builds its snapshot projection and
re-derives counts/glyphs/delivery text per site. Each of those copies is a silent-drift bug
waiting to happen — PR #1362 proved the class (a new persisted field, unmapped in
`persistedToSnapshot`, rendered blank in resumed navigator rows until hand-patched).

- **Prerequisite**: #1362 (shipped, `ec98b13e`) — `persistedToSnapshot` maps `tokens` +
  `startedAt`. This effort does not depend on the hotfix mechanically, but the hotfix is the
  motivating incident and its fix is subsumed by ticket 1.
- **Wave 1** = four mechanical tickets (§2): exhaustive adapter, single count derivation,
  unified delivery text, typed status glyph.
- **Wave 2** = one **time-boxed spike** (§3) deciding `ActivityRow` retirement. Mechanics only
  for what Wave 1 proves cheap; **no blind migration** of `ActivityRow`→`RunView` — the spike
  reports first, the user decides, and only then does any retirement work get planned.

## §2 Wave 1 — four mechanics tickets

### Ticket 1 — exhaustive `persistedToSnapshot` in `run-persistence.ts`

**Today**: `persistedToSnapshot` is a private function in `workflow-ui.ts` (`:193–222`) mapping
`PersistedRunState` → `WorkflowSnapshot` by hand. Adding a field to `PersistedAgentState`
(`run-persistence.ts:13–30`) does **not** force a map update — #1362 shipped exactly two such
unmapped fields (`tokens`, `startedAt`) as a hotfix.

**Change**: move the constructor into `run-persistence.ts` (exported) and add a
compile-time exhaustiveness check on the agent mapping:

```ts
const agentProjection: Record<keyof PersistedAgentState, (a: PersistedAgentState) => unknown> = {
  id: (a) => a.id,
  label: (a) => a.label,
  // … one entry per key …
};
// satisfies-check: a new PersistedAgentState key without a projection row = compile error
const _exhaustive: Record<keyof PersistedAgentState, unknown> = agentProjection;
```

(using `satisfies Record<keyof PersistedAgentState, …>` — exact spelling chosen at plan time;
the invariant is: **unmapped new field = compile error**). `workflow-ui.ts` imports the adapter
and deletes its local copy. `WorkflowSnapshot` stays in `display.ts`; the adapter may import the
type (no import cycle: `display.ts` does not import `run-persistence.ts`).

### Ticket 2 — `agentCounts(agents)` single derivation

**Today** five call-site clusters (per the brainstorm list; six physical rows — `runs()` and the
adapter counters share a file) filter agents independently:

| Site | Ref |
| --- | --- |
| `NavigatorModel.runs()` done/total | `workflow-ui.ts:110–115` |
| `persistedToSnapshot` counters (`agentCount`/`runningCount`/`doneCount`/`errorCount`) | `workflow-ui.ts:215–218` |
| `summarizeRun` done/total | `workflow-commands.ts:33–34` |
| `oneLineProgress` done/running/errs | `workflow-commands.ts:40–43` |
| `renderPanel` done/total | `task-panel.ts:242–243` |
| `workflowPreview` finished/total | `workflow-manager.ts:65–68` |

**Change**: one exported `agentCounts(agents)` helper (owner decided at plan time — `display.ts`
beside `recomputeWorkflowSnapshot` is the natural home, since that function
`display.ts:81–87` already derives the same counters once for live snapshots). All sites
converge on it; the snapshot rollup counters derive **once** (adapter/persisted path reuses the
same derivation instead of duplicating the three filters). Same-file satellites
(`workflow-ui.ts:155` phase rows, `task-panel.ts:327–330` phase breakdown, `task-panel.ts:386`)
migrate in the same ticket where the helper fits; sites needing different status subsets
(e.g. `workflowPreview`'s done+error+skipped "finished") take a parameter, not a copy.

### Ticket 3 — unified `deliverText`

**Today** two near-duplicate builders in `task-panel.ts`:

- `deliverText(run: ManagedRun)` — `task-panel.ts:82–90` (live `ManagedRun` + `WorkflowRunResult`)
- `deliverTextFromPersisted(run: {...})` — `task-panel.ts:181–197` (persisted-only fields,
  structurally typed input)

They differ only in the lead sentence and field sourcing; the summary/tokens/agents/duration
assembly is copy-pasted.

**Change**: one `deliverText` over a common input subset (result, agentCount, tokenUsage.total,
durationMs, name, plus a lead-sentence variant or flag). The persisted path sources its fields
**through the ticket-1 adapter** (persisted → snapshot → shared builder) instead of re-reading
raw `PersistedRunState` fields — so a future unmapped field can't fork the two texts again.

### Ticket 4 — typed `runStatusGlyph()`

**Today** two untyped `STATUS_ICON: Record<string, string>` maps with a `"?"` fallback:

- `workflow-commands.ts:17–25`, used at `:32`, `:94`, `:115`, `:287`
- `workflow-ui.ts:33–45`, used at `:399`

A new `RunStatus` value renders as `"?"` silently. (The workflow-ui copy also doubles agent
statuses into a run map — a vocabulary smear.)

**Change**: one `runStatusGlyph(status: RunStatus): string` (typed on `RunStatus` from
`run-persistence.ts:10`), implemented as an exhaustive `Record<RunStatus, string>` — **a new
status missing a glyph is a type error**. Agent-status glyphs stay with `activityGlyph`
(`core-runtime/agent-row-display.ts:106`); the workflow-ui sites that currently lean on the
smeared map either call `runStatusGlyph` (run rows) or `activityGlyph` (agent rows). Delete both
`STATUS_ICON` maps and the `?? "?"` fallbacks.

## §3 Wave 2 — one time-boxed spike ticket (ticket 5)

**Question**: what does `task-panel` / `workflow-ui` **actually need** from `ActivityRow`?

Today the navigator agents view hand-builds an `ActivityRow` per agent
(`workflow-ui.ts:431–441`: status cast, actor, model, live elapsed from `Date.now() -
startedAt`, tokens, `summarizeLatestAction(history)`) and renders via
`renderActivityRow`. The RunView Phase 2 stack (core-runtime `agent-row-display.ts`,
`renderRunRow`) already encodes glyph + elapsed-freeze + model segment + usage.

**Spike**: measure whether hydrating `agents → RunView → renderRunRow` is cheap and faithful
(elapsed freeze semantics, latestAction, model fallback segment, snapshot-only sourcing). Two
valid outcomes:

1. **Cheap + faithful** → retire `ActivityRow` from the workflow production path
   (test fixtures may keep it); propose the retirement as a follow-up effort.
2. **Expensive / lossy** → document why in the package `CONTEXT.md` and close.

**User decision gate**: the spike outcome is reported to the user **before any retirement work
is planned or executed**. Retirement is not part of this effort's deliverables; the spike ticket
delivers only findings + recommendation. (Consistent with §1: "spike, no blind migration".)

**Time-box**: one session (~half day). If the spike overruns, it stops and reports partial
findings — no scope extension.

## §4 Non-goals (YAGNI)

- **No `RunStatus`/`ActivityStatus` vocabulary merge** unless the wave-2 spike dissolves the
  boundary on its own; ticket 4 keeps them typed separately.
- **No `workflow-manager` god-module split** — separate future effort (arch-review C4
  neighborhood), not this one.
- **Subagent-package findings stay out** — `latestAction` double-derivation and `modelSeg`
  duality (`subagent-context-widget.ts:129–153`, `subagent-tool-render.ts:281–282`) are a
  separate future effort (**cluster A**); this effort touches only `pi-agent-ext-workflow`.
- No UI/visual changes: byte-identical rendered output is the bar for every wave-1 ticket.

## §5 Verification

Per-ticket, in `bun-apps/pi-agent-ext-workflow` — canonical gate `( cd bun-apps/pi-agent-ext-workflow && bun run test )`:

- **Ticket 1**: new regression test — adapter round-trip over a fully-populated
  `PersistedAgentState` (every field asserted mapped), plus a **legacy-omit** case (old persisted
  JSON missing `tokens`/`model` → snapshot degrades gracefully, counters still correct). The
  exhaustiveness check itself is compile-time (package typecheck inside `bun run test`).
- **Ticket 2**: regression asserting count consistency — same agents array through every
  converged site yields identical counts; snapshot rollup counters equal helper output.
- **Ticket 3**: both delivery variants render identical lead/summary/tail for the same
  underlying run (live vs adapter-persisted).
- **Ticket 4**: glyph-map exhaustiveness is type-level (`Record<RunStatus, string>`); runtime
  test asserts no call site can receive `"?"` (map lookup is total by construction).
- **Ticket 5**: wave-2 conclusion **documented in this effort dir** (spike findings file or
  ticket Resolution), whichever outcome — including the explicit user decision record if
  retirement is proposed.
- Existing tests stay green throughout; no rendered-output diffs beyond intentional ones
  (expected: none).
