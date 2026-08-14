# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — MLX on Apple Silicon

## Communication

- **Reply language**: force-controlled by `responseLanguage` in `~/.pi/agent/settings.json` (zh-TW) — injected into every session's system prompt; change it live via `/response-language [tag]` (e.g. `/response-language en`). See `~/.pi/agent/AGENTS.md`.
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Active stack

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, all native MLX)
- **Bun GUI** — `bun-apps/gui-movie-director` (`bun run dev`; per-worktree port via `bun run gui:port`)
- **Embedding server** — `swift/embed-mlx-server` (Swift MLX, BGE-M3, OpenAI-compatible `/v1/embeddings`). Installs a **LaunchAgent holding port 8090** — if that port is busy or a stray embed process is running, check `scripts/embed-mlx-server-service.sh status` first. See its README.

## Monorepo SOP

Bun workspace root is `bun-apps/` (isolated linker + globalStore via `bun-apps/bunfig.toml`); `bun-apps/bun.lock` is canonical. Run `bun install` from `bun-apps/`, never the repo root. Never commit `package-lock.json`. Add deps with `bun add` (inside `bun-apps/`).

## Python venv

```bash
python/venv/bin/python python/mlx-movie-director/run.py <args>
```
Invoke from repo root only. Never use system `python3` / `python3.13`. Setup via `bash scripts/setup-offline.sh` (fresh clone), or `uv venv python/venv --python 3.12 && uv pip install -r python/mlx-movie-director/requirements.txt`.

Sibling-fork deps: `../mflux` (Z-Image), `../ltx-2-mlx` (LTX video). Installed by `scripts/setup-repo-deps.sh`.

## Shell discipline

Never top-level `cd` — `no-cd-drift.sh` blocks it. Use `( cd <dir> && ... )`, `--cwd`/`-C`, or absolute paths.

## Platform

Apple Silicon MPS only. No CUDA attention (SDPA only). MLX dtypes: `bfloat16` native; quantize `mlx-8bit` (default) or 4-bit. No FP8.

## Startup

```bash
( cd bun-apps/gui-movie-director && bun run dev )
bun run --cwd bun-apps/gui-movie-director gui:port   # discover URL
```
Kill stuck server: `lsof -ti :<port> | xargs kill -9`. Fresh clone: `bash scripts/setup.sh`.

## run.py Subcommands

`python/venv/bin/python python/mlx-movie-director/run.py <cmd>`.

```
image [t2i|angle|review|profile|controlnet|i2i|faceswap|swap|anime2real|quality|workflow|expansion|purify|restore]
video [generate|review|compare|quality|restore|vbvr|relay|segment|t2i2v]
caption <image>   replay <manifest>   upscale   check-model
schema            schema-defaults
```

Self-test: `--self-test` or `--self-test t2i:portrait`. `--offline` for zero network egress.

## Testing

```bash
( cd bun-apps/<pkg> && bun test )                                        # any bun-apps/*
bun run --cwd bun-apps/gui-movie-director check:schema                  # validate vs run.py
( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests [--run-gpu]
```

**Per-package gates differ.** `pi-agent-ext-hermes-memory` `bun run check` = `tsc`. `pi-agent-ext-wayfind` `bun run check` = **biome** (tsc runs under `build`, not `check`). For wayfind run **both** `bun run check && bunx tsc --noEmit && bun test`. Always run a package's canonical `bun run test` script (it may include `build`), not a hand-assembled `bun run check && bun test` subset.

## Subagent dispatch conventions

**Watchdog off for write-heavy implementer dispatches.** The `subagent` tool's `watchdog` (L1 commit-scope + L2 model-review) is a false-positive machine on multi-session worktrees (L1 flags ancestor `origin/main` files as out-of-scope; reports "no changes" when commits did land), and across the 10-impl SDD cycle the L2 review returned zero actionable findings. The independent reviewer subagent is the real quality gate. **Default: omit `watchdog` (or set off) for write-heavy implementer dispatches**; reserve it for read-only verification.

## Planning artifacts (standing rule)

