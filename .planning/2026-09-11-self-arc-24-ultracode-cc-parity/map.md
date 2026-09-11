---
effort: 2026-09-11-self-arc-24-ultracode-cc-parity
created: 2026-09-11
last: 2026-09-11
status: active
---

# self-arc-24 — ultracode → Claude Code parity (function + TUI)

Source of "similar to Claude Code": the two committed research digests produced through the
deployed s2-agent by GLM-5.3 children — `evidence/cc-function-digest.md` and
`evidence/cc-tui-digest.md`. This arc closes the subset of gaps that is ultracode-owned,
falsifiable, and verifiable on a pinned deploy inside an isolated work env.

## Destination

After this arc, parity with Claude Code means — each delta falsifiable on the DEPLOYED tree:

1. **Pre-flight ceiling-confirm (CC permission-ASK parity, TUI digest §7 / function digest §3).**
   An effort=ultra-armed interactive workflow call with NO explicit `tokenBudget` cannot start
   spending before the human answers a numbered dialog: `1. Launch unbounded  2. Cap at …
   3. Abort`. Choice 2 amends `tokenBudget` and proceeds; choice 3 returns an aborted tool
   result. Headless/background runs behave exactly as today (gate skipped — no hang risk).
2. **checkpoint() renders its declared kind (CC permission-prompt parity, TUI digest §7).**
   `checkpoint("…", {kind:"select", choices:[…]})` shows a numbered, arrow/number-navigable
   choice list in the TUI and journals the picked choice; `default`/`timeoutMs` surface in the
   dialog. This resolves the yes/no-only rendering self-observed at `workflow-tool.ts:539-545`.
3. **Transcript-grade agent detail (CC Ctrl+O parity, TUI digest §4/§7).** `/workflows`
   navigator agent-detail shows a timestamp on every history entry and a total duration per
   agent — "timestamps + model per message" (model per agent already ships).
4. **Steering plumbing seam (CC queued-steering parity, TUI digest §6 / function digest §4).**
   The runtime emits live agent-session handles; the manager can call
   `steerWorkflowAgent(runId, agentKey, text)` against a `SteeringCapableSession`. Command/UI
   wiring is charted (Loop findings), not landed.
5. **Verified on the deployed tree in an isolated work env** — pinned immutable version dir,
   grep-asserted bundles, throwaway scratch git repo, receipts committed under `evidence/`.

Not in scope (charted, see Loop findings): persistent footer statusline badge, statusLine JSON
protocol, spinner verb line, plan-mode ring, main-loop worktree enter/exit — all pi-core /
s2-agent-core surfaces, not ultracode-owned.

## Context

Measured 2026-09-11 in this worktree against `bun-apps/s2-agent-ext-ultracode` and
`bun-apps/s2-agent-core-runtime` (all anchors re-read this session):

- **H1 pre-flight confirm — VERIFIED real and feasible.** `src/effort-command.ts:5-11`
  self-charts the gap: the `input` hook transforms synchronously and "can't await a confirm,
  so it is left to a follow-up" (roadmap P1-5 #4); `/effort` today only prints a message
  (`effort-command.ts:66-88`). Feasibility proven in-tree: `src/workflow-tool.ts:539-545`
  threads `ctx.ui.confirm` for checkpoints — the tool-call path CAN await UI — and
  `workflow-tool.ts:572-576` is where `maxAgents`/`tokenBudget` are known. The confirm
  therefore belongs at the tool boundary, not the input hook.
- **H2 checkpoint rendering — VERIFIED; the parity surface is rendering only.**
  `src/workflow.ts:211-228` `CheckpointOptions` already declares `kind: "confirm" | "input"
  | "select"`, `choices`, `default`, `headless`, `timeoutMs`; the internal contract
  `workflow.ts:112` already passes options (`confirm?: (promptText, options) => …`), and
  `workflow-runtime.ts:581-583` accepts and hashes them (`hashCheckpoint`, :111). The loss is
  the adapter: `workflow-tool.ts:544-545` collapses everything to
  `ctx.ui.confirm(title, message): Promise<boolean>` (the only awaitable typed on the
  structural UI at :541). A resolve-by-human-reply API already exists for UI-bearing runs
  (`workflow-manager.ts:128`).
