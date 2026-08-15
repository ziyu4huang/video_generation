## Question

Where should the `/response-language` command live, given we don't want a one-command standalone package?

type: grilling
status: closed

## Resolution

**Merge into `pi-agent-ext-core-task`.** Chosen over three alternatives considered in the destination grill:

- **power-tool (the original proposal)** — rejected. power-tool is a *diagnostics* suite (`inspect_*` + pathology) that is currently **tools-only** (zero commands), and its own PRD celebrates a 2026-07 split that *removed* mixed concerns (core-task, ask-user, btw were extracted). Merging an unrelated end-user locale command back in re-opens that wound.
- **Keep standalone** — rejected by the user's stated preference (avoid a one-command package).
- **pi-agent core (colocate with the patch)** — rejected. Conceptually cleanest, but pi-agent has **no `registerCommand` path** in `src/` (only patches live there); it would need patch-hack plumbing. Mechanically weakest.

core-task wins because it (a) already registers slash commands (`/goal`, `/todos`, `/list`, `/loop`) following a clean per-feature-dir pattern, (b) already accepts self-contained commands "purely for entry-point consolidation" — the `ask-user` merge is the documented precedent in `extensions/core-task.ts`, and (c) honors the goal without re-muddying power-tool's freshly-focused diagnostics domain.
