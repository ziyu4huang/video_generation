# pi-agent-ext-workflow — subagent tool v2: cost visibility, agentType/schema parity, live progress (design)

**Date:** 2026-07-19
**Branch (next):** off `origin/main`
**Owner:** Ziyu Huang

## 1. Goal

The `subagent` tool (`bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`) is
the single-dispatch counterpart to the `workflow` engine's `agent()` — "one
isolated-context subagent, one focused task, report back." Reading its
implementation alongside `spawn-subagent.ts` and the underlying
`WorkflowAgent.run()` (`agent.ts`) surfaces a gap: several capabilities
`WorkflowAgent.run()` already implements internally — usage/cost accounting
(`onUsage`), a compact live history of the child's steps (`onHistory`),
structured output (`schema`), and named `agentType` bindings
(`tools`/`disallowedTools`/`model`/`prompt`/`isolation` from
`agent-registry.ts`) — are fully wired through `spawnSubagent()` but stop
short of `subagent-tool.ts`'s TypeBox parameter schema and `SubagentToolDetails`.
The result: a model calling `subagent` today gets a synchronous black box
(no progress while it runs), no cost/token report, no way to ask for
machine-readable output, and no way to route to a named agent definition the
`workflow` tool already supports.

This is a **plumbing** problem, not a **missing feature** problem — the
underlying `WorkflowAgent.run()` already does the work; `subagent-tool.ts`
just doesn't ask for it. That materially lowers the risk of this change: no
new execution machinery, only new parameters and pass-through wiring.

## 2. Scope

Three phases, each independently shippable and independently testable:

- **Phase 1** — surface `AgentUsage` (tokens/cost) in the tool result; add
  `timeoutMs` and `retryOnTransient` as tool parameters (both already exist
  on `SpawnSubagentOptions`, neither is exposed today).
- **Phase 2** — add `agentType` (resolves via `agent-registry.ts`, brings
  `tools`/`disallowedTools`/`model`/`prompt`/`isolation` in one binding) and
  `schema` (structured output, already implemented end-to-end inside
  `WorkflowAgent.run()`, just not exposed as a tool parameter).
- **Phase 3** — throttled live progress: wire `onHistory` into the tool's
  `_onUpdate` callback (currently unused) so `renderCall` can show what the
  child is doing while it runs, instead of a bare spinner until completion.

**Considered, deferred:** a `background` param for `subagent` (fire-and-forget
+ a control tool to wait/stop/check status). `docs/superpowers/specs/2026-07-19-workflow-control-tool-design.md`
§3.3 already considered and rejected this the same day, for a materially
similar reason to this round's original framing: "a need not established in
this round" — `subagent`'s own docstring is explicit that it is a single
focused, synchronous dispatch. Nothing in Phases 1–3 changes that rationale
(they add data the tool already computes, not a new execution mode), so this
round does not reopen it. Revisit only if real usage after Phases 1–3 ship
shows the synchronous, one-off-per-call nature of `subagent` (as opposed to
wrapping it in a `workflow` script, which already supports background
execution) is an actual friction point — per §3.3's own exit condition.

