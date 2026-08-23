# CLAUDE.md

Guidance for Claude Code in this repository.

## Communication

Reply language: force-controlled by `responseLanguage` in `~/.pi/agent/settings.json` (live via `/response-language [tag]`). Written artifacts always English: code, comments, commits, docs, config.

## Active stack

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, native MLX)
- **Bun GUI** — `bun-apps/gui-movie-director`: `( cd bun-apps/gui-movie-director && bun run dev )`; per-worktree port via `bun run gui:port`; kill stuck server `lsof -ti :<port> | xargs kill -9`; fresh clone `bash scripts/setup.sh`
- **Embedding (knowledge layer)** — canonical = LM Studio `http://127.0.0.1:1234` model `text-embedding-bge-m3` (D3 re-confirmed 2026-08-23 by ticket 07's eval gate: English eval set favors nomic 48/50 vs 47/50 hit@4, but the recall-audit battery regresses under nomic 15/20 vs 17/20; `.planning/2026-08-22-context-lifecycle/`); resolved ONLY in `bun-apps/s2-agent-core-interface/src/embedding-leaf.ts` (`resolveSemanticEmbedConfig`; env overrides `SEMANTIC_EMBED_BASE`/`SEMANTIC_EMBED_MODEL`, legacy `LMSTUDIO_BASE_URL` baseUrl alias). Fallback endpoint: `swift/embed-mlx-server` BGE-M3 on :8090 (its `/v1/models` 404s but `/v1/embeddings` works); LaunchAgent — busy port or stray embed process → `scripts/embed-mlx-server-service.sh status` first
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

- **`.planning/` is the SOLE artifact home — this OVERRIDES any skill's default path.** brainstorming / writing-plans / SDD and other upstream skills prescribe `docs/superpowers/{specs,plans}`. That namespace is RETIRED (`ADR-superpowers-0009`) and guarded: `bun-apps/s2-agent-ext-superpowers/tests/artifact-leak.test.ts` fails on ANY tracked file under it, so writing a spec there breaks CI. Ignore the skill's path, write to `.planning/`.
- **Which layout**: multi-ticket work → an effort folder `.planning/YYYY-MM-DD-<effort>/` with `map.md` + `spec.md` + `tickets/NN-slug.md`. A single design doc with no tickets → flat `.planning/specs/YYYY-MM-DD-<topic>-design.md` (+ `.planning/plans/YYYY-MM-DD-<topic>.md`). Effort folder is the default; reach for flat only when there is genuinely nothing to decompose.
- **`map.md` house shape** — frontmatter `effort / created / last / status`, then, in this order: **Destination** (one paragraph, the end state) · **Context** (MEASURED — real numbers, real dates, real file:line; "measured YYYY-MM-DD on this machine" beats any assertion, and a fact you did not measure is Fog of war, not Context) · **Tickets** (grouped by phase, each with status) · **Decisions** (`D1…Dn`, each with its reason) · **Frontier** (the next workable ticket, and why it is first) · **Fog of war** (what is still unknown, incl. charted-but-rejected) · **Cross-effort links** (`Builds-on:` / `Supersedes:` / `Absorbed-by:` / `Shares-decision-with:` + a one-line why, added to BOTH maps). Copy `.planning/2026-08-21-archify-slide-composition/map.md` as the reference specimen.
- **Before opening an effort**, skim existing efforts' `## Decisions` + `## Cross-effort links` and cite prior decisions rather than re-deciding; close superseded tickets the same session. Full rule: `.planning/CONVENTIONS.md`.

## DevOps

All git sync / branch prep / rebase / PR merge / local CI / branch sweep / post-run review goes through the devops tool chain per `bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md` — never hand-rolled raw-bash git/gh subagents for phases a devops tool owns. Plain-session CLI fallbacks: `bun-apps/s2-agent-ext-devops/src/*-cli.ts` (sync-default-branch, prepare-feature-branch, local-ci, merge-pr-after-ci, verify-merge, sweep-merged-branches, main-health, verify-deploy-e2e, version-bump; all `--help`, JSON, exit 0/1/2) — prefer the s2-agent wrapper `bun bun-apps/s2-agent/src/cli.ts` (auto-loads run-dir extensions and skills). "Is main itself green?" → `main-health-cli.ts` (`run_local_ci` is change-scoped). "Does the deployed dist actually work?" → `verify-deploy-e2e-cli.ts` (boot + ext-load + model call against `<outRoot>/current`; also runs automatically after every `deploy-cli.ts` deploy). s2-agent version bump at PR finish → `version-bump-cli.ts --package s2-agent --patch|--minor|--major` (syncs package.json + dispatch VERSION; merge tool nudges when skipped). Drift report: `./s2-agent.sh cli loop status`.

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

- **Ext skills routing (front door)**: `.claude/skills/using-s2-agent-skills/` — ~50 repo skills + headless CLIs under `bun-apps/s2-agent-ext-*` are read-in-session docs (NOT `skill()` entries in this harness), and that skill's **Route-first gates** are the trigger layer that ext descriptions cannot provide here: hands-off (ANY arc close-out MUST write the successor `output/next-goal-<ts>.md` before reporting done), hands-on (execute the queue head), git/PR/CI (devops-workflow + `*-cli.ts`, never raw bash), tickets/efforts (wayfind + executing-plans), ideas (brainstorming). Consult it before those workflows — never hand-roll a substitute.
- **Issues**: GitHub Issues (`ziyu4huang/video_generation`) via `gh` — see `docs/agents/issue-tracker.md`.
- **Domain docs**: each domain owns `CONTEXT.md` + `docs/adr/` (root `CONTEXT-MAP.md` lists contexts; see `docs/agents/domain.md`). Cite ADRs as `ADR-<context>-NNNN`, never bare numbers — contexts number independently. `bun run test:adr` (from `bun-apps/`) blocks unresolved citations.
  - **`CONTEXT.md` is a ubiquitous-language glossary, not prose docs**: one `**Term**:` per concept with a tight definition and an `_Avoid_:` line naming the synonyms NOT to use. Reference specimen: `bun-apps/s2-agent-ext-wayfind/CONTEXT.md`. A package that owns a domain but has no `CONTEXT.md` is not yet a context — add the file AND its `CONTEXT-MAP.md` entry together.
  - **ADR file shape**: `<pkg>/docs/adr/NNNN-slug.md` (number scanned from that dir, `+1`), first line the pointer `**ID:** \`ADR-<context>-NNNN\` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID`, then `# ADR-NNNN: <title>`, `Date:` / `Status:` and, when they exist, `Plan:` / `Design:` back-links into `.planning/`. Write one only when the decision is hard to reverse AND surprising without context AND the result of a real trade-off; otherwise it belongs in the effort's `## Decisions`.
