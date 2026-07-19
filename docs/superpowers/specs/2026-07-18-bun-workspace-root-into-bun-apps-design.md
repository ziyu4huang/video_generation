# Move the Bun workspace root into `bun-apps/`

**Date:** 2026-07-18
**Status:** Approved (approach A) — implementation in progress
**Branch:** `video_generation__workflow_pack`

## Goal

Relocate every Bun/Node artifact so that `bun-apps/` is the JS workspace root.
The repository root should hold no JavaScript tooling — `bun-apps/` becomes
name-and-fact the root of the JS world, matching how the directory is already
used.

## Background

Today the Bun workspace root lives at the repository root:

- `package.json` — `"workspaces": ["bun-apps/*"]`, sole devDep `@types/bun`
- `bunfig.toml` — `linker = "isolated"` + `globalStore`
- `bun.lock` — canonical lockfile (~159 KB)
- `pi-agent.sh` — symlink → `./bun-apps/pi-agent/run.sh` (unaffected)

All 23 workspace packages live under `bun-apps/`. Nothing outside `bun-apps/`
(with the unrelated exception of `vaults_root/study-news/`, a separate project)
consumes Bun.

## Design

### File moves (via `git mv` to preserve history)

```
package.json  → bun-apps/package.json   (workspaces field edited)
bunfig.toml   → bun-apps/bunfig.toml    (content unchanged)
bun.lock      → bun-apps/bun.lock       (content unchanged)
```

### `bun-apps/package.json`

`"workspaces"` changes from `["bun-apps/*"]` to `["./*"]` — the workspace root
is now inside `bun-apps/`, so its members are its direct subdirectories.

Everything else in `bunfig.toml` is location-independent (`linker`, `globalStore`
govern the global store, not the workspace root path). `bun-apps/node_modules`
becomes the workspace-level `node_modules` (covered by the existing global
`node_modules` gitignore line).

### Unaffected

- `pi-agent.sh` root symlink — points at a path inside `bun-apps/`, unchanged.
- `bun-apps/gui-movie-director/bunfig.toml` — a sub-package's own config.
- `vaults_root/study-news/{package.json,bun.lock}` — separate project.

## Call-site updates

Every site that runs `bun install` or reads `bun.lock` from the repository root
is repointed at `bun-apps/`. The repo enforces no-top-level-`cd`, so updates use
`--cwd bun-apps` or `( cd bun-apps && ... )`.

| File | Change |
|---|---|
| `bun-apps/pi-agent/update-pi.sh` | `$REPO_ROOT/bun.lock` → `$REPO_ROOT/bun-apps/bun.lock` (lockfile_versions, `[[ -f ... ]]` gate, final `git diff bun.lock`); `bun install --cwd "$REPO_ROOT"` → `--cwd "$REPO_ROOT/bun-apps"`; the pre-flight `git diff` pathspec becomes `bun-apps/bun.lock bun-apps/package.json bun-apps/*/package.json` |
| `scripts/check-lockfile-duplicate-versions.sh` | `LOCKFILE="bun.lock"` → `"bun-apps/bun.lock"` (script runs from repo root) |
| `scripts/verify-deploy.sh` | `bun install` (at REPO_ROOT) → `bun install --cwd bun-apps` |
| `.github/actions/setup-env/action.yml` | cache key `hashFiles('bun.lock')` → `hashFiles('bun-apps/bun.lock')`; Install step gains `working-directory: bun-apps`; comment "root bunfig.toml" → "`bun-apps/bunfig.toml`" |
| `.github/workflows/ci.yml` | comment accuracy only (lockfile hoist description) — no behavioral change |
| `.github/CI.md` | local re-run instructions: `bun install --frozen-lockfile` → run from `bun-apps/` |
| `CLAUDE.md` | Monorepo SOP: note workspace root is `bun-apps/`; `bunfig.toml`/`bun.lock` now there |
| `bun-apps/pi-agent/README.md` | "at the monorepo root (never inside pi-agent/)" → "at `bun-apps/`" |

Comment-only mentions of `bun.lock` as a concept (e.g. `run.sh`, `PRD.md`, the
two `*.mjs` research scripts that cite `bun.lock` as an example entity) are
path-agnostic and left untouched. The `update-pi.sh` `pinned_versions` glob
`bun-apps/*/package.json` still matches all sub-packages (the moved
`bun-apps/package.json` is not in a subdirectory and declares none of the 4 pi
core packages).

## Verification (acceptance criteria)

1. `( cd bun-apps && bun install --frozen-lockfile )` succeeds and writes no
   lockfile at the repository root.
2. Repository root is clean of JS tooling:
   `test ! -e package.json && test ! -e bun.lock && test ! -e bunfig.toml`.
3. `bash scripts/check-lockfile-duplicate-versions.sh` exits 0.
4. `bun-apps/pi-agent/update-pi.sh --lockstep` finds the lockfile and exits 0.
5. `bash scripts/verify-deploy.sh --no-deploy` passes (install + tests + bundles).
6. CI `setup-env` cache key resolves against `bun-apps/bun.lock`; the frozen
   install runs inside `bun-apps/`.
7. A full-repo grep for `bun\.lock`/`bunfig` in tracked shell/TS/YAML/MD turns
   up no remaining root-relative path references.

## Risks

- **Missed reference** → a script or CI step looks for `bun.lock` at the root
  and fails. Mitigation: post-move grep sweep (criterion 7).
- **`bun install` accidentally run at the new root** creates an orphan lockfile.
  Mitigation: docs call out `bun-apps/` as the install directory; no `package.json`
  exists at the root to anchor an install there.
- **CI cache miss spike** after the key change — one-time, expected.

## Out of scope

- `vaults_root/study-news/` — separate project, untouched.
- Any restructuring of the 23 workspace packages themselves.
