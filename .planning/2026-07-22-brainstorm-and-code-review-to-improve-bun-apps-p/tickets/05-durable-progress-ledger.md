---
type: grilling
status: closed
claimed: work-session-2026-07-22
blocked by: [01-survey-subagent-skill-refs]  <!-- 01 closed → unblocked -->
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

## Resolution

Grilled (1 decision) + glue drafted. This is a decision ticket — the ledger is AGENT-driven (the SDD controller reads/appends it via bash/read/write), so the workflow package needs NO runtime code for it; the implementation is the pi-tools.md glue (ticket 11) + the file-handoff helpers (ticket 06).

**Decision — location: redirect to `.planning/<effort>/sdd/`** (NOT the byte-identical `.superpowers/sdd/`). The whole SDD workspace — task briefs, implementer reports, review packages, AND the progress ledger — lives under the effort directory, co-located with the wayfinder map/tickets/plan. Rationale (user's): honor the `.planning/<effort>/` artifact-location preference literally, even for scratch, so an effort's SDD runtime artifacts sit beside its planning docs.

**Consequence — the byte-identical `sdd-workspace` script + the SDD skill body's `.superpowers/sdd/progress.md` path are NOT used on pi.** The pi-tools.md glue redirects the controller to `.planning/<effort>/sdd/`. (The skill body + script stay byte-identical/untouched; only the glue — the sanctioned pi-port exception — carries the redirect.)

**Format — append-only markdown, SDD-parity.** One line per task, appended on review-clean:
```
# SDD progress — <effort-slug>

Task 1: complete (commits abc1234..def5678, review clean)
Task 2: complete (commits def5678..789abcd, review clean)
```
Read at SDD start: tasks marked complete are DONE — do not re-dispatch (the compaction-recovery contract). The commit range is the recovery map: trust the ledger + `git log` over recollection.

**Grain — task-keyed, complement to ticket 08 (NOT a duplicate).** The ledger is TASK-keyed (controller-maintained, compaction recovery); the persisted subagent runs (08) are DISPATCH-keyed (tool-maintained, replay). A task spans multiple dispatches (implementer + reviewer + fix); the ledger rolls them up to a task verdict.

**Delivery — pi-tools.md glue convention (ticket 11 commits it), no new tool.** Drafted glue text (drop-in for ticket 11):
> **SDD progress ledger (pi):** the byte-identical SDD skill + `sdd-workspace` script reference `.superpowers/sdd/`. On pi, redirect ALL of that to `.planning/<effort>/sdd/` — task briefs (`briefs/`), implementer reports (`reports/`), review packages (`reviews/`), and the progress ledger (`progress.md`). Derive `<effort>` from the plan path you are executing (`.planning/<effort>/plans/<plan>.md`). `mkdir -p .planning/<effort>/sdd/{briefs,reports,reviews}`; append one line to `progress.md` per task on review-clean; read it at SDD start to skip completed tasks. This is gitignored-runtime-scratch co-located with the effort's planning docs.

**No workflow-package code change for the ledger itself** (agent-driven). Tickets 06 (helpers) and 11 (glue commit) carry the implementation; this ticket hands them the location decision.

**Graduated / noted:** whether the workspace should be auto-provisioned by a pi-native helper (vs the controller `mkdir`-ing via bash) is a ticket-06 question. The ledger format is settled.

**Delivery upgrade — IMPLEMENTED in the superpowers extension (not deferred to ticket 11).** The redirect is now LIVE via the sanctioned runtime-override mechanism, not just a pi-tools.md convention: `src/superpowers.ts` `piBoundaryOverrides()` gained **rule 3 (SDD workspace override)** — `.superpowers/sdd/` → `.planning/<effort>/sdd/` — injected into EVERY session's bootstrap context (the same mechanism rules 1–2 already use for spec/plan homes, ADR-0004-safe: only the wrapper code changed, the 14 byte-identical SKILL.md + scripts are untouched, fidelity guard still green). `skills/using-superpowers/references/pi-tools.md` gained a matching human-readable section; `tests/bootstrap.test.ts` locks rule 3 in. This is stronger than the pi-tools.md-only plan: the agent sees the override every session/compaction without reading a reference doc. **Ticket 11's ledger scope is satisfied by this**; 11 retains the parallel/status/helpers/public-API glue.
