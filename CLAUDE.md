# CLAUDE.md

Guidance for Claude Code in this repository.

## Communication

- **Reply language**: forced by `responseLanguage` in `~/.pi/agent/settings.json` (zh-TW), changeable live via `/response-language [tag]`. See `~/.pi/agent/AGENTS.md`.
- **Written output**: English — docs, code comments, commits, file content.

## Active stack

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, native MLX)
- **Bun GUI** — `bun-apps/gui-movie-director` (`bun run dev`; per-worktree port via `bun run gui:port`)
- **Embedding server** — `swift/embed-mlx-server` (Swift MLX, BGE-M3, OpenAI-compatible `/v1/embeddings`); installs a LaunchAgent holding port 8090 — if that port is busy or a stray embed process runs, check `scripts/embed-mlx-server-service.sh status` first.

## Repo mechanics

- **Bun workspace**: root is `bun-apps/` (isolated linker + globalStore via `bun-apps/bunfig.toml`); `bun-apps/bun.lock` canonical. `bun install` from `bun-apps/` only; never commit `package-lock.json`; deps via `bun add` inside `bun-apps/`.
- **Python**: `python/venv/bin/python python/mlx-movie-director/run.py <args>` from repo root only — never system `python3`/`python3.13`. Fresh clone: `bash scripts/setup-offline.sh` (or `uv venv python/venv --python 3.12 && uv pip install -r python/mlx-movie-director/requirements.txt`). Sibling forks `../mflux`, `../ltx-2-mlx` via `scripts/setup-repo-deps.sh`.
- **Shell**: never top-level `cd` (`no-cd-drift.sh` blocks it) — use `( cd <dir> && ... )`, `--cwd`/`-C`, or absolute paths.
- **Platform**: Apple Silicon MPS only, SDPA (no CUDA attention); MLX dtypes `bfloat16` native, quantize `mlx-8bit` (default) or 4-bit; no FP8.
- **GUI**: `( cd bun-apps/gui-movie-director && bun run dev )`; URL via `bun run --cwd bun-apps/gui-movie-director gui:port`; kill stuck server `lsof -ti :<port> | xargs kill -9`; fresh clone `bash scripts/setup.sh`.

## run.py

`python/venv/bin/python python/mlx-movie-director/run.py <cmd>`:

```
image [t2i|angle|review|profile|controlnet|i2i|faceswap|swap|anime2real|quality|workflow|expansion|purify|restore]
video [generate|review|compare|quality|restore|vbvr|relay|segment|t2i2v]
caption <image>   replay <manifest>   upscale   check-model
schema            schema-defaults
```

Self-test `--self-test [t2i:portrait]`; `--offline` for zero network egress.

## Testing

```bash
( cd bun-apps/<pkg> && bun test )                                        # any bun-apps/*
bun run --cwd bun-apps/gui-movie-director check:schema                  # validate vs run.py
( cd bun-apps/pi-agent-ext-workflow && bun run test )
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests [--run-gpu]
```

**Per-package gates differ.** `pi-agent-ext-hermes-memory` `bun run check` = tsc; `pi-agent-ext-wayfind` `bun run check` = biome (tsc lives in `typecheck`, not under `check`/`test`) → for wayfind run **both** `bun run check && bun run typecheck && bun test`. Always run a package's canonical `bun run test` script (it may include `build`), not a hand-assembled subset. `local_ci` resolves both by script NAME per package (tsc: `typecheck` → `check`-if-tsc; biome: `check`-if-biome → `lint`-if-biome), so a package that renames them is silently skipped — `tests/lint-executor-coverage.test.ts` + `tests/extension-entry-typechecked.test.ts` block that.

## Subagent dispatch

**Watchdog off for write-heavy implementer dispatches** (default: omit it) — on multi-session worktrees L1 commit-scope flags ancestor `origin/main` files as out-of-scope and L2 review returned zero actionable findings across the 10-impl SDD cycle; the independent reviewer subagent is the real quality gate. Reserve watchdog for read-only verification.

## Planning artifacts (standing rule)

`.planning/` artifacts are durable, shared planning — MUST be committed and pushed to `origin/main`: effort folders (`.planning/<effort>/` incl. `map.md`, `spec.md`, `tickets/`, `plans/`, `brainstorm/`, `sdd/`), plus `.planning/specs/` and `.planning/plans/`. Never leave a new `.planning/<effort>/` untracked — `.gitignore` already encodes this. Carve-outs (do NOT commit): per-filename transient scratch (`task_plan.md`, `progress.md`, `findings.md`) and the flat no-effort `.planning/sdd/` fallback dir.

