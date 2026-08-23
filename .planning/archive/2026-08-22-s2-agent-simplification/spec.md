# Spec: s2-agent simplification (Tier 1 + Tier 2)

Date: 2026-08-22
Scope: `bun-apps/s2-agent` only. Zero behavior change is the hard constraint —
every ticket must preserve observable output (stdout/stderr text, exit codes,
file layouts) unless a ticket explicitly says otherwise.

## Goal

Remove measured duplication and dead machinery from s2-agent (~270 source lines)
without touching the wrapper architecture (patches, run-dir manifest, deploy).

## Non-goals

- No new ADRs; deferred removal decisions live in map.md § Decisions.
- No `*-to-vault` mega-module: pdf-to-vault / memory-to-vault / url-to-vault use
  three genuinely different execution engines (in-process orchestrator /
  workflow fan-out / single agent session).
- Tier 3 (`DEFAULT_MODELS_STORE` → JSON import) charted, not built.
- Keep `manifest-consistency.test.ts`, patch registry shape, and all guard tests.

## Tickets

1. **T1 vault-paths** — extract the 4× byte-identical `resolveVaultPath`
   (zk-ingest / zk-query / zk-extract-as-resolveVault) into
   `src/cli/vault-paths.ts`; add a second exported variant for the two
   ancestor-walk copies (knowledge-pipeline mkdirs after walk, memory-to-vault
   does not). zk-extract keeps its `resolveVault` export name (test imports it).
2. **T2 zk-card via runAgentSession** — extend `RunAgentSessionOptions` with
   `defaultTools?: string[]` (applies the `parsed.tools ?? <default>` rule) and
   `labelPrefix?: string` (reproduces `[zk-card add]  model: …  thinking: …`);
   delete `runKnowledgeTask`.
3. **T3 pipeline-doc** — shared `src/cli/pipeline-doc.ts`: `timestamp()`,
   `iso()`, generic `writePipelineJson<T>`/`readPipelineJson<T>`. pdf-to-vault
   keeps its D5 legacy-stage migration by wrapping `readPipelineJson`;
   `findExistingRun` stays per-command (slug-suffix vs newest-dir matching are
   genuinely different).
4. **T4 one settings reader** — export `readUserSettings` from
   sessions/shared.ts; passthrough's `readUserDefaults` becomes a thin async
   wrapper returning `{provider, model}`. shared.ts already statically imports
   pi-coding-agent, so module-loading behavior cannot change.
5. **T5 NPM_EXTENSIONS retirement** — delete the empty constant + its loops in
   deps-probe.ts; `probeMissingNpm()` goes away; `missingExtensionPackages`
   dedupes only `probeMissingExtensionDeps`; `resolveNpmExtensionPaths` reduces
   to `return []` (export kept — resolve.ts re-exports it). Auto-install +
   guide stay (they serve real transitive extension deps).
6. **T6 lazy-alias shrink** — remove exact/substring match arms over
   `manifest.lazyExtensions` (empty `{}` since ultracode went eager); keep
   `looksLikeAlias`, directory fallback, argv rewrite. Safety: when the parsed
   registry IS non-empty (registry.ts still accepts aliases), warn instead of
   silently ignoring.
7. **T7 stale prose** — fix cli-sh.ts:7 and cli.ts:163 references to the four
   retired legacy deploy modes.

## Verification

- Per ticket: `( cd bun-apps/s2-agent && bun test && bun run typecheck )`
- Guards that must stay green: patch-outcome, manifest-consistency,
  dead-deploy-markers, scripts-dir-contract (devops pkg).
- CLI smoke: `cli list`, headless `-p "reply OK"`.
- Then: devops deploy (`bun run --cwd bun-apps/s2-agent deploy`) and
  verify-deploy-e2e-cli against the deployed tree.
