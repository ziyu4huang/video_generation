---
effort: 2026-09-06-agents-manager
created: 2026-09-06
last: 2026-09-06
status: charted
---

# Wayfinder map: 2026-06-agents-manager — `/agents` definition-management dialog

## Destination

The s2-agent TUI manages subagent DEFINITIONS the Claude-Code way: `/agents`
opens a dialog listing every registered agentType (grouped project → user →
pack → builtin) with its description/tools/model/isolation, drills into a
readable detail pane, creates/edits/deletes project + user definitions as
`.pi/agents/*.md` frontmatter files — while builtin/pack rows stay read-only.
The dialog is CC's `/agents` over the registry the runtime already loads
(`core-runtime/agent-registry.ts`, AgentDefinition).

## Context

- The registry is ALREADY CC-shaped (agent-registry.ts): Markdown files under
  `.pi/agents/*.md` (project, cwd-relative) + `~/.pi/agents/*.md` (user),
  frontmatter `name/description/tools/disallowedTools/model/tier/isolation`,
  body = role prompt; precedence project > pack > user > builtin; CC-style
  comma-separated `tools` strings accepted. What does NOT exist: any TUI over
  it (the prior subagent-tui-cc-parity map explicitly deferred this surface),
  and any WRITE path (loadAgentRegistry is read-only).
- The dialog pattern to reuse is proven in-repo: `/subagents` (ext-subagent
  src/subagents-command.ts) — `pi.registerCommand` + `ui.custom` + a stateful
  component with `render(width)/invalidate()/handleInput(data)` + a live
  timer gated on `hasLiveContent()`.
- Prior-wave guardrails that bind: ADR-subagent-0004 (key claims — this
  effort claims NO global key; `/agents` is a command); BUN_PI_SUBAGENT=0
  must disable the command like every other seam of the extension;
  scripts-dir-contract + barrel-surface tests apply to any new file.

## Tickets

**Execution order:** 01 → 02 → 03 (01 read-only dialog lands alone; 02 adds
the write path; 03 wires + receipts).

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-agents-list-dialog.md` | done (branch agents-manager-t01) | `/agents` read-only dialog: grouped list (project/user/pack/builtin), detail pane (frontmatter + prompt body preview), j/k/enter/esc, live-free (static render — no timer) |
| `tickets/02-agents-crud.md` | open | core-runtime `writeAgentDefinition`/`deleteAgentDefinition` (scoped, name-validated, never builtin/pack) + in-dialog create/edit forms + y/N delete confirm |
| `tickets/03-wiring-receipt.md` | open | register the command in ext-subagent, disable-guards, `tui-drive --scenario agents` receipt (dialog opens, lists the seeded agent, edit round-trips) |

## Decisions

- D1 (2026-09-06, autonomous session): the effort was CHARTED autonomously —
  the four confirm-gate questions below are recorded with reasoned DEFAULTS
  that the user can re-decide at the 01 confirm-gate; none block 01.
- D2 (surface shape): a `/agents` COMMAND opening a `ui.custom` dialog —
  NOT a global key (no ADR-0004 exposure) and NOT a slash-flow wizard. CC
  parity shape; cheapest correct thing.
- D3 (data ownership): registry READ stays in core-runtime (existing);
  the WRITE path (write/delete definition files) also lives in core-runtime
  so workflow/gate tooling can reuse it — ext-subagent stays UI-only. Frontmatter
  serialization must round-trip the comma-separated `tools` string form (the
  CC-compat shape ticket 14/decision 09 already accepts).
- D4 (edit UX): in-dialog forms first (CC parity); `$EDITOR` handoff is a
  possible follow-up, not a gate. Delete requires explicit y/N; builtin/pack
  rows render non-selectable actions ("view only").
- D5 (naming): the command is `/agents` (CC vocabulary); no renames of
  existing surfaces.

## Fog of war

- ~~Does pi's command registry allow `/agents`?~~ RESOLVED 2026-09-06: no
  host builtin and no ext claims it — `/agents` registered clean (probe:
  host slash-commands list + repo-wide registerCommand scan).
- Long prompt bodies in the detail pane need scrolling — pi-tui's dialog
  primitives may already provide it (check `@earendil-works/pi-tui` before
  hand-rolling).

## Cross-effort links

Builds-on: `2026-09-06-subagent-tui-cc-parity-2` (this is its ticket 05,
spun off); `archive/2026-08-15-cc-subagent-tui` (surfaces);
ADR-subagent-0004 (keys — untouched). The tui-drive harness
(`--scenario agents`, ticket 03) is the receipt vehicle.
