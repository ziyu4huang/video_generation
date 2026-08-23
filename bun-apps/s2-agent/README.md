# s2-agent

A **thin wrapper** around the **real pi TUI** (`@earendil-works/pi-coding-agent`)
with **reversible monkey-patches** — it does not reimplement pi. It calls the
official `main()` untouched, after `applyPatches()` layers on: baked providers,
run-dir extension/skill loading, env→argv bridges, and default-model seeding.

Details that used to live here (patch mechanics, vocabulary, design rationale)
are in **[CONTEXT.md](CONTEXT.md)**, **[docs/adr/](docs/adr/)**, and the source
file headers — the code is the documentation.

## Setup / usage

```bash
bun install                                        # from bun-apps/ (workspace root), never inside s2-agent/
bun bun-apps/s2-agent/src/cli.ts                   # interactive TUI (the real thing)
bun bun-apps/s2-agent/src/cli.ts -p "hello"        # print mode
bun bun-apps/s2-agent/src/cli.ts --list-models     # baked providers appear alongside built-ins
./s2-agent.sh cli <command>                        # non-interactive namespace — `cli help` is authoritative
```

## Model config

ALL baked model config lives in **`src/pre-load-providers.ts`** (pure, no side
effects), in three sections: §1 `PROVIDERS` (extension-provider catalog, e.g.
lm-studio), §2 `BUILTIN_MODEL_DEFAULT` (the default provider/model/thinking),
§3 `DEFAULT_MODEL_TIER_CONFIG` (tier routing seed). Edit §1 to add a provider — no
other file changes. No `~/.pi/agent/models.json` is read, and no
`~/.pi/agent/models-store.json` is ever created (pi's builtin catalog covers
zai/deepseek/huggingface; the in-memory-models-store patch keeps refresh
in-memory).

## Patch toggles (`BUN_PI_*`)

Every patch is registered in `src/patches/index.ts` (`PATCH_TABLE` — the
authoritative env-var list). Highlights:

| Env | Default | Effect |
|-----|---------|--------|
| `BUN_PI_PRE_LOAD_PROVIDERS` | on | Inject the `PROVIDERS` catalog |
| `BUN_PI_LOAD_RUN_DIR` | on | Splice `run-dir/` extensions/skills into argv (cwd-independent) |
| `BUN_PI_DEFAULT_MODEL_ENV` | on | Bridge `PI_MODEL`/`PI_PROVIDER`/`PI_THINKING` env into TUI argv |
| `BUN_PI_ENSURE_MODEL_TIERS` | on | Seed the §3 tier config on a fresh machine (never clobber) |
| `BUN_PI_IN_MEMORY_MODELS_STORE` | on | Keep model catalogs in memory — never write `~/.pi/agent/models-store.json` |
| `BUN_PI_DEBUG_PATCHES` | off | Print patch status on startup |

To add a patch: create `src/patches/<name>.ts`, register it in
`src/patches/index.ts`. `cli.ts` never changes.

## Extensions

`s2-agent.registry.yaml` is THE registry (one entry per extension); derived
`run-dir/manifest.json` is freshness-guarded — regen with
`bun run --cwd bun-apps/s2-agent regen:manifest` (+ `regen:static` for
`load: static`), never hand-edit. Heavy on-demand extensions live in the same
file's `lazyExtensions` and load only via `-e <alias>`. Schema authority:
`run-dir/registry.ts`.

## Deploy / doctor

```bash
bun run --cwd bun-apps/s2-agent deploy              # cut a versioned frozen tree, move `current`
bun bun-apps/s2-agent/src/cli.ts cli doctor [--smoke] [--json]   # self-check (offline; --smoke loads extensions)
```

Deploy reference: [docs/deploy.md](docs/deploy.md). Workflow SOP (branch prep,
local CI, PR merge): `s2-agent-ext-devops/skills/devops-workflow/SKILL.md`.

## Testing

```bash
( cd bun-apps/s2-agent && bun test )                # quick tier (plain unit)
bun ../s2-agent-ext-devops/scripts/run-test.ts medium   # + the s2-agent suite incl. launcher e2e (default); --list for tiers
```

## Layout

```
s2-agent/
├── s2-agent.registry.yaml   # THE extension registry (edit this)
├── run-dir/                 # manifest.json (DERIVED) + resolve.ts (argv splice, lazy aliases)
├── docs/adr/                # design decisions (indexed in bun-apps/docs/adr/INDEX.md)
└── src/
    ├── cli.ts               # entry — `cli` argv intercept → applyPatches() → main(argv)
    ├── pre-load-providers.ts  # ALL baked model config (§1–§4, pure)
    ├── cli/                 # non-interactive `cli` namespace (commands/, sessions/, extensions/)
    ├── patches/             # env-gated monkey-patches (index.ts = PATCH_TABLE)
    └── __tests__/           # unit + e2e-harness (PI_AGENT_E2E gates)
```

## Known issues

- A compiled binary cannot `-e`-load `.ts` extensions (jiti base64 URL →
  Bun `ENAMETOOLONG`). `run-dir/resolve.ts` detects binary mode; the registry's
  `load: static` entries (`src/static-extensions.ts`, regen'd) carry a fixed
  statically-imported set instead. Provider injection still works.
