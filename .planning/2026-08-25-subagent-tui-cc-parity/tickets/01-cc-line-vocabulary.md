# Ticket 01 — CC line vocabulary: agent-first live line + `↳ summary · 34,283 tokens · 2m 13s` settled line

Status: done (2026-08-25 — core-runtime 490/0 + tsc + biome-clean-changed,
ext-subagent canonical 703/0, ext-task 881/0, ext-ultracode 1193/0; viewer
completed rows + output header also moved to fmtDurationHuman for one
vocabulary per settled surface; fmtElapsed kept for ticking surfaces)

## Why

The inline foreground lines are the surface a CC user stares at, and they
read tool-first with machine formatting today (map Context, measured
2026-08-25): live = `spawn_subagent ▸ agent ▸ model ▸ "preview"`
(subagent-tool-render.ts:87-108); settled = `✓ done · model · 45.3s · $0 ·
38211 tok · tags` (settledHeaderRow, subagent-tool-render.ts:119-183) —
raw unseparated token counts, one-decimal-seconds durations, summary last.
CC's equivalents are agent-first (`⏺ Task(agent): description`) and
human-formatted on completion (`  ↳ summary · 34,283 tokens · 2m 13s`).

## Scope

1. **Live call line** (`renderSubagentCall`): reorder to CC shape —
   `Task(<agent or role>): <work intent>` as the head segment; the
   model/tier slot + fallback `modelSeg` become trailing muted segments
   (data preserved, order changed). Tool title `spawn_subagent` demotes to
   a trailing dim segment or drops from the head (it is the pi tool name,
   re-derivable; keep it somewhere for greppability).
2. **Formatting helpers** (`s2-agent-core-runtime/src/agent-row-display.ts`):
   - `fmtTokens(n)` — thousands separators (`34,283`), reused wherever
     tokens render (`tok` → `tokens` wording where the CC-shaped lines use
     it; keep `fmtTokensShort` for compact section rows).
   - `fmtDurationHuman(ms)` — `2m 13s` style (sub-minute stays `45s`,
     sub-second `0.8s`); used by the settled inline line and section rows;
     `fmtElapsed` stays for machine-ish contexts or converts — pick ONE
     home per surface, no mixed vocab on the same line.
3. **Settled line** (`settledHeaderRow` + collapsed branch): reorder to
   `↳ <first-line summary> · 34,283 tokens · 2m 13s` — badge first (keep
   `✓ done` glyph vocabulary), then the width-capped headline, then
   tokens/duration; s2's tags (SDD, scope, budget death/warn, turns) stay
   as trailing warning-tinted segments (D1 — never removed). `$cost`
   segment drops when cost ≡ 0 (this stack) to match CC's lean line.
4. **Tests**: pin the new shapes in subagent-tool-render + agent-row-display
   suites (snapshot-ish string asserts incl. separator + duration cases:
   999/1k/1.2M tokens; 0.8s/45s/2m13s/68m). Existing surfaces that consume
   the helpers (renderRunRow, formatSubagentProgress header) stay
   consistent — one vocabulary per line.

Not in scope: Esc interrupt (t02), keybindings (t03), /subagents viewer
layout, webui surfaces.

## Done-when

- [ ] Live inline line renders `Task(agent): intent …` agent-first with
      model info trailing; no data lost vs today.
- [ ] Settled inline line renders CC-ordered with separator'd tokens +
      human duration; s2 tags retained as trailing segments.
- [ ] s2-agent-core-runtime + s2-agent-ext-subagent + s2-agent-ext-task
      canonical gates green (helper consumers).
- [ ] PR merged CLEAN via the devops chain; map ticket flipped.
