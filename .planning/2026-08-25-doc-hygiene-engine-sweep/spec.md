# Spec — doc-hygiene engine sweep

Scope: documentation and comments ONLY. No runtime code changes, no schema
changes, no version bumps. If a site turns out to be live code (an argv that
actually passes `-e workflow`), STOP and record it in the ticket — that is a
bug, not a doc fix, and needs its own treatment.

## Invariants

1. Every statement about how a workflow pack is reached matches reality:
   exactly ONE entry path (the `workflow` tool's `name` param; the extension
   is static-loaded/built-in).
2. No live doc teaches `-e workflow` / `-e ultracode` / `cli workflow run`.
3. ADR line-1 Index pointers name an existing file (repo-root `CONTEXT-MAP.md`).
4. `bun run test:adr` (from bun-apps/) stays green; touched packages' canonical
   `bun run test` stays green (docs ride along, nothing pins the old prose —
   verify per package if a test fails).

## Verification

- Repo-wide grep receipts (before/after counts) recorded in each ticket.
- Ticket 01: `grep -rn "cli workflow" bun-apps --include="*.md" --include="*.ts" --include="*.js"`
  returns zero live-doc hits (`.planning/` excluded as dated snapshots).
- Ticket 02: `grep -rln "bun-apps/docs/adr/INDEX.md" bun-apps` returns 0.
