status: closed (2026-09-08, PR with the arc's implementation)

# t01 — migrate-in-parallel sample + unit gate

- [x] `samples/cc-parity/migrate-in-parallel.js`: meta block (cc-parity B3,
      workflows doc example prompt "migrate many files in parallel");
      `args.files` (array of {from,to,content-shape}); `phase("Migrate")` =
      `parallel()` N× `agent(MIGRATE_PROMPT, {label, phase, isolation:"worktree"})`;
      `phase("Integrate")` = synthesizer agent reads results, reports counts.
- [x] Unit gate `tests/cc-parity-migrate.test.ts`:
      base = mkdtemp git repo (init + one commit); 3 parallel "migrators";
      recording writer fake runner (writes `<cwd>/migrated-<i>.txt`, reads back,
      records {cwd, content}); asserts: 3 distinct cwds OUTSIDE base +
      under base/.pi/worktrees/; base tree has zero migrated files; results in
      input order; tokenUsage summed.
- [x] Suite passes LLM-free; `bun run typecheck` clean.
