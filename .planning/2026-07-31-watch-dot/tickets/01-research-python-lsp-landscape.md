---
type: research
blocked by: []
status: closed
resolved: 2026-07-31 (framework-level; ⚠ verify before implementation — web_search unavailable)
---

# 01 — Research: Python language-server landscape for L1

## Question

Which Python language server(s) fit the existing JSON-RPC LSP-client pattern in
`src/watchdog/lsp-diagnostics.ts` (`JsonRpcLspClient` — `initialize` /
`textDocument/publishDiagnostics` / `didOpen`+`didSave`), and are appropriate for the
MLX repo (`python/mlx-movie-director/`)?

## Resolution

**⚠️ web_search unavailable** in this env (Zai MCP `-400 search_query cannot be
empty`; Exa 429 free-tier limit; no Brave/Tavily/OpenAI keys). Findings below are
**framework-level** from prior knowledge — **re-verify exact spawn commands, config
mechanism, and defaults against each server's current docs before implementing**
(ticket 02's do/defer should also treat this as a prerequisite).

### Findings (framework-level, verify before impl)

All four candidates conform to the standard LSP flow the existing `JsonRpcLspClient`
already speaks (`initialize` → `initialized` → `didOpen`+`didSave` → wait for
`publishDiagnostics`), so no protocol rewrite is needed — only a new provider entry +
`languageId="python"`.

| Server | Spawn (`--stdio`) | Strengths | Fit for a review GATE |
|---|---|---|---|
| **pyright** | `pyright-langserver --stdio` | Type errors, undefined names, import mistakes — exactly the SDD-style failures the watchdog targets | **Best fit** — highest signal for "catch real errors" |
| **basedpyright** | `basedpyright-langserver --stdio` | Pyright fork, stricter open-source defaults, drop-in LSP | Strong alt — pick if the repo wants stricter defaults out-of-box |
| **ruff** (server) | `ruff server --stdio` (or legacy `ruff-lsp`) | Fast lint (style, imports, bugs) — **not** deep type-checking | Optional 2nd source — different signal from pyright; pairs, not replaces |
| **jedi-language-server** | `jedi-language-server` | Completion/navigation + weak diagnostics | **Too weak** for a review gate — skip |

### Recommendation to feed 02

- **Primary provider: pyright** (or basedpyright) — best matches the watchdog's
  "catch real errors" goal and the existing client. Ruff is a possible **optional
  second source** (lint, lower gate-signal) — could become its own ticket parallel to
  03 (biome-for-TS), not part of 02.
- **Key implementation unknowns (must verify live)**:
  - Exact current spawn command/flags per installed version.
  - **venv / extraPaths config** — the MLX repo uses `python/venv` + sibling-fork deps
    (`../mflux`, `../ltx-2-mlx`); pyright needs `venvPath`/`extraPaths` (via
    `pyrightconfig.json` or pyproject) to resolve them. Confirm the repo's setup.
  - pyright vs basedpyright default strictness — which fits the repo's appetite.

### Outcome for the map

02 (do/defer + mechanism for Python L1) is now **unblocked** — the provider choice is
pyright/basedpyright; the mechanism fork (generalize vs bolt-on) and severity mapping
remain 02's grilling questions. Ruff-as-2nd-source stays in fog (would graduate as a
new ticket if 02 → do with a multi-provider architecture).
