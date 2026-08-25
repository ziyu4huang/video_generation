---
effort: 2026-08-25-subagent-tui-cc-parity
created: 2026-08-25
last: 2026-08-25
status: complete
---

# Wayfinder map: 2026-08-25-subagent-tui-cc-parity

## Destination

The s2-agent subagent TUI reads like Claude-Code's to a user who switches
between the two: the inline live line is agent-first with the work intent,
the completion line is `↳ summary · 34,283 tokens · 2m 13s` (separator'd
tokens, human duration, summary-first), Esc interrupts a running foreground
subagent, and the background-agents surface is reachable the CC way. s2-agent
keeps its richer data (SDD/scope/budget tags, trace, dock) — parity is in
shape and vocabulary, not a data regression.

## Context

Measured 2026-08-25 on this machine, after the prior wave
(`archive/2026-08-15-cc-subagent-tui`, COMPLETE — 8 tickets #1410–#1441:
subagents section, notify, RunView tokens/cost, detach, dock):

- Inline live call line (foreground): `spawn_subagent ▸ <agent> ▸ <model
  slot> ▸ "<task preview>"` — tool-title-first, agent second
  (`subagent-tool-render.ts:87-108`, renderSubagentCall).
- Streaming partial: `↳ <last activity>\n  ↳ <N.Ns> elapsed · N tool calls`
  (`agent-trace-display.ts`, formatSubagentProgress) — collapsed keeps 2
  lines, expanded adds the paired trace tail.
- Settled line: `<badge> <model> · <N.Ns> · $<cost> · <N> tok · <tags>`
  + width-capped headline (`subagent-tool-render.ts:119-183`,
  settledHeaderRow; `agent-row-display.ts:141` fmtElapsed = one-decimal
  seconds always; tokens render raw, e.g. `38211 tok` — no separators).
- Background section rows: `<badge><glyph> <actor> · modelSeg · $cost ·
  elapsed · N calls — latestAction` (`agent-row-display.ts:150-169`
  renderRunRow, consumed by `s2-agent-ext-task/src/subagents/subagents-section.ts`),
  dock keymap j/k/x/e/ctrl+b/⏎/esc (DOCK_HINT_LINE, subagents-section.ts:46).
- Keys: global detach = **alt+s** (ctrl+b collides with pi's
  `tui.editor.cursorLeft`; ctrl+shift+b dead on non-Kitty terminals —
  `ctrl-b.ts:33-60`, ADR-subagent-0004, guard test
  `s2-agent/src/__tests__/extension-shortcut-guard.test.ts`); ctrl+b acts
  only inside the `/subagents` viewer / dock as detach-focused.