- **Surface**: `src/subagent-tool.ts`, `src/spawn-subagent.ts` (new pass-through
  fields only — no change to its retry/abort logic from PR #656), `src/agent.ts`
  (no interface change — `AgentRunOptions` already has everything needed),
  `src/subagent-viewer.ts` (extend `SubagentRun`/reconstruction for the new
  `usage` field so the `/subagents` history viewer shows it), `CONTEXT.md` +
  `PRD.md`. Plus tests.
- **Out of scope**: `WorkflowManager`/background execution (see above); any
  change to `/subagents`' post-hoc, non-live viewing *mechanism* — it still
  reconstructs completed runs from the session branch (the `usage` field is
  additive data on top of that same mechanism, not a change to it); Phase 3's
  live progress is a separate, in-flight-only surface, per the prior
  TUI-visibility design's own "Level-2 deferred" split; renaming or merging
  the existing `agent` (free-text role label) parameter — it stays as-is,
  orthogonal to the new `agentType`.

## 3. Design

### 3.1 Phase 1 — cost/token usage, `timeoutMs`, `retryOnTransient`

**Usage.** `WorkflowAgent.run()` already accepts `onUsage?: (usage: AgentUsage) => void`,
firing "once with this subagent's real usage... on both the success and error
path so partial usage is never lost." `spawnSubagent()` gets a new
`onUsage`-style capture (mirrors how it already captures `run()`'s return
value) and adds `usage: AgentUsage` to `SpawnSubagentResult`. `SubagentToolDetails`
gains the same field. `renderSubagentResult`'s meta line becomes
`${model} · ${elapsed}s · $${cost} · ${totalTokens} tok` (only appended when
`usage.total > 0`, since `total === 0` means the provider reported nothing —
per `AgentUsage`'s own doc comment, that is not an error, just don't render a
misleading `$0.000 · 0 tok`).

**`timeoutMs?: number`.** New tool parameter, passed straight through to
`spawnSubagent({ timeoutMs })` (already implemented: sets a `setTimeout` that
aborts the internal `AbortController`, and `classifyError` already treats that
abort as `{transient: true, timedOut: true}`, so it composes with the existing
single-retry-on-transient path unchanged). Undefined = no timeout (current
behavior, unchanged default).

**`retryOnTransient?: boolean`.** New tool parameter, passed straight through
to `spawnSubagent({ retryOnTransient })`. Default `true` (current hardcoded
behavior, unchanged default) — this just makes the existing default
overridable per call, e.g. for a task the caller knows is not idempotent.

No changes to `classifyError`, the retry loop, or the abort-signal guard from
PR #656 (`if (opts.externalSignal?.aborted) return first.result`) — this phase
only adds two pass-through parameters and one new output field.

### 3.2 Phase 2 — `agentType` binding + `schema` (structured output)

**`agentType?: string`.** New tool parameter. `execute()` resolves it via the
existing `AgentRegistry` (`agent-registry.ts`, `.pi/agents/*.md` + `~/.pi/agents/*.md`,
project wins on collision — same registry `workflow`'s `agent(prompt, {agentType})`
already uses). A hit applies, in order:
1. `tools`/`disallowedTools` from the definition, unless the call also passed
   `params.tools`/`params.excludeTools` (explicit call-site values win over
   the binding — matches the `workflow` engine's existing `agentType` +
   explicit-override precedence).
2. `model` from the definition, unless `params.model` is set (same
   explicit-wins rule).
3. `prompt` (the definition's markdown body) prepended to `task`, alongside
   the existing `agent`-label instructions prefix if both are given.
4. `isolation: "worktree"`, if set on the definition → `createWorktree(cwd, name)`
   (`worktree.ts`, already used by the `workflow` engine — reused verbatim,
   not reimplemented) before the run, `removeWorktree` in a `finally` after.

An unresolvable `agentType` (no matching definition, neither project nor
user) is a **tool-level error returned before spawning anything** — the error
text lists the currently available `agentType` names (read from the same
registry) so the model can self-correct, rather than silently running
unbound (see §4).

`agent` (the existing free-text role label, e.g. `"implementer"`) is
**unchanged and orthogonal**: it still only affects the `renderCall` display
line and a plain instructions-prefix string; it does not resolve against the
registry. Both can be given together — `agent` only changes what's shown /
prefixed, `agentType` only changes what actually runs.

**`schema?: unknown`.** New tool parameter. A TypeBox `TSchema` is, at
runtime, a plain JSON-Schema-shaped object — so a model-supplied JSON object
in the tool call can be passed straight through as `TSchema` without a
conversion layer. `execute()` does a minimal shape check (must be a non-null
object with at least a `type` field) before calling `spawn({ schema: params.schema as TSchema })` —
cheap validation that fails fast with a clear error instead of letting a
malformed value propagate into `WorkflowAgent.run()`'s existing
`structured_output`-tool machinery (already implemented, unchanged) and fail
there with a less legible error. `formatSubagentResult`'s existing
"non-string → `JSON.stringify`" branch already handles the schema-produced
object output; no change needed there.

### 3.3 Phase 3 — throttled live progress (`_onUpdate`)

`WorkflowAgent.run()` already accepts `onHistory?: (history: AgentHistoryEntry[]) => void`,
"a compact snapshot of this subagent's message/tool history." Today
`subagent-tool.ts`'s `execute(_toolCallId, params, signal, _onUpdate, _ctx)`
declares but never uses `_onUpdate`. This phase wires them together:

- `spawnSubagent()` gains an `onHistory` pass-through option (mirrors the
  existing `agent?: Pick<WorkflowAgent, "run">` injectable-runner pattern used
  in tests — no change to the runner contract itself).
- In `execute()`, `onHistory` is throttled (confirmed: option (b), not raw
  forwarding) — collect the latest `AgentHistoryEntry[]` snapshot, but only
  invoke `_onUpdate` at most once per a fixed interval (proposed: 500ms,
  trailing — i.e. if updates arrive faster than the interval, the *latest*
  snapshot is what eventually gets sent, not every intermediate one). This
  bounds TUI re-render frequency for a subagent making many rapid tool calls
  (an exploration-heavy task) without losing the final state.
- `renderCall(args, theme, context)` changes from a one-shot render to one
  that also accepts the latest throttled snapshot (via the tool's standard
  `_onUpdate`-driven re-render contract) and appends a compact "what it's
  doing now" line, e.g.:
  ```
  subagent ▸ researcher ▸ default ▸ "count out loud from 1 to 40..."
    ↳ reading src/foo.ts
    ↳ 12.4s elapsed · 3 tool calls
  ```
  Exact history-entry-to-display-line mapping (which entry types render,
  truncation width) follows the same theming conventions `renderSubagentCall`
  already uses (`theme.fg("dim", …)`, `truncateToWidth`).
- The `/subagents` history viewer (`subagent-viewer.ts`) is **not** changed by
  this phase — it reconstructs completed runs from the session branch by
  design (its own doc comment: "No live streaming — runs are the COMPLETED
  tool results"), which is a deliberate, orthogonal split from live in-flight
  progress. This phase is exactly the "Level-2... live streaming of a running
  subagent's output" item the prior `2026-07-18-subagent-tui-visibility-design.md`
  explicitly deferred as "needs a `WorkflowAgent.run`/`createAgentSession`
  event/callback hook; existence unconfirmed in the SDK" — `onHistory` is
  that hook, and it already exists in the current `agent.ts`, so that
  uncertainty is resolved.
- A throttled-update failure (e.g. the TUI-side re-render throws) must not
  fail the subagent run itself — wrapped in try/catch, worst case is one
  dropped progress update (see §4).

## 4. Error handling

- **Phase 1**: `usage.total === 0` (provider reported no usage) is not an
  error — same "fires on both success and error path" semantics `onUsage`
  already documents; the render just omits the cost/token segment.
  `timeoutMs`/`retryOnTransient` reuse the existing `classifyError`/retry
  paths verbatim — no new error shapes.
- **Phase 2**: unresolvable `agentType` → tool-level error listing available
  names, returned **before** `spawn()` is called (no wasted child session).
  Malformed `schema` → tool-level error from the pre-flight shape check,
  also before `spawn()` is called, distinct from (and earlier than) any error
  `WorkflowAgent.run()`'s own `structured_output`/`maxSchemaRetries` machinery
  would produce for a well-formed-but-unsatisfiable schema.
- **Phase 3**: a throttled `_onUpdate` call that throws is caught and
  swallowed at the call site — logged at most (no user-facing surface), never
  propagated to fail the subagent's actual task.
- No change to PR #656's abort-signal / no-retry-on-external-abort behavior
  in any phase.

## 5. Testing

Extends the existing mock-runner pattern (`mkRunner` in
`spawn-subagent.test.ts`, `fakeSpawn` in `subagent-tool.test.ts`) — no real
model calls needed for any of the three phases:

- **Phase 1**: a mock runner's `onUsage` callback fires with a fixture
  `AgentUsage` → `spawnSubagent()`'s result carries it; `usage.total === 0` →
  `renderSubagentResult` omits the cost/token segment (assert the rendered
  string, not just the data). `timeoutMs` → assert the internal
  `AbortController` fires via `setTimeout` at the given delay (fake timers).
  `retryOnTransient: false` → assert exactly one `runner.run` call on a
  transient failure (mirrors the existing "REGRESSION: an external abort must
  not trigger the retry" test's assertion style, but for the new flag instead
  of abort).
- **Phase 2**: fixture `.pi/agents/*.md` definitions (temp dir, following
  `agent-registry.ts`'s existing test fixtures if any exist, else a minimal
  new fixture) → `agentType` resolves `tools`/`model`/`prompt`/`isolation`
  correctly; explicit `params.model`/`params.tools` override the binding;
  unknown `agentType` → tool-level error listing available names (assert the
  error text, not just that it throws). `schema` → a mock runner asserts it
  receives the schema object unchanged in its `opts.schema`; malformed
  `schema` (missing `type`) → tool-level error before the mock runner is ever
  called (assert zero calls).
- **Phase 3**: a mock runner invokes its injected `onHistory` callback N times
  in rapid succession (fake timers) → assert `_onUpdate` fires fewer times
  than N (throttled) and the final call's snapshot is the last one produced
  (trailing semantics, not dropped-last). An `_onUpdate` that throws → assert
  the overall `execute()` call still resolves successfully with the correct
  result (the throw does not propagate).
- **Manual**: dispatch a real `subagent` call with `agentType` set to an
  existing project definition, observe tools/model/isolation applied; dispatch
  with `schema` set, observe structured output in the result; dispatch a
  longer-running task, observe the `renderCall` line update mid-run instead of
  a bare spinner.

## 6. Docs

- `CONTEXT.md`: extend the `subagent` tool's entry with the new parameters
  and the `agentType`/`schema`/`usage`/live-progress capabilities, cross-
  referencing `agent-registry.ts`'s existing `agentType` language entry (avoid
  duplicating its definition — this doc only needs to note that `subagent`
  now also reads from it).
- `PRD.md`: note the `subagent` tool now has near-parity with the `workflow`
  engine's `agent()` primitive for single-dispatch use, modulo background
  execution (explicitly still out of scope — link back to §3.3 of
  `2026-07-19-workflow-control-tool-design.md`).
