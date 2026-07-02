# pi-agent-cli

A **self-contained** pi-agent CLI with extensions baked in as workspace deps.
Drives pi-agent (via the SDK `@earendil-works/pi-coding-agent`) from TypeScript
on Bun's native runtime. Ships **agent workflows** (`vlm-describe`, `zk-extract`,
`zk-ask`, `pipeline pdf-to-vault`) plus a **pi-compatible passthrough** so the
binary can serve as its own sub-agent target.

Each subcommand is one **single-turn agent run** — no interactive TUI, no
persistent session loop. Extensions are imported directly into the process
(`pi-obsidian`, `pi-vlm`, `pi-knowledge-card` as `workspace:*` deps), so
they are always active without a `.pi/settings.json` entry or `-e` flag.

## What makes it self-contained

The pi-obsidian extension is imported as an inline `extensionFactory`
(`src/sessions/shared.ts`) and compiled into the bundle. No `.pi/settings.json`
package reference or `-e <path>` flag is needed at runtime — every session has
the Obsidian tools (`obsidian_distill`, `obsidian_search`, `obsidian_create`,
…). When bundled (`bun scripts/build.ts`), the extension code lives inside the
single output `cli.js`.

**Why inline and not pi-agent's run-dir manifest?** `pi-agent` (the TUI wrapper)
eagerly loads the *entire* `run-dir/manifest.json` for an interactive session
where the user may want any tool. `pi-agent-cli` runs single-turn workflows that
**curate tools per command** (e.g. `zk-extract` passes `DISTILL_ONLY` tools), so
it loads only `pi-obsidian` (always needed for vault access) plus any
command-specific factories — loading the full manifest would bloat every run
with extensions (`pi-flux2`, `zai-mcp`, …) the command never uses. Both paths
resolve to the same underlying `pi-obsidian/extensions/obsidian.ts` factory; the
difference is the *load mechanism* (direct import vs `-e` argv), appropriate to
each entry point.

## Setup

```bash
bun install          # at monorepo root
```

Model/credentials come from your existing pi config
(`~/.pi/agent/settings.json`, `auth.json`, `models.json`).

## Cross-machine setup

Bringing the CLI up on a fresh machine? Run the self-check first:

```bash
bun bun-apps/pi-agent-cli/src/cli.ts doctor          # actionable checklist
bun bun-apps/pi-agent-cli/src/cli.ts doctor --fix    # create missing dirs
```

`doctor` verifies the runtime, repo layout, run-dir manifest, MLX output/models dirs,
flux2 binary, Obsidian vault, and LM Studio reachability. Full env-var contract + fresh
machine steps: [`docs/pi-cross-machine-setup.md`](../../docs/pi-cross-machine-setup.md)
(commented template: [`.env.example`](../../.env.example)).

## Usage

### Agent commands (one CLI = one agent workflow)

```bash
bun run --cwd bun-apps/pi-agent-cli cli vlm-describe <files...> [options]
bun run --cwd bun-apps/pi-agent-cli cli zk-extract <files.../folders...> [options]
bun run --cwd bun-apps/pi-agent-cli cli zk-card <add|find|update|remove|check> [options]
bun run --cwd bun-apps/pi-agent-cli cli zk-ask <question> [options]
bun run --cwd bun-apps/pi-agent-cli cli pipeline pdf-to-vault <pdf> [options]
bun run --cwd bun-apps/pi-agent-cli cli list
bun run --cwd bun-apps/pi-agent-cli cli help [command]
```

Or invoke directly from repo root:

```bash
bun bun-apps/pi-agent-cli/src/cli.ts vlm-describe paper.pdf
bun bun-apps/pi-agent-cli/src/cli.ts zk-ask "What is RAG?"
```

#### `zk-extract` — markdown → Zettelkasten

Distills input markdown/text files into atomic Zettelkasten notes in an
Obsidian vault. Folders are scanned recursively for `*.md` / `*.txt`.

```bash
bun bun-apps/pi-agent-cli/src/cli.ts zk-extract notes.md
bun bun-apps/pi-agent-cli/src/cli.ts zk-extract ./inbox/ --folder Zettelkasten --max-notes 20
```

#### `vlm-describe` — PDF/image → Obsidian markdown

Rasterizes each PDF page (macOS PDFKit) / accepts images, classifies a profile
via a local VLM, then explains each page into per-page Obsidian markdown +
`manifest.json` + a doc-level MOC.

