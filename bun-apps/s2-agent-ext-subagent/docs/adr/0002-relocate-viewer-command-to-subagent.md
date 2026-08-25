**ID:** `ADR-subagent-0002` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# 0002 — Relocate the `/subagents` viewer + command into this package

**Status:** accepted (2026-07-25; PR #821 — subagent TUI relocation)

**Supersedes:** the "Why `subagent-viewer` and `subagents-command` stayed in
workflow" section of [ADR-0001](./0001-why-extracted.md).

## Context

ADR-0001 left the `/subagents` interactive TUI viewer (`subagent-viewer.ts`),
the `/subagents` slash command (`subagents-command.ts`), and the
`subagent-progress-widget` in `s2-agent-ext-workflow`. The blocker was a
dependency cycle: the viewer imported rendering helpers from workflow's
`display.ts`, and `display.ts` imported `WorkflowMeta` from `workflow.ts`.
Moving the viewer into `s2-agent-ext-subagent` would have dragged `display.ts`
along, and `display.ts ⟹ workflow.ts` would have pulled the workflow engine
back in — re-creating the monolith with a cycle.

## Decision

**Move the viewer, command, and progress-widget into `s2-agent-ext-subagent`,
and break the cycle by extracting the generic agent-row rendering helpers into
a subagent-local module.**

Concretely:

- The generic helpers (`renderActivityRow`, `activityGlyph`, `shorten`,
  `fmtCost`, `fmtTokensShort`, `preview`, `shortModel`, `ActivityRow`) were
  **extracted out of workflow's `display.ts`** into a new
  `src/agent-row-display.ts` **in this package**.
- `subagent-viewer.ts`, `subagents-command.ts`, and `subagent-progress-widget.ts`
  were **moved into this package's `src/`**. The viewer now imports its render
  helpers from the local `./agent-row-display.js` — no `display.ts`, no
  `workflow.ts`, no cycle.
- Workflow's `display.ts` **re-exports** the generic helpers (re-imported from
  this package) so its own existing consumers (`task-panel`, `workflow-ui`,
  `workflow-manager`) keep resolving via `./display.js` unchanged. It retains
  only workflow-specific types (`WorkflowMeta`, `WorkflowAgentSnapshot`).

The remaining `display.ts ⟹ ./workflow.js` import in workflow's `display.ts` is
**intentional and contained**: `display.ts` is now a workflow-internal re-export
hub, and nothing in `s2-agent-ext-subagent` imports it.

## Consequences

- **The `/subagents` TUI is self-contained in this package.** A host that loads
  only `s2-agent-ext-subagent` gets working tools AND the viewer/command — no
  workflow dependency.
- **The dependency direction is unchanged:** workflow depends on subagent (for
  the runner, the singletons, and now the render helpers) — not the reverse.
  No new edge.
- **The singletons are now intra-package.** With the viewer relocated, the two
  singletons (`getSubagentInFlightRegistry` / `getSubagentRunPersistence`) have
  **no peer-extension callers** — every caller is in this package (the tool's
  extension + the viewer), all via the in-package relative import. The `src/`
  subpath rule from ADR-0001 is retained as **forward-compat advice** for any
  future peer extension that wants to observe runs directly (none do today).
- **One new rule:** subagent-local render helpers live in `src/agent-row-display.ts`;
  workflow-specific display types stay in workflow's `display.ts`. Don't re-fuse them.
  *(Superseded 2026-08 by #1251, which extracted `@repo/s2-agent-core-runtime`: the
  render helpers moved there as `s2-agent-core-runtime/src/agent-row-display.ts`.
  The rule still holds — they stay out of workflow's `display.ts` — but the home is
  now core-runtime, not this package.)*
