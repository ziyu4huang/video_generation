# 10 — misc stale/dead surface: output receipts + dispatch-log trim

Source: map Phase D extension. Deletion-with-equivalence-proof per candidate (map D5), never bulk.

## Scope

- **output receipts**: `git rm` `output/kcard-extract/run-extract-2026-08-25*.json` (2 files, 13 LOC each — runtime receipts tracked by accident). Proof recorded in-ticket: zero readers repo-wide (grep census 2026-08-25; only the writer names the dir — ext-knowledge-card `src/extract.ts:489,691`, default `<cwd>/output/kcard-extract`, whose own comment says "D30 — gitignored"; its tests use mkdtemp); `.gitignore:126 output/` already matches the path (`git check-ignore --no-index` receipt) — files bypassed it only because they were tracked. NO .gitignore edit.
- **dispatch-log trim** (command stays LIVE — taught at `s2-agent-ext-superpowers/skills/dispatching-parallel-agents/SKILL.md:98`): drop the `"workflow"` half of the `engine` union (no producer can emit it — the CLI workflow namespace died in ticket 02) + its column, the `--effort`/`--tier` filter paths (manual records are always stamped `effort:"unknown"`/`tier:"unknown"` ⇒ any `--effort <name>` query permanently exits 1 — dead path), and the NOT-YET-WIRED prose (`:10-11`, `:112-115`, `:129-132`); rewrite header to "manual dispatch archive query". Keep `normalizeSubagentRecord` / `matchesDispatchFilter` / `renderDispatchLog` + the `--outcome` filter. Update `dispatch-log.test.ts` to the surviving seam assertions (status→outcome mapping + death-rate render cover the seam). Trim command-scoped rows in `flag-spec.ts`/`args.ts`. Sync the SKILL.md line to the manual-only truth (one line; upstream fixture copy stays verbatim-vendor). Check `bun-apps/tests/dead-export.test.ts` — orphaned exports get DELETED, not allowlisted.
- **completions inline split: DEFERRED by decision D8** — no edit (circular-import constraint documented at completions.ts:11-15 / dispatch.ts:434-435; META vs META_COMMANDS deliberately differ; `e2e/meta.e2e.test.ts` pins output).

## Acceptance criteria

- [ ] per-deletion equivalence proofs recorded in-ticket (D5)
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` AND ext-superpowers `bun run check && bun run typecheck && bun test` green
- [ ] bun-apps contract suite green (dead-export, dep-guard, adr-citation, isolation); local_ci green; PR merged via Linux-box merge policy; reviewer pass; `--patch` bump