Wayfind `.planning/` artifacts are **durable, shared planning** — they MUST be committed and pushed to `origin/main`, never left local-only. This covers effort folders (`.planning/<effort>/` incl. `map.md`, `spec.md`, `tickets/`, `plans/`, `brainstorm/`, `sdd/`), plus `.planning/specs/` and `.planning/plans/`.

Whenever you create or update anything under `.planning/`, `git add .planning/...` and include it in the branch's commits/PR so it lands on `origin/main`. Never leave a new `.planning/<effort>/` directory as untracked (`??`) in `git status`. The repo's `.gitignore` already encodes this (`.planning/<effort>/` artifacts ARE committed); this rule enforces following it.

**Carve-outs that stay ignored/local** (do NOT commit): per-filename transient scratch (`task_plan.md`, `progress.md`, `findings.md`) and the flat no-effort `.planning/sdd/` fallback dir.

## DevOps operations (standing rule)

Any git sync / branch prep / rebase / PR merge / local CI / branch sweep / post-run review in this repo goes through the **devops tool chain** (`sync_repo`, `prepare_branch`, `local_ci`, `await_pr_merge`, `verify_merge`, `sweep_branches`, `devops_retrospect`) per `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md`. Never dispatch hand-rolled raw-bash git/gh subagents for phases a devops tool owns.

**Plain `pi` sessions** (no repo extensions loaded — diagnose by absence of the devops tools): use the CLI fallback `bun bun-apps/pi-agent-ext-devops/src/sync-cli.ts [--dry-run]` for sync; do not invent git command sequences. Prefer launching sessions via the pi-agent wrapper `bun bun-apps/pi-agent/src/cli.ts`, which auto-loads all run-dir extensions and skills.

## Key Directories

```
python/mlx-movie-director/    # ACTIVE — MLX pipeline
mlx-models/                   # MLX model tree (override: MLX_MODELS_DIR / --models-dir)
../video_generation__models/  # EXTERNAL binary store (outside repo)
bun-apps/gui-movie-director/  # ACTIVE — Bun + React GUI
```

## Extension packages (pi-agent-ext-*)

Every `bun-apps/pi-agent-ext-<X>/` registers its pi extension at **exactly one** canonical entry: `extensions/<X>.ts` (filename == folder suffix, no `pi-` prefix). One registered extension per folder.

- **Naming**: `extensions/<X>.ts` where `<X>` is the folder minus `pi-agent-ext-`. Never `src/index.ts`, root `index.ts`, `extensions/index.ts`, or `extensions/pi-<X>.ts` as the registration entry.
- **Lib entry stays separate**: if a package's lib `main` is `src/index.ts` (power-tool, hermes-memory) or root `index.ts` (web-access), add a 1-line re-export shim `export { default } from "../src/index.ts";` at `extensions/<X>.ts` as the registered entry — don't move the lib.
- **Registration**: dynamic extensions → `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]`); always-on/static → `bun-apps/pi-agent/src/static-extensions.ts`. Never list the same extension in both (double-register).
- **Schema-cost canary**: `bun-apps/pi-agent/src/cli/commands/schema-cost.ts` `discoverExtensionEntries()` derives its list from `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]` + `staticExtensions[]`) — extensions registered there are measured automatically. Only unregistered measure-worthy files need a manual `EXTRA_ENTRIES` row.
- **CLI subcommands**: extension-backed CLI subcommands live at `extensions/cli-subcommand.ts` and are wired in `bun-apps/pi-agent/src/cli/extensions/registry.ts`.

## Vendor patches

ltx-2-mlx / mflux patches in `python/mlx-movie-director/app/vendor_patches.py`. Never edit vendor submodules directly; add via `_patch_*()` → `apply_all_patches()`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`ziyu4huang/video_generation`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Multi-context — each domain owns its own `CONTEXT.md` + `docs/adr/` (e.g. `bun-apps/pi-agent/`). A root `CONTEXT-MAP.md` lists contexts once a second one is captured. See `docs/agents/domain.md`.
