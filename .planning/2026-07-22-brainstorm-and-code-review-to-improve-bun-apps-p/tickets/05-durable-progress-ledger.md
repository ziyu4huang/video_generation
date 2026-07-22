---
type: grilling
status: open
blocked by: [01-survey-subagent-skill-refs]
---

## Question

SDD requires a **durable progress ledger** that survives context compaction (so a controller never re-dispatches a completed task). Where does it live on Pi, what format, and how does it avoid duplicating what pi already has?

Existing pi surfaces to reconcile against:
- `todo` tool — in-session task list (not compaction-durable across sessions the way SDD's `.superpowers/sdd/progress.md` file is).
- `/subagents` — reconstructs past runs from the **session branch** (not a file; gone if the branch is pruned).
- `run-persistence.ts` — the workflow package's existing run-persistence layer (journal for workflow runs; subagent tool runs have "no run identity to control" per `CONTEXT.md`).

Options:
- **A — A file ledger** mirroring SDD: `.pi/subagents/progress.md` (or per-cwd), one line per dispatch (`Task N: complete (commits <base>..<head>)`), read at skill start, appended on review-clean. Survives compaction + session restart.
- **B — Extend `run-persistence.ts`** to give `subagent`-tool runs a durable identity + status, queryable by a new `/subagents` filter or a `subagent_status` helper.
- **C — Reuse the session branch** (what `/subagents` already reads) and just document "trust the branch + `git log`, not your memory" as the SDD-equivalent recovery map.

Decide the home + format, and the read/append contract the driving skill text uses. Ensure it does NOT silently duplicate the workflow journal.

## First takeable step

Sketch the ledger record schema and the two touchpoints (read-at-start, append-on-clean) as a one-page design; confirm it composes with `run-persistence.ts` without a second store.