- **H3 persistent armed badge — VERIFIED gap, REJECTED for this arc.** No persistent surface
  exists in ultracode: the keyword highlight is editor-typing-only
  (`workflow-editor.ts:214-261`), `/effort` prints a transient message, the task panel exists
  only during runs. Every always-on badge surface (footer/statusline) is pi-core — candidate-6
  territory. Charted, not landed.
- **H4 per-history timestamps — VERIFIED gap.** `AgentHistoryEntry`
  (`s2-agent-core-runtime/src/agent-history.ts:7-17`) carries `role/kind/text/toolName?/
  toolCallId?` — no timestamp. Navigator detail (`workflow-ui.ts:406-424`) renders
  `historyLabel(entry): entry.text` (:445-452) with no per-entry time; per-agent elapsed shows
  only while running (:413-414); model per agent IS shown (:412). core-runtime is repo-owned
  (`@repo/*` workspace pkg), so adding an optional `ts` is in-scope and backward-compatible.
- **H5 workflow-run steering — VERIFIED real, honestly sized >1 ticket.** Steering machinery
  from self-arc-23 lives in core-runtime: `agent-turns.ts:92-137`
  (`SteeringCapableSession.steer`, turn-guard delivery at the idle boundary) and
  `agent-budget.ts:144` (`sendUserMessage` `steer|followUp`). Workflow agents run via
  `runAgentWithTimeout((signal) => agentRunner.run(…))` (`workflow-runtime.ts:380`) but the
  live session handle is not surfaced anywhere; `RunEvents` has `onAgentHistory`
  (`workflow.ts:129`) as the hook-shaped precedent. Registry-subagent steering
  (`list_subagent_runs steer`, #2264/#2269) cannot see these sessions. Per the brief: land the
  plumbing seam only; command/UI charted.
- **Research digest anchors:** function digest §3 (deny→ask→allow, permission ASK),
  §4 (subagents), §7 (ExitPlanMode numbered approval); TUI digest §4/§7 (transcript viewer:
  timestamps, model per message), §5 (persistent footer badge), §6 (queued steering at tool
  boundaries), §7 (numbered permission choice lists, arrow cursor, number keys).
- **Deploy context (learning #1, 2026-09-06):** the bundler INLINES `@repo/*` workspace
  packages; `computeCoreHash` must keep hashing `workspaceSrcDirs` (t03/t04 touch
  core-runtime, so deploy cache correctness is load-bearing for this arc). Verification drives
  a pinned immutable version dir, never `current` (PB-08), and greps the shipped bundles for
  distinctive new symbols BEFORE driving (PB-09); pre-fix receipts preserved (PB-10);
  receipts land committed in `evidence/` (PB-18).

### t01 — checkpoint-select dialog (options-aware checkpoint rendering)

**Goal.** `checkpoint(prompt, {kind:"select", choices})` renders a numbered choice list in the
interactive TUI (arrow + number-key navigation, Enter confirms, `default` preselected,
`timeoutMs` honored); the picked choice is returned to the script and journaled. `kind:
"confirm"` gains the options-aware title/message (default/timeout shown). Headless/background
behavior byte-identical to today (declared default, journaled).

**Files.**
- `src/workflow-tool.ts:539-549` — adapter: stop collapsing to boolean; branch on
  `options.kind` and route select/confirm to the new dialog host; keep the boolean
  `ctx.ui.confirm` as the fallback when the dialog host is unavailable.
- `src/checkpoint-dialog.ts` (new) — pure render + keymap for the numbered list (model on
  `workflow-ui.ts`'s component style).
- Host wiring — `src/task-panel.ts` (pending-checkpoint state with key capture, since the
  panel is already live during the tool call) OR a pushed dialog via the same machinery
  `workflow-commands.ts` uses for the `/workflows` navigator. **Step 1 is a probe** of both
  hosts (can a dialog be opened/awaited from inside the tool handler?): record the answer and
  the pi ToolContext UI surface (probe
  `node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.d.ts`) in the ticket
  notes; implement whichever works, fall back to task-panel capture.
- `src/workflow.ts` checkpoint docstring + `workflow_help` "helpers" topic text
  (`workflow-tool.ts` help strings ~:279/:299) — document `kind`/`choices`. If any tool
  description string changes: `bun run --cwd bun-apps/s2-agent cli tools-metrics
  --schema-cost --json` before/after (canary `discoverExtensionEntries`).

**Steps.**
1. Probe (above); write the finding into this ticket body before coding.
2. `checkpoint-dialog.ts` pure render + reducer (list, cursor, wrap, timeout countdown).
3. Tool-boundary adapter branch; thread `CheckpointOptions` through the existing
   `options.confirm` contract (`workflow.ts:112`) — runtime (`workflow-runtime.ts:581+`)
   already handles the rest, including resume-hash stability.
4. Host wiring + journal path sanity (picked string journaled as `result`; resume replays it).

**Tests+Gates.** Unit: dialog render/reducer (cursor, number keys, default, timeout);
adapter mapping matrix (select/confirm/headless/no-UI); resume-hash unchanged for same
options (guards `hashCheckpoint`). `bun run check && bun run typecheck && bun test` in
`s2-agent-ext-ultracode`; schema-cost diff if help strings changed; local-ci via devops chain.

**Done-when.** A driven TUI session (source tree) shows the numbered list for a
`kind:"select"` checkpoint, keys pick a choice, the script receives it, and the journal
replays it on resume; headless path byte-identical (unit-proven).

### t02 — pre-flight ceiling-confirm for armed ultra workflows

**Goal.** Close the self-charted roadmap P1-5 #4: an interactive (hasUI) workflow tool call
gated by `effortState.level === "ultra"` with `params.tokenBudget === undefined` and
(`params.maxAgents === undefined || >= 8`) shows the t01 dialog BEFORE the run starts:
`1. Launch unbounded (maxAgents=N)  2. Cap at suggested budget  3. Abort`. Choice 2 sets a
suggested `tokenBudget` (from the effort tier ladder in `effort-command.ts:23-33`) and
proceeds; choice 3 returns a clean aborted tool result. Gate skipped when: no UI, not
ultra-armed, or explicit budget present. Update the `effort-command.ts:5-11` comment to
resolve the charted item.

**Files.**
- `src/workflow-tool.ts` — gate at the top of the tool handler, where caps are known
  (:572-576); reuse t01's dialog host.
- `src/effort-command.ts:5-11` — comment update; export the effort-state accessor the tool
  reads (the extension instance already shares state with the editor transform path,
  `workflow-editor.ts:28`).
- `src/checkpoint-dialog.ts` (t01) — reuse; no second dialog primitive.

**Steps.**
1. Thread effort state into the tool handler (same extension instance).
2. Gate predicate as a pure exported function (unit-testable without UI).
3. Dialog integration + amended-params path (tokenBudget set, then the existing run path).
4. Abort path: tool result string names the abort, no journal/run created.

**Tests+Gates.** Unit: predicate matrix (ultra/high/off × budget present/absent × maxAgents
7/8/undefined × hasUI true/false); abort result shape; amended-params propagation. Full
package gates + local-ci as t01.

**Done-when.** Driven TUI session (source tree): `/effort ultra` then a substantive message
→ dialog appears before any agent starts → `2` caps and the run's meta shows the injected
tokenBudget; `3` aborts with no run; `/effort high` never gates.

### t03 — navigator transcript parity: per-entry timestamps + agent duration

**Goal.** `/workflows` agent detail gains a `[HH:MM:SS]` prefix on every history line and a
`Duration:` line per finished agent (CC Ctrl+O parity: timestamps per message).

**Files.**
- `bun-apps/s2-agent-core-runtime/src/agent-history.ts:7-17` — add optional `ts?: number`
  (epoch ms), stamped at capture; keep `compactAgentHistory` preserving it.
- `bun-apps/s2-agent-core-runtime/src/agent.ts` (capture sites via :17 import) + snapshot
  plumbing so `WorkflowAgentSnapshot["history"]` entries reach the UI.
- `src/workflow-manager.ts` — record agent `finishedAt` next to `startedAt` (snapshot row
  already carries `startedAt`, see `workflow-ui.ts:78`).
- `src/workflow-ui.ts:406-424, 445-452` — render `[HH:MM:SS] ` before each history entry and
  `Duration: <fmtDuration(finishedAt-startedAt)>` for finished agents; `fmtDuration` already
  exists in the file.

**Steps.**
1. core-runtime: `ts` field + stamp at every append site; compact preserves; typecheck.
2. Manager: `finishedAt` on terminal status transitions.
3. UI: render both; legacy snapshots without `ts` render without the prefix (optional field).

**Tests+Gates.** core-runtime: capture/compact unit tests (ts present, preserved, optional).
ultracode: render snapshot tests (with and without ts; duration line). Both packages:
`bun run check && bun run typecheck && bun test` + local-ci. NOTE: core-runtime is inlined
into every bundle (learning #1) — expect a full core+ext rebuild on deploy; verify the deploy
cache treated it as a miss (hash covers `workspaceSrcDirs`).

**Done-when.** Source-tree navigator detail on a fresh run shows timestamps on history lines
and a duration per finished agent; old persisted snapshots render without breakage.

### t04 — steering plumbing seam (runtime session handles → manager steer API)

**Goal.** Land ONLY the seam: workflow runtime exposes live agent-session handles via a new
`RunEvents` hook; the manager keeps a `runId → {agentKey → session}` registry and exposes
`steerWorkflowAgent(runId, agentKey, text)` calling `SteeringCapableSession.steer`
(`agent-turns.ts:98-99`). No slash command, no navigator row, no tool — those are charted.

**Files.**
- `src/workflow.ts:129` (RunEvents) — add `onAgentSession?: (event: { runId, callIndex,
  label, session: unknown }) => void` alongside `onAgentHistory`.
- `src/workflow-runtime.ts` ~:380 — emit it where `agentRunner.run` creates the session.
  **Step 1 is a probe:** locate where the live session object exists inside
  `WorkflowAgent`/`runAgentWithTimeout` (`workflow-timeout.ts`) and whether a steer-capable
  handle is reachable (`agent-turns.ts:92-137`, `agent-budget.ts:144`); record file:line in
  the ticket. If the handle is genuinely unreachable without a core-runtime refactor larger
  than a seam, land the probe evidence under `evidence/` and convert this ticket to the
  charted design — done-when allows exactly that exit, with the evidence committed.
- `src/workflow-manager.ts` — registry + `steerWorkflowAgent` (fire-and-await via
  `session.steer(text)`, tolerate missing/finished sessions with a typed no-op result).

**Steps.**
1. Probe (above); decide emit point.
2. RunEvents hook + runtime emission (only when the session is steering-capable — feature-
   detect `typeof session.steer === "function"`).
3. Manager registry (register on emit, evict on agent settle/abort) + steer API.
4. Unit tests with a fake steer-capable session; evict-on-settle coverage.

**Tests+Gates.** Both packages' full gates + local-ci. No tool description change → no
schema-cost action.

**Done-when.** Unit test steers a fake live session through
`manager.steerWorkflowAgent(...)` end-to-end (runtime emit → registry → steer), OR the
committed probe evidence proves the handle unreachable and Loop findings carries the design
with anchors.

### t05 — verification leg: deployed tree, isolated work env, receipts

**Goal.** Prove t01–t04 on the DEPLOYED tree with the user-mandated isolation; produce
committed receipts.

**Files.** `scripts/` drive scripts + fixtures under `output/` (scratch), receipts to
`.planning/2026-09-11-self-arc-24-ultracode-cc-parity/evidence/`.

**Steps.**
1. Deploy via `deploy-cli` to a PINNED immutable version dir (never `current` — PB-08).
   BEFORE driving: grep-assert the distinctive new symbols/strings in the shipped bundles
   (`<versionDir>/…` and the s2-agent core bundle) — e.g. the dialog's title string, the
   pre-flight choice text, `steerWorkflowAgent`, the `ts` render prefix (PB-09; learning #1:
   property names and string literals survive minification; if a grep misses, suspect the
   deploy cache, not the code — check `computeCoreHash` covered the core-runtime change).
2. Isolated work env (user requirement): seed a THROWAWAY scratch git repo under `output/`
   (fixture: tiny repo + an ultracode workflow script using `isolation:"worktree"` agents +
   a `kind:"select"` checkpoint). Drive the deployed CLI inside it; assert: worktree agents
   committed on worktree branches, scratch main worktree clean, parent repo `git status`
   clean after the drive.
3. tui-drive scenarios against the pinned deploy (learning #3/4/5 discipline):
   `TERM=xterm-256color`, ~64-byte awaited chunks, primary DA reply `\x1b[?1;2c` + silence on
   kitty `\x1b[?u`, REAL wall-clock sleeps after any dialog mount (first keypress gets eaten
   otherwise), settle judged ONLY on live markers (spinner/`esc to interrupt`), never on
   transcript text. Scenarios: (a) `/effort ultra` + substantive message → pre-flight dialog
   → `2` caps → run proceeds with injected budget; (b) select-checkpoint → numbered list →
   pick → journal; (c) `/workflows` detail shows timestamps + duration.
4. Any red: capture the PRE-fix receipt FIRST (PB-10), never delete it, fix, re-run.
5. All receipts + red evidence committed to `evidence/`; every child run in a receipt must
   prove model GLM-5.3 (zai) — header with model id, no flash.

**Tests+Gates.** The receipts ARE the gate; plus re-run of both packages' local-ci on the
final merged HEAD.

**Done-when.** Evidence dir holds: bundle grep-assert log, three green drive receipts on the
pinned dir, isolation assertions (scratch + parent clean), model proofs — all committed.

### t06 — close-out

**Goal.** Ledger + findings hygiene.

**Steps.**
1. Fill `mergedPr` for self-arc-24 in `.planning/arc-ledger.json`, set status `done`; update
   this map's `last`/`status` and ticket statuses.
2. Write Loop findings (below) into their durable home; add cross-effort links to the maps
   named below.
3. Confirm `.planning/` committed and pushed to origin/main; sweep branches per devops chain.

**Done-when.** Ledger entry complete; map closed; nothing untracked under this effort folder.

## Loop findings

- **Persistent footer badge for armed effort state** — needs a pi-core/s2-agent-core status
  surface (statusline/bottom bar); ultracode's only persistent surfaces are run-scoped.
  Anchors: `effort-command.ts:66-88` (message only), `workflow-editor.ts:214-261`
  (typing-only highlight). CC ref: TUI digest §5.
- **`/workflows steer <id> <text>` command + navigator row** — the UX half of candidate 5,
  blocked on t04's seam; design sketch: manager registry → command deliver → pending-steer
  indicator in agent detail. CC ref: TUI digest §6.
- **checkpoint `kind:"input"` free-text UX** — if t01's host cannot capture free text, the
  existing human-reply API (`workflow-manager.ts:128`) is the natural carrier; chart with
  t01's probe answer.
- **Main-loop worktree enter/exit tool** (function digest §2), **customizable statusLine
  (JSON-on-stdin)**, **spinner verb line**, **plan-mode ring** — pi-core/s2-agent-core
  surfaces, not ultracode; named here per candidate 6, no ultracode ticket.
- **CC permission-rule machinery** (deny→ask→allow, don't-ask-again persistence — function
  digest §3): ultracode's gate (t02) is a single ask, not a rule engine; a durable
  "don't ask again for ultra-unbounded" preference would ride
  `workflow-settings.ts`-style persistence — charted only.

## Decisions

- **D1 — dialog lives in ultracode, not a new pi-core UI primitive.** The `/workflows`
  navigator proves ext-owned key-handling dialogs work; pi-core surfaces stay charted
  (candidate-6 scope). Reason: smallest blast radius, no core TUI coupling.
- **D2 — pre-flight confirm sits at the tool boundary.** `effort-command.ts:5-11` charted the
  input hook as structurally unable to await; `workflow-tool.ts:539-545` proves the tool path
  can, and :572-576 is where the caps are known. Reason: awaits are possible exactly there.
- **D3 — t04 lands only the plumbing seam.** Full `/workflows steer` is >1 ticket of work;
  the brief mandates seam-only landing with an honest unreachable-exit. Reason: sizing.
- **D4 — timestamps as optional `ts` on `AgentHistoryEntry`.** Repo-owned core-runtime,
  backward-compatible with persisted snapshots; no wrapper type. Reason: cheapest honest
  parity for CC transcript timestamps.
- **D5 — persistent badge charted, not landed** (H3 rejected for arc scope; every always-on
  surface is core-owned). Reason: scope honesty over checkbox parity.

## Frontier

**t01 first** — t02 reuses its dialog primitive; t03/t04 are independent and can interleave
after t01 lands. t05 requires t01–t04 merged; t06 last.

## Fog of war

- Pi ToolContext UI surface beyond `confirm` unprobed (t01 step 1 decides the host).
- Reachability of a steer-capable session handle inside `WorkflowAgent`/`runAgentWithTimeout`
  unprobed (t04 step 1; the unreachable-exit is legitimate).
- Whether every agent-history append site can stamp `ts` from one shared builder or needs
  per-site edits (t03 step 1 finds out).
- Suggested tokenBudget values for choice 2 of the t02 dialog (tune during TUI drive).

## Cross-effort links

- `Builds-on: .planning/2026-08-25-ultracode-cc-parity` (effort tiers + directives, cited at
  `effort-command.ts:23`) — this arc continues that parity thread with fresh digests.
- `Builds-on: self-arc-23 (#2264/#2269)` — core-runtime steering machinery t04 consumes;
  add the back-link to that map at close-out.
- `Shares-decision-with: 2026-09-06 deploy-cache learnings (computeCoreHash /
  workspaceSrcDirs)` — t03/t04 touch an inlined workspace package, making cache correctness
  load-bearing; verify the miss on deploy.

## Execution order

t01 → t02 → (t03 ∥ t04) → t05 → t06. One PR per ticket, squash-merged via the devops chain
(`gh ship`), local CI green = merge (never wait on remote Actions — repo policy).

**Risks.**
- **Deploy cache (learning #1):** t03/t04 change core-runtime, which the bundler inlines —
  if the version dir serves a stale core, the t05 greps fail by design; check the cache
  hashed a miss BEFORE debugging code.
- **Sibling-loop collisions:** `bun-apps/s2-agent-ext-ultracode` is hot (arc-18 via #2237
  last); re-sync origin/main before each PR, keep tickets' file sets disjoint from concurrent
  arcs, prefer landing t01/t02 back-to-back.
- **Dialog-host probe risk (t01):** if neither probe path works, the fallback is
  task-panel key capture; if THAT fails, t01 descope = options-aware confirm message +
  charted select rendering — record the probe evidence either way.
- **GLM-5.3-only discipline:** every child in receipts proves model; flash models invalidate
  the receipt.
