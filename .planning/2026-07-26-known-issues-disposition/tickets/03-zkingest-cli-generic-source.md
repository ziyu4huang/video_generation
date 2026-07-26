---
type: grilling
blocked by: []
status: open
---

# 03 — zk-ingest CLI --source generic surface gap

## Question

The `zk_ingest` **tool** and `host-fns` accept `source: "generic"` (the universal
adapter for an arbitrary `.md` folder), but the **`zk-ingest` CLI**'s
`KNOWN_SOURCES` omits it → the CLI refuses `--source generic` with an EXPLICIT
error (not a silent mis-parse). It's a surface gap only.

**Decision: fix / accept?**

- If **fix** (likely): add `"generic"` to the CLI's source set, align help text +
  the error message. Likely a 1-liner + help. One PR (test: CLI accepts
  `--source generic` and routes to the generic adapter the same way the tool
  does).
- If **accept**: rationale (e.g., the CLI intentionally narrows the surface?).

## Read first

- The CLI entry / arg-parse + `KNOWN_SOURCES` definition (likely in
  `pi-agent-ext-knowledge-card` CLI, or `extensions/cli-subcommand.ts`).
- The tool's `source` handling + `host-fns` generic support, to confirm parity is
  the goal.
