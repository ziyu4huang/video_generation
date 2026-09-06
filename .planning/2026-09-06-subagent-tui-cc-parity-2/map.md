---
effort: 2026-09-06-subagent-tui-cc-parity-2
created: 2026-09-06
last: 2026-09-06
status: in-progress
---

# Wayfinder map: 2026-09-06-subagent-tui-cc-parity-2

## Destination

Close the remaining gap between the s2-agent subagent TUI and Claude-Code's,
verified NOT by unit tests alone but by a real-PTY harness (Bun.Terminal) that
drives the deployed TUI like a human and captures screen receipts — the first
leg of the self-evolve loop: develop → deploy → drive (emulated human) → find
issues → develop.

## Context

Prior waves: `archive/2026-08-15-cc-subagent-tui` (surfaces),
`2026-08-25-subagent-tui-cc-parity` (vocabulary: `Task(agent): intent` live
line, `↳ summary · 34,283 tokens · 2m 13s` settled line, Esc interrupt; global
panel key resolved NO-GO — alt+b is taken by `tui.editor.cursorWordLeft`,
ADR-subagent-0004). The always-on aboveEditor progress widget was RETIRED
(extension comment, extensions/subagent.ts:295) — live drill-down is the
inline streaming row (2-line collapsed / 16-line capped expanded) + the
`/subagents` viewer + ext-task's dock section (background runs only).

Measured 2026-09-06 by driving the REAL `./s2-agent.sh` TUI in a
Bun.Terminal PTY (xterm-headless screen decode), dispatching a foreground
subagent:

- Boot renders; DA/kitty queries at startup (`\x1b[c`, `\x1b[?u`) need a
  terminal-side responder in the driver.
- Live inline row exists (`⠋ Working…` spinner, `Tool output: collapsed`).
- ctrl+o expanded live trace is capped at 16 tail lines
  (STREAMING_EXPANDED_TAIL) — small vs CC's full-height live view.
- `/subagents` viewer reachable; list→output/follow flow works.

## Gaps vs Claude Code (ranked)

| # | Gap | CC behavior | s2 today |
|---|---|---|---|
| G1 | Expanded live trace too small | ctrl+o shows a viewport-tall live activity view | 16-line tail cap (flicker-driven) |
| G2 | No per-run elapsed/tokens on the live spinner row | spinner row carries elapsed + token count | elapsed+calls on the 2nd partial line only while streaming; spinner row is bare |
| G3 | Parallel foreground runs stack verbose rows | each Task row stays one live line | each run streams 2+ lines; N runs = wall of partials |
| G4 | Batch tool settled vocabulary (fog-of-war from prior map) | — | `subagents` batch slots still `45.3s · 38211 tok` old vocab |
| G5 | No /agents definition-manager dialog | interactive agent CRUD | `/agents` intentionally NOT charted (prior map) — still open |
| G6 | ctrl+o discoverability | hint "(ctrl+o to expand)" on live agent rows | pi's top hint bar mentions ctrl+o globally, not per-row |

## Scope decision (2026-09-06, autonomous session)

User's first goal: "improve the subagent TUI, close to Claude-Code's TUI
experience". Tickets 01–03 below are this session's implementation scope;
05 (/agents manager) is charted but OUT of session scope (big surface —
needs its own effort with confirm-gates). 04 is the harness that must exist
first for the loop (self-evolve vehicle).

## Tickets

