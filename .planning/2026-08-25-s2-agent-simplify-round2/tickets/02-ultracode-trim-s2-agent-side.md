# 02 — ultracode disposition: TRIM s2-agent-side surface (map D4, user-confirmed B)

## Scope

Per map D4 (user-confirmed 2026-08-25, option B):
- Remove `src/cli/commands/workflow.ts` (228 LOC) + its test suites (`src/cli/__tests__/workflow.test.ts` 61 LOC, `workflow-command.test.ts` 357 LOC) + the `WORKFLOWS` namespace in `src/cli/dispatch.ts`.
- Remove sample packs `workflows/{echo,args-demo,sample}/` + `knowledge-distill.js` + `workflows/README.md` ONLY IF no surviving consumer — census first: knowledge-distill is user-invocable via the very command being removed and ADR 0003 governs it; if the command goes, the pack + ADR 0003 retire together (record in the ticket). ext-ultracode `tests/workflow-pack.test.ts:530-545,217,405-415` points at echo/args-demo REAL packs — if those tests import from s2-agent/workflows, the packs STAY and only the CLI surface goes.
- Engine package `s2-agent-ext-ultracode` untouched (registry entry, riders, static wiring all stay).
- CONTEXT.md (s2-agent): add the usage-decay + cron-zero receipts and the D4 rationale (map Context "ultracode" section is the source).

## Acceptance criteria

- [ ] Consumer census recorded in the ticket before any deletion (workflow-pack.test.ts dependency resolved)
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; `bun run --cwd bun-apps/s2-agent-ext-ultracode test` green (engine intact)
- [ ] movie-director + tool-gate + flux2 typecheck green (engine importability proven)
- [ ] CONTEXT.md carries the receipts; ADR 0003 verdict recorded if knowledge-distill retires
- [ ] devops local_ci green; PR merged via devops chain; reviewer pass
