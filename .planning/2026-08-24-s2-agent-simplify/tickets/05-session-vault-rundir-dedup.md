# 05 — session-tail, vault, run-dir dedup

Phase B · risk LOW · gate: package gates · depends: none (best after 03 for clean diffs)

## Scope

- Move `resolveLLMFromArgs` from cli/sessions/passthrough.ts to cli/sessions/shared.ts (neutral home); update importers (run-agent-session.ts, chat.ts, pdf-to-vault.ts) + passthrough.test.ts path pin.
- Unify runPassthrough (passthrough.ts:106-144) vs runAgentSession (run-agent-session.ts:47-90) shared tail (resolve → createSharedSession → applyDryRun → json/pretty → dispose); printModel (passthrough.ts:85-98) → modelLabel.
- `applyVaultEnv` helper in cli/vault-paths.ts — replaces the 5 resolveVaultPath + OB_VAULT_PATH= + stderr-header boilerplates (zk-extract, zk-ingest, zk-query, memory-to-vault ×2, knowledge-pipeline ×2).
- run-dir: extract the bun-install self-heal block (check-deps.ts:70-88 ≡ deps-probe.ts:174-200; reconcile BUN_PI_AUTO_INSTALL vs PI_AUTO_RESOLVE gating) + workspacePackageNames package-walk (check-deps.ts:95 ≡ patches/ensure-extension-deps.ts:123-133). check-deps.ts PATH stays (run.sh:155 pin).
- Dir walkers: unify ONLY the same-shaped ones (zk-extract.ts:47-54 expandInput, pdf-to-vault.ts:191-201 deletePngs, memory-to-vault-discover) — leave the transcript walk to 03's discover.ts; do not force a generic walker where shapes differ.

## Done-when

Package gates green; passthrough.test updated with the move; no duplicated self-heal block remains; run.sh path untouched.
