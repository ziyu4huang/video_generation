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

- [ ] `grep -rln "bun-apps/docs/adr/INDEX.md" bun-apps` returns 0 (receipt)
- [ ] `bun run test:adr` (from bun-apps/) green — the citation guard must accept the new pointer
- [ ] No version bumps; merged via devops chain; reviewer pass
