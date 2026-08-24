# 02 — ultracode disposition: TRIM s2-agent-side surface (map D4, user-confirmed B)

## Scope

Per map D4 (user-confirmed 2026-08-25, option B):
- Remove `src/cli/commands/workflow.ts` (228 LOC) + its test suites (`src/cli/__tests__/workflow.test.ts` 61 LOC, `workflow-command.test.ts` 357 LOC) + the `WORKFLOWS` namespace in `src/cli/dispatch.ts`.
- Remove sample packs `workflows/{echo,args-demo,sample}/` + `knowledge-distill.js` + `workflows/README.md` ONLY IF no surviving consumer — census first: knowledge-distill is user-invocable via the very command being removed and ADR 0003 governs it; if the command goes, the pack + ADR 0003 retire together (record in the ticket). ext-ultracode `tests/workflow-pack.test.ts:530-545,217,405-415` points at echo/args-demo REAL packs — if those tests import from s2-agent/workflows, the packs STAY and only the CLI surface goes.
- Engine package `s2-agent-ext-ultracode` untouched (registry entry, riders, static wiring all stay).
- CONTEXT.md (s2-agent): add the usage-decay + cron-zero receipts and the D4 rationale (map Context "ultracode" section is the source).

## Outcome (2026-08-25)

- **Consumer census verdict: packs STAY, only the CLI surface goes.** ext-ultracode `tests/workflow-pack.test.ts` hard-depends on the REAL `bun-apps/s2-agent/workflows/` packs (args-demo dry-run/parallel runs at :408, :532, :556-577). knowledge-distill.js STAYS — its own header says it lives in the ENGINE dir on purpose, the interactive `workflow` tool still resolves packs by name, and ADR 0003 still governs it (no retirement).
- Removed: `src/cli/commands/workflow.ts` (228 LOC), `src/cli/__tests__/workflow.test.ts` (61) + `workflow-command.test.ts` (357), WORKFLOWS group + namespace dispatch + help sections in `dispatch.ts`, `WORKFLOW_SUBCOMMANDS` + all completion rows in `completions.ts` (bash/zsh/fish), flag rows `--args`/`--out-dir`/`--no-persist-logs` + ParsedArgs fields `workflowArgs`/`outDir`/`noPersistLogs` (zero external consumers — grep-proven), workflow rows in `dispatch-errors.e2e.test.ts`, stale mentions in agent.ts help + shared.ts comment.
- Behavior delta (flagged): `workflow` as a first token is no longer reserved — it now falls through to passthrough like any unknown word (documented in dispatch-errors.e2e.test.ts header + CONTEXT.md term).
- CONTEXT.md: "Workflow CLI surface (removed)" term with the full usage receipts.

## Acceptance criteria

- [x] Consumer census recorded in the ticket before any deletion (workflow-pack.test.ts dependency resolved)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; `bun run --cwd bun-apps/s2-agent-ext-ultracode test` green (engine intact) (1021 + 1178 pass / 0 fail)
- [x] movie-director + tool-gate + flux2 typecheck green (engine importability proven)
- [x] CONTEXT.md carries the receipts; ADR 0003 verdict recorded (knowledge-distill STAYS)
- [ ] devops local_ci green; PR merged via devops chain; reviewer pass
