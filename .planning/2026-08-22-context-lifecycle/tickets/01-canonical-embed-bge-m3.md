# 01 — canonical embed: BGE-M3 on LM Studio :1234

- **Phase:** P0 · **Package:** `s2-agent-core-interface` (+ docs in hermes/CLAUDE.md) · **Status:** closed

## Resolution (2026-08-22)

- `SEMANTIC_MODEL_DEFAULT` → `text-embedding-bge-m3`; new
  `SEMANTIC_EMBED_BASE_DEFAULT` (`http://127.0.0.1:1234`) +
  `resolveSemanticEmbedConfig(env)` (env precedence `SEMANTIC_EMBED_MODEL` /
  `SEMANTIC_EMBED_BASE` > legacy `LMSTUDIO_BASE_URL` baseUrl alias > defaults) —
  exported from `embedding-leaf.ts` / `src/index.ts`; 4 resolver tests added
  (`tests/embedding-leaf.test.ts`).
- kcard `src/semantic.ts` resolves base via the leaf (no local env read); hermes
  `constants.ts` `DEFAULT_EMBED_MODEL` → bge-m3, `DEFAULT_EMBED_MODEL_VERSION` →
  `bge-m3+es1`; hardcoded nomic defaults replaced in `composition/tools.ts`
  (→ `config.embedModel ?? bge-m3`) and `store/semantic-search.ts:305`
  (→ `DEFAULT_EMBED_MODEL`); doc comments aligned (types.ts,
  knowledge-search-tool.ts, retrieve.ts, knowledge-card.ts).
- Docs: CLAUDE.md embedding line rewritten (canonical :1234/bge-m3, :8090 =
  fallback endpoint); hermes PRD's "OPEN: model pick may be revisited" marked
  RESOLVED — the prior embed-bench already showed bge-m3 recall@1 0.909 vs
  nomic 0.864, which settles the fork in D3's favor beyond the CJK reasoning.
- Live probe receipt (2026-08-22): `POST :1234/v1/embeddings` model
  `text-embedding-bge-m3` → 1024-dim vectors.
- Gates: core-interface 41 pass; kcard 479 pass + `tsc --noEmit` clean;
  hermes 1639 pass. Remaining nomic mentions in `bun-apps` non-test source are
  historical comments / recorded-fallback notes only.


## Problem

Three "embedding sources of truth" are in play: runtime LM Studio `:1234` (nomic default in
`embedding-leaf.ts`), documented `embed-mlx-server :8090` BGE-M3 (CLAUDE.md; audit read it
as dead because `/v1/models` 404s while `/v1/embeddings` is alive — probe 2026-08-22), and
vault-mind's own MiniLM. Hermes `constants.ts` names a different endpoint than what serves.
D3 (spec §3) settles this: one canonical endpoint+model.

## Approach

1. `bun-apps/s2-agent-core-interface/src/embedding-leaf.ts`:
   `SEMANTIC_MODEL_DEFAULT` → `text-embedding-bge-m3`; thread
   `SEMANTIC_EMBED_BASE` / `SEMANTIC_EMBED_MODEL` env overrides through
   `DefaultEmbedderOptions` resolution (single resolution point, callers pass nothing).
2. Align hermes constants + CLAUDE.md + any doc naming an embed URL to the canonical
   `:1234` / `text-embedding-bge-m3`; `:8090` documented as the fallback endpoint only.
3. Note (no code): kcard cache `<vault>/.knowledge-semantic/nomic….json` becomes stale by
   disuse — pruning happens in ticket 07's re-baseline, not here.

## Acceptance

- `grep -rn "nomic\|127.0.0.1:8090\|localhost:8090" bun-apps --include="*.ts"` shows zero
  canonical-default references outside tests/fixtures and the fallback doc note.
- `lmStudioAvailable` probe test green; env-override test added (base + model).
- All consumer packages (`knowledge-card`, `hermes-memory`, `obsidian` if any) typecheck
  and pass their canonical `bun run test`.

## Verification

`bun run --cwd bun-apps/s2-agent-core-interface test` + consumer package tests + a one-line
live probe (curl `:1234/v1/embeddings` with `text-embedding-bge-m3`) recorded in the PR body.