- Esc at charting time: no display-surface interrupt for a FOREGROUND run
  was known; t02's investigation found pi's `app.interrupt` (Esc) already
  aborts the streaming turn and fans into the child — the gap was only the
  settle status (Esc'd run misbadged `timedout`; fixed in child-dispatch,
  PR #2027).

CC reference behavior (this harness, observed first-hand 2026-08-25): live
`⏺ Task(<agent>): <description>` with spinner word; completion `  ↳ <result
summary> · 34,283 tokens · 2m 13s`; Esc interrupts the running agent;
Ctrl+B opens the background-agents panel; Ctrl+O expands; `/agents` manages
definitions.

## Tickets

**Execution order:** 01 → 02 → 03 (user-confirmed 2026-08-25 via the
confirm-gate: "確認 3 張全做"; no blocking edges).

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-cc-line-vocabulary.md` | done (PR #2025, 2026-08-25) | Inline line vocabulary: `Task(agent): intent` live shape + `↳ summary · 34,283 tokens · 2m 13s` settled shape (fmtTokens separator'd, fmtDuration human m+s, summary-first ordering; keep s2 tags as trailing segments) |
| `tickets/02-esc-interrupt.md` | done (PR #2027 merged CLEAN, 2026-08-25 — investigation found pi's `app.interrupt` ALREADY binds Esc → `agent.abort()` → childAc fan-in; the real gap was the settle status misreading an Esc'd run as `timedout`, fixed in child-dispatch) | Esc during a running foreground subagent aborts it (input seam investigation: onTerminalInput vs pi interrupt semantics; must not steal Esc from the editor when no subagent runs) |
| `tickets/03-ctrl-b-panel.md` | done (2026-08-25 — recorded NO-GO: alt+b measured as a `tui.editor.cursorWordLeft` default, the exact ADR-subagent-0004 conflict class; user chose no new key at the second confirm-gate) | CC-parity panel-opener key — first directed alt+b (D4), then resolved as a documented no-go (D5): background surface stays reachable via `ctrl+g s` + `/subagents`; ADR-subagent-0004 amendment records the measurement + the free alt-key space |

## Decisions

- D1 (2026-08-25, charting): parity is SHAPE + VOCABULARY (agent-first live
  line, separator'd tokens, human duration, summary-first completion, Esc
  interrupt, Ctrl+B panel); s2-agent's extra data (SDD/scope/budget tags,
  trace expand, dock actions) stays as trailing segments, never removed.
  Reason: the ask is "make it similar to Claude-Code", not "make it
  identical" — the tags are load-bearing for this repo's dispatch protocol.
- D2 (2026-08-25, charting): ticket 01 (pure render vocabulary) lands first —
  zero input-seam risk, immediately visible; 02/03 each touch the input layer
  and land behind it.
- D3 (2026-08-25, confirm-gate): all three tickets in scope, order 01 → 02 →
  03 (user chose "確認 3 張全做").
- D4 (2026-08-25, confirm-gate): the CC Ctrl+B panel-opener maps to **alt+b**
  on s2-agent — the user chose it over reclaiming ctrl+b (which collides
  with pi's `tui.editor.cursorLeft`, ADR-subagent-0004). alt+s detach is
  unchanged; the panel target is the existing dock//subagents surface, not a
  new widget. **SUPERSEDED by D5** — the "alt+b is free" premise was wrong.
- D5 (2026-08-25, second confirm-gate): **no global panel-opener key** —
  alt+b is one of `tui.editor.cursorWordLeft`'s defaults (measured in the
  pi-tui dist), so registering it re-creates the ADR-subagent-0004 startup-warning
  failure the repo already rejected. The background surface stays reachable
  via `ctrl+g s` (dock claim, runs-gated) and `/subagents`. Measured free
  alt+<letter> space recorded in the ADR amendment (built-ins claim only
  b/d/f/y among letters — alt+v is win32-only — plus non-letters, and the
  repo's own alt+s; alt+p is the clean future candidate).

## Frontier

None — the queue is drained (t01 #2025, t02 #2027, t03 as a documented
no-go in #2039). The loop ends here per queue-drain termination; remaining
fog items are parked records, not open work.

## Fog of war

- Batch `subagents` tool settled surfaces (subagents-tool.ts:906, 1003,
  1137 — formatSlotMeta/formatUsage) still render the OLD vocabulary
  (`45.3s · 38211 tok`) on the same composer surface as t01's new one —
  no same-line mixing (the rule as written holds) but a transcript with
  both tools shows both vocabularies (t01 review nit 5). Fold the batch
  meta into the CC vocabulary in a later ticket or t02/t03's PR if
  trivially cheap.

- ~~Exact Esc ownership in pi while a foreground tool call streams~~ —
  RESOLVED 2026-08-25 (ticket 02 investigation): `app.interrupt` defaults to
  `escape` (core/keybindings.js:7) and the editor's `onEscape` calls
  `agent.abort()` while streaming (interactive-mode.js:2219); the hint
  "(esc to interrupt)" already renders in the working status indicator
  (:1741). The ticket's own key-claim design was dropped as a collision; the
  shipped fix is the settle-status correction (Esc'd run → `aborted`, was
  misread `timedout`).
- ~~Whether Ctrl+B-as-panel is claimable globally~~ — RESOLVED, twice:
  D4's alt+b direction was DISPROVED by measurement (alt+b is a
  `tui.editor.cursorWordLeft` default) and D5 records the no-go (no global
  panel key; `ctrl+g s` + `/subagents` remain the access paths; see the
  ADR-subagent-0004 amendment for the measured free alt+letter space).
- `/agents` definition-management parity: intentionally NOT charted (big
  surface, orthogonal to display vocabulary); revisit if the user asks.
- CC's live spinner words (Deliberating / Reading files…) vs s2's
  last-activity phrase: close enough that no ticket is charted; fold into
  ticket 01 only if trivially cheap.

## Cross-effort links

Builds-on: `archive/2026-08-15-cc-subagent-tui` (the prior COMPLETE wave —
its surfaces are the substrate this effort re-vocabularies; cite its ADR
map before touching keys). Shares-decision-with:
`2026-08-15-subagent-dynamic-budgets` (the settled-line budget tags this
effort must keep rendering — its D1 cache-aware accounting shows up in the
`⛔ budget kind:actual/limit` segment this effort re-orders but keeps).
