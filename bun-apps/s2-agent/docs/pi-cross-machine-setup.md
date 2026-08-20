# pi-* Packages — Cross-Machine Setup

How to bring the `bun-apps/pi-*` packages up on a **fresh machine**, and the full
environment-variable contract in one place. The env vars are otherwise scattered across
each package's README; this is the canonical reference.

> **If something fails, run `doctor` first** — it checks every condition below and prints
> an actionable checklist:
> ```bash
> ./s2-agent.sh cli doctor          # human checklist
> ./s2-agent.sh cli doctor --json   # machine-readable
> ./s2-agent.sh cli doctor --fix    # create missing dirs
> ```

---

## Prerequisites

| Need | Why | Required for |
|------|-----|--------------|
| [Bun](https://bun.sh) | All `pi-*` packages are Bun + TypeScript | everything |
| Apple Silicon Mac | MLX (image/video generation) is Metal-only | `s2-agent-ext-flux2`, the mlx-movie-director pipeline |
| [LM Studio](https://lmstudio.ai) (optional) | Local VLM / distill via Qwen3-VL/Gemma | `pi-file2md`, `zk-extract`, `file2md` |
| Swift toolchain (optional) | Builds the flux2 binary on first use | `s2-agent-ext-flux2` (or set `FLUX2_BIN` to a prebuilt binary) |
| An LLM provider key | Cloud agents | passthrough mode (`PI_PROVIDER`/`PI_MODEL`) or `~/.pi/agent/models.json` |

```bash
# 1. clone + install at the monorepo root
git clone <repo> && cd <repo>
bun install

# 2. initialize the reference vault submodule (only needed to RUN the pi-obsidian
#    vault-driven tests; skip if you don't need them)
git submodule update --init vaults_root/s2-agent-vault

# 3. (optional) point at your model tree / output store if they aren't siblings
export MLX_MODELS_DIR=/path/to/mlx-models
export MLX_OUTPUT_DIR=/path/to/video_generation__output

# 4. self-check
./s2-agent.sh cli doctor
```

The MLX model tree and output store live **outside** the repo by default
(`../video_generation__models`, `../video_generation__output`), content-addressed — see
[docs/model-store.md](../../../python/mlx-movie-director/docs/model-store.md). On a fresh machine, set `MLX_MODELS_DIR` /
`MLX_OUTPUT_DIR` to wherever you keep them.

---

## Environment variable contract

### LLM provider / model (all packages)

| Var | Default | Purpose |
|-----|---------|---------|
| `PI_PROVIDER` | baked per-package | Provider name (`zai`, `lm-studio`, …) |
| `PI_MODEL` | baked per-package | Model id, or `provider/id[:thinking]` |
| `PI_THINKING` | `off` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `PI_VERBOSE` / `BUN_PI_VERBOSE` | `0` | `0\|1\|2` tool-event verbosity |
| `PI_TOOLS` | — | Tool allowlist (csv) |
| `PI_SKIP_MODELS_JSON` | unset | `1` skips `~/.pi/agent/models.json` |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Where pi reads/writes its settings, models, agents |

### MLX generation paths (`s2-agent-ext-flux2` + mlx-movie-director)

| Var | Default | Purpose |
|-----|---------|---------|
| `MLX_OUTPUT_DIR` | `<repo>/../video_generation__output` | Generation output (write target — auto-created) |
| `MLX_MODELS_DIR` | `<repo>/mlx-models` | Model tree root (read target — must exist for generation) |

### flux2 (`s2-agent-ext-flux2`)

| Var | Default | Purpose |
|-----|---------|---------|
| `FLUX2_BIN` | discovered | Prebuilt flux2 binary path (skips discovery + swift build) |
| `FLUX2_REPO_ROOT` | discovered | Repo root (needed in bundle/binary mode) |

### Obsidian vault (`pi-obsidian`, `pi-knowledge-card`)

| Var | Default | Purpose |
|-----|---------|---------|
| `OB_VAULT_PATH` | — | Absolute vault path (Tier 1 — overrides everything) |
| `OB_VAULT_DIR` | `vault` | Vault folder name under cwd (Tier 3 fallback) |
| `OB_USE_GLOBAL` | unset | Any truthy value skips Tier 3 fallback |
| `OB_INDEX_CACHE_DIR` | `<vault>/.cache` | Search-index persistence (relocatable) |
| `OB_CACHE_MAX` | `500` | Session file cache soft cap |
| `OB_INDEX_POLL_MS` | `2000` | Incremental index refresh throttle |
| `OB_TRIGRAM_SEARCH` | on | `0` disables the C5 trigram pre-filter |
| `OB_INDEX_PERSIST` | on | `0` disables C6 cross-session index persistence |
| `OB_PARENT_MODEL` / `OB_SUBAGENT_MODEL` | — | Model-id floor for subagents (see below) |
| `OB_SUBAGENT_TIMEOUT_MS` | `300000` | Per-call subagent timeout |

#### Distill/garden subagent model floor

The distill/garden subagents (`obsidian_distill` / `obsidian_garden` /
`zk_extract` / `zk_card` / `zk_ask`) resolve their model in this order:

1. **per-call `--model`** (explicit; warns if the id matches a weak tier)
2. **`OB_SUBAGENT_MODEL` env** (trusted floor; never weakness-checked — the
   correct channel for a fast `/flash` model)
3. **`OB_PARENT_MODEL` env** (inherited; refused if weak)
4. pi default (warns "no subagent model configured")

The real pi TUI does **not** publish `OB_PARENT_MODEL`/`OB_SUBAGENT_MODEL`, so
without configuration every distill with no `--model` hits path 4 (the warning
+ a slow inherited model → distill timeouts). Set a persistent fast floor in
`~/.pi/agent/settings.json`:

```json
{ "obsidian": { "subagentModel": "deepseek/deepseek-v4-flash" } }
```

The `subagent-model-floor` patch publishes this as `OB_SUBAGENT_MODEL` at
startup (before any subagent spawns). Precedence is preserved: an explicit
`export OB_SUBAGENT_MODEL=…` still wins (per-session override), and a per-call
`--model` still wins over the floor. A `/flash` id is silent here because the
floor path skips the weak-tier check — do **not** route it through `--model`
(that trips the weak-warning).

### VLM (`pi-file2md`)

| Var | Default | Purpose |
|-----|---------|---------|
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio endpoint |
| `LM_STUDIO_API_KEY` | `lm-studio` | LM Studio API key |
| `PI_VLM_MODEL` | baked | VLM model for pdf-to-vault |
| `PI_DISTILL_MODEL` | baked | Distill model for pdf-to-vault |
| `PI_VLM_RETRIES` | `3` | VLM retry count on 429/transient |
| `PI_VLM_RETRY_WAIT_MS` | `10000` | Retry wait |

### s2-agent patch toggles (build/runtime)

| Var | Default | Effect |
|-----|---------|--------|
| `BUN_PI_PRE_LOAD_PROVIDERS` | `1` | Inject providers from `src/pre-load-providers.ts` |
| `BUN_PI_SET_PACKAGE_DIR` | `1` | Pin `PI_PACKAGE_DIR` for asset/theme resolution |
| `BUN_PI_SKIP_UPDATE_CHECK` | `1` | Silence pi's "Update Available" banner |
| `BUN_PI_LOAD_RUN_DIR` | `1` | Splice `run-dir/` extensions/skills into argv |
| `BUN_PI_SUBAGENT_MODEL_FLOOR` | `1` | Publish `obsidian.subagentModel` from settings.json as `OB_SUBAGENT_MODEL` (distill/garden floor) |
| `BUN_PI_DEBUG_PATCHES` | `0` | Print which patches were applied on startup |
| `BUN_PI_DEBUG_RUN_DIR` | `0` | Print the resolved run-dir argv fragment |
| `PI_SELF_ENTRY_PREFIX` | unset | Entry namespace a spawned subagent child re-enters. Set to `cli` by `runCli()` (i.e. any `s2-agent cli …` invocation), read by `s2-agent-ext-subagent`'s `getPiInvocation()`, which splices it in front of the child's pi flags. Without it a CLI-parented child falls through to the TUI root and inherits the full static-extension set the `cli` entry deliberately does not load. |

`PI_SELF_ENTRY_PREFIX` is **parent→child signalling, not a user setting** — do not
`export` it persistently in a shell profile. An ambient `PI_SELF_ENTRY_PREFIX=cli`
would make a *TUI*-parented subagent wrongly re-enter the `cli` namespace.

A commented subset of the portability-relevant vars also lives at the repo root as
[`.env.example`](../../../.env.example).

---

## Bundle-mode caveats

s2-agent's **run-dir** mechanism (PRs #151/#153) lets extensions load cwd-independently:
`run-dir/manifest.json` declares the repo's fixed extension/skill set as paths relative to
`bun-apps/`, and `run-dir/resolve.ts` resolves them to absolute paths spliced into argv at
startup. See the "Extensions via run-dir" section of `bun-apps/s2-agent/README.md`.

Two machine-specific consequences:

1. **Bundle mode bakes absolute paths at build time** (`src/generated/run-dir-base.ts`,
   gitignored). This is intentional — see [`extension-registry.PRD.md §3`](./extension-registry.PRD.md)
   for why baked absolute paths are the fix, not a workaround — but it means a
   Bundle/Standalone deploy is NOT relocatable across machines; rebuild on the target.
2. **`MLX_OUTPUT_DIR` / `MLX_MODELS_DIR` / `FLUX2_REPO_ROOT` have defaults computed from the
   repo root, so they work in source mode without configuration. In bundle/binary mode on a
   fresh machine, set them explicitly (the bundle may not sit next to the model tree).

The `pi-file2md` build runs a portability check that warns if any `/Users/...` (macOS),
`/home/...` (Linux), or `C:\Users\...` (Windows) path leaks into bundled output
(`bun-apps/s2-agent-ext-file2md/scripts/verify-portability.ts`).

---

## Where state lives (all portable)

| What | Where | How it's derived |
|------|-------|------------------|
| s2-agent settings / models / agents | `~/.pi/agent/` | `homedir()`, overridable via `PI_CODING_AGENT_DIR` |
| Obsidian config | `<cwd>/run-dir/obsidian_config.json` | project-relative (s2-agent run-dir/) |
| Workflow runs / projects | `~/.pi/workflows/` | `homedir()` |
| Obsidian search index | `<vault>/.cache` | vault-relative, overridable via `OB_INDEX_CACHE_DIR` |
| pdf-to-vault pipeline output | `<cwd>/pdf-to-vault-<ts>-<slug>/` | cwd-relative, `--out` flag |

No production code hardcodes `/Users/...` paths; build-time generated files
(`src/generated/*.ts`) are gitignored and regenerated per machine.
