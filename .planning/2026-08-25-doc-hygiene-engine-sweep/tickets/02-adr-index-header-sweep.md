# 02 — ADR Index header sweep: 35 stale `bun-apps/docs/adr/INDEX.md` pointers

Source: round-2 t09 reviewer measurement + map Context (35 files / 9 packages).

## Scope

Line-1 replacement in every ADR that still carries the nonexistent
`Index: bun-apps/docs/adr/INDEX.md`:

```
Index: bun-apps/docs/adr/INDEX.md  →  Index: repo-root `CONTEXT-MAP.md`
```

(byte-identical to the t09/#2034 precedent in s2-agent's 8 ADRs)

Packages: s2-agent-ext-subagent (9), -superpowers (7), -wayfind (6),
-tool-gate (5), -ultracode (4), s2-agent-core-runtime (1), -archify (1),
-hermes-memory (1), -task (1). Re-grep at execution time — other sessions
may have fixed some (verify count before editing).

## Acceptance criteria

- [x] `grep -rln "bun-apps/docs/adr/INDEX.md" bun-apps` returns 0 (receipt)
- [x] `bun run test:adr` (from bun-apps/) green — the citation guard must accept the new pointer
- [x] No version bumps; merged via devops chain; reviewer pass (PR #2045, reviewer READY 0 blockers)

## Outcome (2026-08-25)

- Re-grep at execution: count still 35 (no sibling fixes) — subagent 9,
  superpowers 7, wayfind 6, tool-gate 5, ultracode 4, core-runtime/archify/
  hermes-memory/task 1 each; 35/35 replaced, residual grep = 0.
- NOTE: the actual on-disk form was backticked (`Index: \`bun-apps/…\``) —
  the ticket's Scope block showed it unbackticked; replacement used the t09
  byte-identical precedent `Index: repo-root \`CONTEXT-MAP.md\``.
- `bun run test:adr` 17/17 green; format byte-identical to s2-agent's 8
  (head -1 comparison receipt). No version bumps.