## DevOps (standing rule)

All git sync / branch prep / rebase / PR merge / local CI / branch sweep / post-run review goes through the devops tool chain (`sync_default_branch`, `prepare_feature_branch`, `run_local_ci`, `merge_pr_after_local_ci`, `verify_merge_landed`, `sweep_merged_branches`, `run_devops_retrospect`) per `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md` — never hand-rolled raw-bash git/gh subagents for phases a devops tool owns. Plain `pi` sessions: CLI fallbacks under `bun-apps/pi-agent-ext-devops/src/*-cli.ts` (`sync-default-branch-cli`, `main-health-cli`, `sweep-merged-branches-cli`, `local-ci-cli`, `prepare-feature-branch-cli`, `verify-merge-cli`, `merge-pr-after-ci-cli`; all take `--help`, emit JSON, exit 0/1/2). Sync example (plain session): `bun bun-apps/pi-agent-ext-devops/src/sync-default-branch-cli.ts`. "Is main itself green?" → `main-health-cli.ts` (`run_local_ci` is change-scoped). Prefer the pi-agent wrapper `bun bun-apps/pi-agent/src/cli.ts` (auto-loads run-dir extensions and skills).
  - Self-improve drift report: `./pi-agent.sh cli loop status` (report-only: death rate, skill lines, duplicates, canary, coverage).

## Key Directories

```
python/mlx-movie-director/    # ACTIVE — MLX pipeline
mlx-models/                   # MLX model tree (override: MLX_MODELS_DIR / --models-dir)
../video_generation__models/  # EXTERNAL binary store (outside repo)
bun-apps/gui-movie-director/  # ACTIVE — Bun + React GUI
```

## Extension packages (pi-agent-ext-*)

- **Scaffold a new package**: `bun bun-apps/pi-agent/src/cli.ts ext new <name>` (`--lib` for a `src/index.ts` lib face + shim entry; `--register dynamic|static|none`, default dynamic — static auto-runs `bun run regen:static`; add `--no-install` to skip `bun install`). Then implement — every convention below (entry path, self-gate, tsconfig include, scripts, peer pin) is baked into the output.
One registered entry per folder: `extensions/<X>.ts` where `<X>` = folder minus `pi-agent-ext-` — never `src/index.ts`, root `index.ts`, `extensions/index.ts`, or `extensions/pi-<X>.ts` as the registration entry.

- **Lib entry stays separate**: src-entry (`main: "./src/index.ts"`) is the standard lib face (web-access uses root `index.ts`) — don't move it. If the registration entry has no in-file implementation (power-tool, hermes-memory), add a 1-line re-export shim `export { default } from "../src/index.ts";` at `extensions/<X>.ts`.
- **Registration**: dynamic → `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]`); always-on/static → `bun-apps/pi-agent/src/static-extensions.ts`; never both (double-register).
- **Schema-cost canary**: `bun-apps/pi-agent/src/cli/commands/schema-cost.ts` `discoverExtensionEntries()` derives from manifest.json — registered extensions measured automatically; only unregistered measure-worthy files need a manual `EXTRA_ENTRIES` row.
- **CLI subcommands**: `extensions/cli-subcommand.ts`, wired in `bun-apps/pi-agent/src/cli/extensions/registry.ts`.

## Vendor patches

ltx-2-mlx / mflux patches live in `python/mlx-movie-director/app/vendor_patches.py` — never edit vendor submodules directly; add via `_patch_*()` → `apply_all_patches()`.

## Agent skills

- **Issues**: GitHub Issues (`ziyu4huang/video_generation`) via `gh` — see `docs/agents/issue-tracker.md`.
- **Domain docs**: each domain owns `CONTEXT.md` + `docs/adr/`; root `CONTEXT-MAP.md` lists contexts — see `docs/agents/domain.md`. Cite ADRs as `ADR-<context>-NNNN`, never bare numbers (contexts number independently — bare 0001 names seven documents). `bun-apps/docs/adr/INDEX.md` lists all; `bun run test:adr` (from `bun-apps/`) blocks unresolved citations.
