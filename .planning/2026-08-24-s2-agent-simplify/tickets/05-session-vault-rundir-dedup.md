# 05 — session-tail, vault, run-dir dedup

Phase B · risk LOW · gate: package gates · depends: none (best after 03 for clean diffs)

## Receipt (2026-08-24)

Implemented on branch `s2-agent-simplify-t05-session-vault-rundir`. 20 modified + 2 new files (cli/walk.ts, run-dir/workspace-packages.ts).

- resolveLLMFromArgs + readUserDefaults moved passthrough→shared (bodies verbatim; all importers updated directly — no compat re-export left); passthrough.test pins updated.
- Shared tail runSessionTurn in run-agent-session.ts; runPassthrough/runAgentSession are wrappers. One flagged micro-delta: runPassthrough now disposes in finally (old code leaked the in-memory session on thrown turn errors). Output bytes identical both modes.
- printModel NOT merged into modelLabel — deliberately: modelLabel's fallback is the resolved-args pair, printModel reports the session-RESOLVED pair (observable for shorthand `--model sonnet` via resolveModel's substring lane). Reviewer verified the argument.
- vault-paths.ts is the sole OB_VAULT_* home: applyVaultEnv (raw) + applyResolvedVaultEnv (resolved; vaultDir opt-in reconciles t01's zk-extract inline). All 6 HEAD write sites mapped 1:1, final env byte-identical; per-site stderr headers intentionally not folded (byte differences).
- runBunInstall extracted in deps-probe; gating NOT unified (check-deps opt-out default-install vs maybeAutoInstall opt-in — provably opposite intents; only the spawn shared). workspacePackages (node-builtins only) replaces both package walks. check-deps.ts path + exit contract unchanged (run.sh pin).
- walkFiles used by zk-extract expandInput + pdf-to-vault deletePngs; memory-to-vault discovery left alone (single-level + filters — genuinely different shape). deletePngs tightened to regular files only (fifo/socket impossible in stage-1 output).
- Gates: tsc clean; bun test 1070 pass / 0 fail. Reviewer READY (all HEAD sites mapped 1:1; find-table zero blocking).

## Scope

- Move `resolveLLMFromArgs` from cli/sessions/passthrough.ts to cli/sessions/shared.ts (neutral home); update importers (run-agent-session.ts, chat.ts, pdf-to-vault.ts) + passthrough.test.ts path pin.
- Unify runPassthrough (passthrough.ts:106-144) vs runAgentSession (run-agent-session.ts:47-90) shared tail (resolve → createSharedSession → applyDryRun → json/pretty → dispose); printModel (passthrough.ts:85-98) → modelLabel.
- `applyVaultEnv` helper in cli/vault-paths.ts — replaces the 5 resolveVaultPath + OB_VAULT_PATH= + stderr-header boilerplates (zk-extract, zk-ingest, zk-query, memory-to-vault ×2, knowledge-pipeline ×2).
- run-dir: extract the bun-install self-heal block (check-deps.ts:70-88 ≡ deps-probe.ts:174-200; reconcile BUN_PI_AUTO_INSTALL vs PI_AUTO_RESOLVE gating) + workspacePackageNames package-walk (check-deps.ts:95 ≡ patches/ensure-extension-deps.ts:123-133). check-deps.ts PATH stays (run.sh:155 pin).
- Dir walkers: unify ONLY the same-shaped ones (zk-extract.ts:47-54 expandInput, pdf-to-vault.ts:191-201 deletePngs, memory-to-vault-discover) — leave the transcript walk to 03's discover.ts; do not force a generic walker where shapes differ.

## Done-when

Package gates green; passthrough.test updated with the move; no duplicated self-heal block remains; run.sh path untouched.
