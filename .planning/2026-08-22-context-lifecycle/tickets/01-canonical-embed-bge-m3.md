# 01 — canonical embed: BGE-M3 on LM Studio :1234

- **Phase:** P0 · **Package:** `s2-agent-core-interface` (+ docs in hermes/CLAUDE.md) · **Status:** open

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
