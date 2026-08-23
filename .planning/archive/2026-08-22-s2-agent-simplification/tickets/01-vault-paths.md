# T1 — shared vault-path resolvers

New `src/cli/vault-paths.ts`:

- `resolveVaultPath(parsed, cwd, { defaultDir = "vault" })` — the 4-copy body:
  `--vault`/`OB_VAULT_PATH` → `--vault-dir`/`OB_VAULT_DIR`/default, mkdir-if-missing.
- `resolveVaultPathWalkUp(parsed, cwd, { defaultDir, mkdirIfMissing })` — ancestor
  walk (≤10 levels) for the convergence-sink flavor.

Adopt in:

- `zk-ingest.ts:37-48` — delete local fn.
- `zk-query.ts:40-51` — delete local fn.
- `zk-extract.ts:80-91` — replace body with re-export keeping the name
  `resolveVault` (its test imports it).
- `knowledge-pipeline.ts:41-62` — walkUp + `mkdirIfMissing: true`.
- `memory-to-vault.ts:121-134` — walkUp + no mkdir.

**Verify**: `( cd bun-apps/s2-agent && bun test src/cli/__tests__/zk-extract.test.ts )`,
then full suite + typecheck.

Status: **closed**
