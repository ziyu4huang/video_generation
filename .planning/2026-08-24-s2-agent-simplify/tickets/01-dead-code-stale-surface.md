# 01 — dead code & stale surface

Phase A · risk LOW · gate: package gates + help-pin e2e

## Scope

Remove (each verified before deleting):

- package.json `verify` script (target src/__tests__/e2e-extensions.test.ts deleted).
- cli/commands/sessions.ts: `--cwd` advertised in help but never parsed — drop the help lines + any `(parsed as any).cwd` reads. (Feature never worked; unknown-flag skipper swallowed it.)
- cli/commands/chat.ts:93: dead `sessionManager: … : undefined` ternary + `opts.persist` plumbing (smallest honest fix — drop dead opts; real persistence semantics stay in Fog of war).
- cli/flag-spec.ts: `blend` row (zero readers). KEEP `save` (web-access reads it — map D4).
- cli/commands/sessions.ts:43 searchSessions + memory.ts:35 searchMemory unexport (exported "for unit tests" that don't exist).
- cli/commands/schema-cost.ts:60-63 @deprecated delegates (inline into their test or remove).
- cli/sessions/shared.ts: SharedServices.model dead field (always undefined).
- cli/commands/image-to-vault.ts:57-77 delegated-ParsedArgs ceremony → direct `pdfToVaultCommand.run(parsed)` call.
- cli/commands/zk-extract.ts:118+121 double OB_VAULT_PATH set.
- patches/index.ts:262-263 double `break;`.
- `.agents/` empty dir (gitignore if untracked).
- cli/commands/dispatch-log.ts normalizeWorkflowRun + PersistedRunState import (test-only) — remove with its test assertions.
- src/run-dir/workflows/{ltx-live-e2e.js,parallel-demo.js} — re-verify zero refs (incl. .planning receipts) then delete.

Fix:

- ext-doctor.ts:90-100: honor its own comment — manifest read failure surfaces instead of swallowing to `{extensions:[], lazyExtensions:{}}`. Behavior change in an error path — flag in PR.
- patches/index.ts:65 stale "Must run AFTER ensure-extension-deps" comment (verified false: top-level static import of getAgentDir resolves at load).

Keep (cheap, deliberate): `oneshot` legacy alias (dispatch.ts), webuiFlags().rest (cli-argv.ts).

## Done-when

Package gates green; help-pin e2e green; `(parsed as any)` census across bun-apps recorded in this ticket (input to 04); PR merged via devops chain.
