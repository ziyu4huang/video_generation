# 09 — md cleanup: README slim + ADR INDEX stale-ref fixes

Source: map Phase D extension (user option: slim README + fix stale refs; CONTEXT.md + ADR content otherwise unchanged — repo-mandated). No version bump (no shipped-surface change; `.md` edits do not trip the deploy gate).

## Scope

- **8 × ADR header line 1**: replace the `Index: \`bun-apps/docs/adr/INDEX.md\`` SEGMENT with `Index: repo-root \`CONTEXT-MAP.md\`` — the `Index:` cite shares line 1 with the `**ID:**` pointer, so keep the `**ID:**` segment byte-identical (its header declares "This file is the index"; no INDEX.md exists anywhere — verified 2026-08-25). `bun-apps/tests/adr-citation.test.ts` validates the `**ID:**` line; `test:adr` green is the proof.
- **README.md**: delete the stale Layout tree (`:78-91` — predates the `run-dir → src/run-dir` move #1975, omits run.sh/update-pi.sh/scripts/src members) and replace with a ~6-line map to code headers (run.sh launcher / src/cli.ts entry / src/cli/ namespace / src/patches/ PATCH_TABLE / src/registry-config.ts / CONTEXT.md + docs/adr/). The `:84` INDEX cite disappears with it.
- **README.md `:63` wrong-command fix**: `cli doctor [--smoke]` → `./s2-agent.sh doctor [--smoke] [--json]` (root doctor owns `--smoke` via cli.ts:91; `cli doctor` has `--json`/`--fix` only) — note `cli doctor` as the separate portability check in one clause.
- **`workflows/knowledge-distill.js:25`** comment: nonexistent `../docs/workflow-cli.md` → `./README.md` (its "two runtimes" paragraph documents the boundary).

## Acceptance criteria

- [ ] `bun run test:adr` (from bun-apps/) green
- [ ] grep: zero `INDEX.md` refs in s2-agent md/ADRs after the change
- [ ] local_ci green; PR merged via Linux-box merge policy; reviewer pass; NO version bump