**Execution order:** 01 → 02 → 03 (01 is pure render-layer; 02 depends on
01's row shape; 03 is the harness receipt run).

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-taller-live-trace.md` | done | Streaming-expanded (ctrl+o) live trace grows from a fixed 16-line tail to a viewport-aware tail (clamp(rows−14, 8, 28), unknown rows → 16) via `viewportTraceTail`/`currentTerminalRows` in core-runtime; BOTH capped surfaces adopted it; height-stability rule intact (#1104). Unit-tested (agent-trace-viewport.test.ts) |
| `tickets/02-live-row-meta.md` | done | Collapsed live row's meta line now ends `· ctrl+o to expand` (display seam only — formatSubagentProgress untouched, <60 cols suppressed, expanded never repeats it). CONFIRMED LIVE in real-pty receipt: `↳ 8.1s elapsed · 2 tool calls · ctrl+o to expand` |
| `tickets/03-batch-settled-vocab.md` | done | formatSlotMeta/formatUsage/settled header now CC order `model · 34,283 tokens · 2m 13s · $X` (cost only non-zero); LIVE surfaces + model-facing renderBatchResult keep fmtElapsed; 20+ pinned assertions updated — 88/88 green |
| `tickets/04-pty-harness.md` | done | scripts/tui-drive.ts: Bun.Terminal pty driver + xterm-headless decode + DA responder + snapshot-on-change + receipt.json checks; allowlisted; xterm-headless devDep. Receipt (changed tree, zai/glm-5.3): liveRow ✓ expandHint ✓ settledBadge ✓ viewerOpened ✓ modelIsGlm ✓ |
| `tickets/05-agents-manager.md` | open | `/agents` definition-management dialog (list/create/edit/delete agent presets) — big surface, own effort, confirm-gates required |

## Decisions

- D1 (2026-09-06): verification vehicle is a Bun.Terminal PTY driver +
  xterm-headless screen decode — NOT tmux/script — per user direction
  ("entire self-evolve pipeline we use Bun.Terminal() api to emulate human
  operate s2-agent"). Bun ≥1.3.5 required (repo pins bun 1.4.0 ✓).
  Practical lessons: XTerm must be fed in small awaited chunks (64B; large
  single writes stall the WriteBuffer in Bun), answer primary DA
  (`\x1b[?1;2c`), stay silent on kitty `\x1b[?u`, TERM=xterm-256color
  (inherited TERM=dumb silently disables the TUI).
- D2 (2026-09-06): model policy for the loop = pure zai GLM — main
  `zai/glm-5.3`, subagent floor/vision `zai/glm-5.3-flash` (catalog has no
  literal "GLM3"; glm-5.3-flash is the vision-capable flash model,
  input:[text,image]). ZAI_API_KEY lives in ~/.zshrc on this machine — the
  harness parses it at runtime; without it the TUI silently falls back to
  lm-studio (observed: gemma-4-12b answered a dispatch prompt, then died
  `Error: Model unloaded.` mid-run).
- D3 (2026-09-06): the flicker rule (height-stable expanded box) is
  load-bearing (#1104) — ticket 01 changes the CAP POLICY, not the
  stability rule; the cap may vary with terminal height but must not vary
  per tick.
- D4 (2026-09-06): parallel-run parity is one-live-line-per-run (G3) —
  details stay behind ctrl+o / /subagents, matching CC's information
  gradient (row → expanded → panel).
- D5 (2026-09-06, session-scope): tickets 01–04 implemented THIS session
  autonomously; ticket 05 (/agents manager) charted-only. Changes left
  UNCOMMITTED on the worktree (vgpu-labs-demo branch carries unrelated
  work; committing/branching waits for the user per harness rules).

## Fog of war

- ~~Whether pi's composer streams partial tool rows through a per-second
  re-render or per-event~~ — RESOLVED by receipt: partials stream per-event;
  the meta line's elapsed ticks with each event (per-second re-render only
  inside the /subagents viewer).
- ~~`ZAI_API_KEY` rotation/death — silent lm-studio fallback~~ — receipt now
  records the status-bar model line and asserts it (`modelIsGlm` check);
  fallback path OBSERVED (gemma runs before the key was wired) and it dies
  mid-run with `Error: Model unloaded.` when the local model evicts.
- The live call line's requested-model slot renders `default` mid-run even
  when an explicit model resolves (observed `▸ default ▸ glm-5.3 ▸` on one
  named-agent dispatch, correct `▸ glm-5.3 ▸` on others) — the modelSeg
  segment reaches the SETTLED row but not always the LIVE call line's slot.
  Candidate next ticket; needs subagent-tool.ts call-render seam reading.
- The parent'sglm-5.3 reasoning prose streams visibly into the transcript
  before the tool call (pi renders thinking as plain paragraphs) — CC shows
  a spinner instead. Host-level behavior (pi-tui), out of ext-subagent's
  reach; noting for a future host effort.
- Harness receipts #1/#2 taught: settle-detection must match ONLY live
  signals (spinner/`Working…`/`esc to interrupt`) — transcript text persists
  forever; and the expand probe must KEEP the view expanded (a young child
  has an empty trace at probe time).

## Cross-effort links

Builds-on: `2026-08-25-subagent-tui-cc-parity` (vocabulary + no-go keys),
`archive/2026-08-15-cc-subagent-tui` (surfaces). Shares-decision-with:
ADR-subagent-0004 (key claims — untouched here), #1104 flicker rule
(respected by ticket 01).