```bash
bun bun-apps/pi-agent-cli/src/cli.ts vlm-describe paper.pdf
bun bun-apps/pi-agent-cli/src/cli.ts vlm-describe scan.jpg --type image
bun bun-apps/pi-agent-cli/src/cli.ts vlm-describe paper.pdf --pages 1-3 --out ./vlm-out
```

Default model: `lm-studio/google/gemma-4-26b-a4b-qat` (local VLM via LM Studio).

#### `pipeline pdf-to-vault` — PDF → markdown → Zettelkasten vault

Two-stage orchestrator: `vlm-describe` then `zk-extract`. Writes a timestamped,
resumable run dir with a `pipeline.json` coordination layer.

```bash
bun bun-apps/pi-agent-cli/src/cli.ts pipeline pdf-to-vault paper.pdf
bun bun-apps/pi-agent-cli/src/cli.ts pipeline pdf-to-vault paper.pdf --pages 1-3 --delete-png
```

Re-run with the same `--out` + input to resume.

### Pi-compatible passthrough

Anything that isn't a sub-command is treated as a pi agent invocation (mirrors
`pi -p` / `pi --mode json`):

```bash
bun bun-apps/pi-agent-cli/src/cli.ts -p "What files are in the current directory?"
bun bun-apps/pi-agent-cli/src/cli.ts --model deepseek-v4-flash -p "Summarize this"
bun bun-apps/pi-agent-cli/src/cli.ts --mode json --no-session --tools read,bash "summarize"
```

This is exactly what the `obsidian_distill` / `obsidian_garden` subagent tools
invoke internally (`process.argv[1]` + pi flags). The `-e`/`--approve` flags are
accepted and silently ignored — extensions are always active.

## Flags (pi-aligned)

| Flag | Description |
|------|-------------|
| `--model <pattern>` | `id`, `provider/id`, or `provider/id:thinking` (fuzzy) |
| `--provider <name>` | provider name |
| `--thinking <level>` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `--mode <text\|json>` | output mode (default: `text`) |
| `-p`, `--print` | non-interactive one-shot |
| `--no-session` | ephemeral (in-memory) session |
| `--tools`, `-t <csv>` | tool allowlist |
| `--exclude-tools`, `-xt <csv>` | tool denylist |
| `-e`, `--extension <path>` | accepted, ignored (extensions baked in) |
| `-a`, `--approve` | accepted, ignored (self-trusted) |

## Environment

| Var | Purpose |
|-----|---------|
| `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING` | LLM overrides |
| `OB_VAULT_PATH` | absolute vault path |
| `OB_VAULT_DIR` | vault folder name under cwd (default: `vault`) |
| `OB_SUBAGENT_TIMEOUT_MS` | distill subagent timeout (default: `300000`) |

## Build

```bash
bun run --cwd bun-apps/pi-agent-cli build        # bundle + minify
bun run --cwd bun-apps/pi-agent-cli build:obf    # + obfuscation
bun run --cwd bun-apps/pi-agent-cli build:exe    # + bun --compile → standalone exe
bun run --cwd bun-apps/pi-agent-cli build:all    # minify → obfuscate → compile
```

## Layout

```
pi-agent-cli/
├── package.json
├── README.md
└── src/
    ├── cli.ts                 # entry — dispatch subcommands + passthrough
    ├── args.ts                # pi-CLI-aligned argument parser
    ├── commands/
    │   ├── vlm-describe.ts    # PDF/image → Obsidian markdown
    │   ├── zk-extract.ts      # markdown → Zettelkasten notes
    │   ├── zk-card.ts         # CRUD for Zettelkasten notes
    │   ├── zk-ask.ts          # graph-enhanced vault Q&A
    │   └── pdf-to-vault.ts    # pipeline: vlm-describe → zk-extract (resumable)
    ├── sessions/
    │   ├── shared.ts          # shared services + baked-in provider registry
    │   └── passthrough.ts     # pi-compatible agent runner (text + json modes)
    └── __tests__/
```

## Related

- **[pi-agent](../pi-agent/README.md)** — interactive pi TUI with model-list patch.
  Use this for open-ended coding/exploration sessions where you want the full TUI
  experience and extensions loaded from `.pi/settings.json`. The two tools are
  complementary: `pi-agent` for interactive work, `pi-agent-cli` for scripted
  single-turn automation.

  `pi-agent-cli` also **depends on `pi-agent` as a workspace library** — the
  baked LLM provider catalog (lm-studio models) is sourced from `pi-agent`'s
  `PROVIDERS` (`src/pre-load-providers.ts`) so the two CLIs never drift. Adding
  a model is a one-file edit in `pi-agent`, not two.
