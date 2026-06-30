# pi-agent

A **thin wrapper** around the **real pi TUI** with **monkey-patch hooks**.

It does *not* reimplement pi. It calls the official `main()` from
`@earendil-works/pi-coding-agent` untouched, then layers reversible
monkey-patches to change default behavior.

## Why

You want the full pi experience (TUI, all flags, sessions, tools) but with a
few behavioral tweaks — e.g. force pi to load models **only** from
`~/.pi/agent/models.json`, ignoring the built-in catalog and project-local
`.pi/` extension provider registrations.

That is one prototype patch, not a fork.

## How it works

```
pi-agent/src/cli.ts
  1. applyPatches()              ← env-gated monkey-patches on ModelRegistry
  2. await main(process.argv)    ← the REAL pi TUI / print / rpc
```

Because Bun's module cache is shared process-wide, `cli.ts` and `main()`
import the **same** `ModelRegistry` class object. Patching its prototype
before `main()` runs affects the registry `main()` constructs internally.
No source fork, no passthrough rewrite.

## Setup

```bash
bun install          # at the monorepo root (never inside pi-agent/)
```

## Usage

```bash
# interactive TUI (the real thing)
bun bun-apps/pi-agent/src/cli.ts

# print mode
bun bun-apps/pi-agent/src/cli.ts -p "hello"

# list models — with the patch ON, only ~/.pi/agent/models.json entries appear
bun bun-apps/pi-agent/src/cli.ts --list-models

# load a local extension without pi install
bun bun-apps/pi-agent/src/cli.ts -e bun-apps/zai-mcp/extensions/zai-mcp.ts -p "list your tools"
```

### Optional: alias in `~/.zshrc`

```sh
alias pi='bun /path/to/repo/bun-apps/pi-agent/src/cli.ts'
alias pi-stock='bunx @earendil-works/pi-coding-agent'
```

## Patches

| Env | Default | Effect |
|-----|---------|--------|
| `BUN_PI_ONLY_MODELS_JSON` | `1` (on) | Models come **only** from `~/.pi/agent/models.json` — built-in catalog disabled, extension `registerProvider` ignored |
| `BUN_PI_DEBUG_PATCHES` | `0` (off) | Print which patches were applied on startup |

Toggle:

```bash
BUN_PI_ONLY_MODELS_JSON=0 bun bun-apps/pi-agent/src/cli.ts --list-models   # built-ins come back
BUN_PI_DEBUG_PATCHES=1    bun bun-apps/pi-agent/src/cli.ts                  # show patch status
```

> ⚠️ With `BUN_PI_ONLY_MODELS_JSON=1`, every entry in `models.json` must be
> self-contained (`api`, `baseUrl`, …) since built-in defaults are gone.
> Local providers like `lm-studio` already are.

## Add your own patch

1. Create `src/patches/<name>.ts` that patches a prototype/module.
2. Register it (env-gated) in `src/patches/index.ts`.

`cli.ts` never needs to change.

## Layout

```
pi-agent/
├── package.json            # bin: pi-agent → src/cli.ts
├── README.md
└── src/
    ├── cli.ts              # applyPatches() → main(argv)
    └── patches/
        ├── index.ts            # registry (env-gated) + debug
        └── only-models-json.ts # force ~/.pi/agent/models.json only
```

## Known limitations & TODO

- **`only-models-json` patch is broader than its header claims.** The patch stubs
  `ModelRegistry.prototype.loadBuiltInModels` to `() => []` and
  `registerProvider` to a no-op. That achieves "load only `models.json`", but it
  also:
  - drops `overrides` / `modelOverrides` parsed from `models.json` (they're passed
    into `loadBuiltInModels`, which the stub ignores), and
  - suppresses **all** `registerProvider` callers — including OAuth provider
    registration driven by `~/.pi/agent/config`, not just project-local extensions.
  Models that rely on OAuth (`/login`, request-config) can therefore silently fail
  with a "model not configured" style error. TODO: narrow the stubs (preserve the
  overrides merge; gate `registerProvider` on caller origin rather than blanking
  the prototype).

## Related

- **[pi-agent-cli](../pi-agent-cli/README.md)** — single-turn scripted workflows
  (`vlm-describe`, `zk-extract`, `zk-ask`, `pipeline pdf-to-vault`) with extensions
  baked in as workspace deps. Use this when you want one-shot automation or to call
  a specific agent workflow from a script — not an interactive session.
