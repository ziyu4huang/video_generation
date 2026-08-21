# CLAUDE.md

Guidance for Claude Code in this repository.

## Communication

Reply language: force-controlled by `responseLanguage` in `~/.pi/agent/settings.json` (live via `/response-language [tag]`). Written artifacts always English: code, comments, commits, docs, config.

## Active stack

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, native MLX)
- **Bun GUI** — `bun-apps/gui-movie-director`: `( cd bun-apps/gui-movie-director && bun run dev )`; per-worktree port via `bun run gui:port`; kill stuck server `lsof -ti :<port> | xargs kill -9`; fresh clone `bash scripts/setup.sh`
- **Embedding server** — `swift/embed-mlx-server` (Swift MLX, BGE-M3, OpenAI-compatible `/v1/embeddings`); LaunchAgent on port 8090 — busy port or stray embed process → `scripts/embed-mlx-server-service.sh status` first
- **MLX models** — `mlx-models/` (override `MLX_MODELS_DIR` / `--models-dir`); external binary store `../video_generation__models/` lives outside the repo

## Repo mechanics

- **Bun workspace**: root is `bun-apps/` (isolated linker + globalStore via `bun-apps/bunfig.toml`). `bun install` from `bun-apps/` ONLY; deps via `bun add` inside it; `bun-apps/bun.lock` canonical — never commit `package-lock.json`.
- **Python**: `python/venv/bin/python` from repo root ONLY — never system `python3`/`python3.13`. Fresh clone: `bash scripts/setup-offline.sh` (or `uv venv python/venv --python 3.12 && uv pip install -r python/mlx-movie-director/requirements.txt`); sibling forks `../mflux`, `../ltx-2-mlx` via `scripts/setup-repo-deps.sh`.
- **Shell**: never top-level `cd` — use `( cd <dir> && ... )`, `--cwd`/`-C`, or absolute paths.
- **Platform**: Apple Silicon MPS only, SDPA (no CUDA attention); MLX dtypes `bfloat16` native, quantize `mlx-8bit` (default) or 4-bit; no FP8.

## run.py

`python/venv/bin/python python/mlx-movie-director/run.py <cmd>` — `image …` / `video …` subcommand trees plus `caption`, `replay`, `upscale`, `check-model`, `schema`, `schema-defaults` (`--help` for the full tree). `--self-test [t2i:portrait]`; `--offline` = zero network egress.

## Testing

```bash
( cd bun-apps/<pkg> && bun test )                          # any bun-apps/*
bun run --cwd bun-apps/gui-movie-director check:schema     # validate vs run.py
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests [--run-gpu]
```

Always run a package's canonical `bun run test` (may include `build`), not a hand-assembled subset. Gates differ per package: `s2-agent-ext-wayfind` → `bun run check && bun run typecheck && bun test` (`check` = biome; tsc lives in `typecheck`); `s2-agent-ext-hermes-memory` `check` = tsc. `local_ci` resolves gates by script NAME per package — renamed scripts are silently skipped (blocked by `tests/lint-executor-coverage.test.ts` + `tests/extension-entry-typechecked.test.ts`).

## Subagent dispatch

Watchdog OFF (omit it) for write-heavy implementer dispatches — on multi-session worktrees L1 commit-scope flags ancestor `origin/main` files as out-of-scope, and the independent reviewer subagent is the real quality gate. Reserve watchdog for read-only verification.

## Planning artifacts

`.planning/` is durable shared planning — MUST be committed and pushed to `origin/main`: effort folders (`.planning/<effort>/` incl. `map.md`, `spec.md`, `tickets/`, `plans/`, `brainstorm/`, `sdd/`) plus `.planning/specs/` and `.planning/plans/`; never leave a new `.planning/<effort>/` untracked (`.gitignore` encodes this). Do NOT commit: per-filename transient scratch (`task_plan.md`, `progress.md`, `findings.md`) and the flat no-effort `.planning/sdd/` fallback dir.

## DevOps

All git sync / branch prep / rebase / PR merge / local CI / branch sweep / post-run review goes through the devops tool chain per `bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md` — never hand-rolled raw-bash git/gh subagents for phases a devops tool owns. Plain-session CLI fallbacks: `bun-apps/s2-agent-ext-devops/src/*-cli.ts` (sync-default-branch, prepare-feature-branch, local-ci, merge-pr-after-ci, verify-merge, sweep-merged-branches, main-health; all `--help`, JSON, exit 0/1/2) — prefer the s2-agent wrapper `bun bun-apps/s2-agent/src/cli.ts` (auto-loads run-dir extensions and skills). "Is main itself green?" → `main-health-cli.ts` (`run_local_ci` is change-scoped). Drift report: `./s2-agent.sh cli loop status`.

## Extension packages (s2-agent-ext-*)

s2-agent = renamed pi-agent (2026-08-21; upstream `@earendil-works/pi-*` deps, `PI_*` env names, `~/.pi/agent` state dir, and `./pi-agent.sh` compat alias unchanged by design) — history: `docs/agents/extension-naming.md`.

- **Scaffold**: `bun bun-apps/s2-agent/src/cli.ts ext new <name>` (`--lib` lib face + shim; `--register dynamic|static|none`, default dynamic — static auto-runs `regen:static`; `--no-install` skips `bun install`). All conventions below are baked into the scaffold output.
- **Entry**: ONE registered entry per folder — `extensions/<X>.ts` (`<X>` = folder minus `s2-agent-ext-`); never `src/index.ts`, root `index.ts`, `extensions/index.ts`, or `extensions/pi-<X>.ts`.
- **Lib entry stays separate**: `main: "./src/index.ts"` is the lib face (web-access uses root `index.ts`); if the registration entry has no in-file implementation (power-tool, hermes-memory), add shim `export { default } from "../src/index.ts";`.
- **Registration**: ONE entry in `bun-apps/s2-agent/s2-agent.registry.yaml` (`load: dynamic` or `static` — never both), then `bun run --cwd bun-apps/s2-agent regen:manifest` (+ `regen:static` for static). `run-dir/manifest.json` is DERIVED (freshness-gated — never hand-edit).
- **Schema-cost canary**: `discoverExtensionEntries()` in `bun-apps/s2-agent/src/cli/commands/schema-cost.ts` derives from manifest.json — registered extensions are measured automatically; only unregistered measure-worthy files need a manual `EXTRA_ENTRIES` row.
- **CLI subcommands**: `extensions/cli-subcommand.ts`, wired in `bun-apps/s2-agent/src/cli/extensions/registry.ts`.

## Vendor patches

ltx-2-mlx / mflux patches live in `python/mlx-movie-director/app/vendor_patches.py` — never edit vendor submodules directly; add via `_patch_*()` → `apply_all_patches()`.

## Agent skills

- **Issues**: GitHub Issues (`ziyu4huang/video_generation`) via `gh` — see `docs/agents/issue-tracker.md`.
- **Domain docs**: each domain owns `CONTEXT.md` + `docs/adr/` (root `CONTEXT-MAP.md` lists contexts; see `docs/agents/domain.md`). Cite ADRs as `ADR-<context>-NNNN`, never bare numbers — contexts number independently. Index: `bun-apps/docs/adr/INDEX.md`; `bun run test:adr` (from `bun-apps/`) blocks unresolved citations.
