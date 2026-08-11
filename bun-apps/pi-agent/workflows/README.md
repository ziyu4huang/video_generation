# pi-agent CLI engine workflows

Deterministic workflows runnable via `pi-agent cli workflow run <name>` — these live
in the **engine dir** (`bun-apps/<pkg>/workflows/`) on purpose: the
gate / retry / loopUntilDry / journaling / resume primitives only exist in the
pi-agent-ext-workflow engine vm, NOT in Claude Code's `Workflow` tool. See
`../docs/workflow-cli.md` (two-runtime boundary).

## Example workflow packs (folders + manifest.json)

A **workflow pack** is a folder with a `manifest.json` + an entry script, run
via `workflow run <name>` exactly like a single-file script. See
`../docs/workflow-cli.md#workflow-packs` for the manifest schema, resolution,
and precedence. These three prove the shape end-to-end:

- **`echo/`** — the smoke test. Minimal manifest + a one-`agent()` entry that
  echoes its args. Proves folder → `manifest.json` → engine.
- **`args-demo/`** — optional manifest `args` (`topics`) + `model`, and an entry
  that uses the `parallel()` primitive to fan out one `agent()` per topic. Proves
  packs carry real workflow behaviour and exercise the optional fields.
- **`sample/`** — the regression fixture. Declares **every** manifest field
  (`kind`/`engine`/`args`/`model`/`thinking`/`howToRun`) and exercises the
  `pipeline()`/`phase()`/`log()` primitives `echo` + `args-demo` leave uncovered.
  Hermetic (no bash/writes/network); covered by real-pack tests in
  `src/cli/__tests__/workflow.test.ts`.

```bash
bun --cwd bun-apps/pi-agent src/cli.ts cli workflow run echo --dry-run
bun --cwd bun-apps/pi-agent src/cli.ts cli workflow run args-demo --dry-run
bun --cwd bun-apps/pi-agent src/cli.ts cli workflow run sample --dry-run
```

> **Where packs resolve + where output lands.** Named resolution looks under
> `PWD/.pi/workflows/` and `bun-apps/<pkg>/workflows/` (a literal path works
> anywhere). The run log defaults to `PWD/.pi/workflows/runs/`; override with
> `--out-dir <dir>` or `PI_WORKFLOWS_OUT_DIR`. The legacy `.claude/workflows/`
> dir is no longer name-resolved by `workflow run` — call those scripts by path
> (`workflow run .claude/workflows/<name>.js`) or via Claude Code's Workflow tool.

### Regression baseline

Reference run captured against `deepseek/deepseek-v4-flash` (2026-07-17). Re-run
the same commands after any change to the manifest schema, the dir/file
resolver, or the runner — the **agent count** is the deterministic invariant
(structure of the fan-out), not the reply text or wall-clock. All three packs
are hermetic (no bash / no writes / no network), so they are safe to run live.

| pack | invocation | primitive(s) exercised | expected `agents` |
|---|---|---|---|
| `echo` | `workflow run echo --model deepseek/deepseek-v4-flash` | `agent()` | **1** |
| `sample` | `workflow run sample --model deepseek/deepseek-v4-flash` | `pipeline()` + `phase()` + `log()` | **3** (one per default item) |
| `args-demo` (manifest) | `workflow run args-demo --model deepseek/deepseek-v4-flash` | `parallel()` + manifest `args` | **2** (default `topics:[alpha,beta]`) |
| `args-demo` (`--args`) | `... --args '{"topics":["x","y","z"]}'` | `parallel()` + `--args` override | **3** |

Add `--json` to capture the full receipt (`runId`, `agents`, `phases`,
`result`) for diffing against this table. A run whose `agents` diverges from
the expected value signals a regression in the resolver/runner or the manifest
`args` precedence — investigate before trusting the change.

### How a pack runs (end-to-end)

A pack has **two entry paths** that share the SAME resolver (the engine's
`workflow-pack.ts`):

- **Path A — CLI**: `workflow run <name>` (headless meta-command; shown below).
- **Path B — interactive tool**: the `workflow` tool with `name: "<pack>"` in a
  pi TUI session (the workflow extension is built-in via `./pi-agent.sh`). The
  tool resolves the pack through the same resolver, then runs via its manager.

> `manifest.model` is applied on Path A (`--model` overrides it) but **not** on
> Path B (the session's `mainModel` governs; per-run model is future work).

```
              bun --cwd bun-apps/pi-agent src/cli.ts cli workflow run <name> --model <spec>
                                                 │
                                                 ▼
        ┌───────────────────────────── pi-agent cli (Command dispatch) ─────────────────────────────┐
        │  workflow sub-command: NON-AGENT meta-command (creates NO agent session, injects 0 tools) │
        │                                                                                           │
        │   resolve <name>  (first hit wins; a manifest.json DIR beats a same-name .js)             │
        │      1. literal path                 ┌─────────────────────────────────────────────┐      │
        │      2. .pi/workflows/<name>         │  WORKFLOW PACK = a FOLDER                    │      │
        │      3. bun-apps/<pkg>/workflows/    │   ├── manifest.json   (name/entry/args/...)  │      │
        │      4. <name>.js fallback           │   └── <entry>.js      (export const meta)    │      │
        │                                      └─────────────────────────────────────────────┘      │
        │                                                                                           │
        │   precedence:  --model  >  manifest.model         --args (shallow-merge) > manifest.args  │
        │   output dir:  --out-dir  >  PI_WORKFLOWS_OUT_DIR  >  PWD/.pi/workflows/runs (default)    │
        └───────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                │  runWorkflow(entry, { args, model, runsDir })
                                                ▼
        ┌──────────────── pi-agent-ext-workflow ENGINE VM (the only place gates live) ────────────────┐
        │   strict-parse entry  (acorn sourceType:module; Date.now/Math.random/new Date() THROW)     │
        │   expose globals →  agent() | parallel() | pipeline() | phase() | log()                     │
        │   deterministic primitives →  gate() / retry / loopUntilDry / journaling / resume           │
        │                                                                                             │
        │   the engine's own WorkflowAgent drives the LLM via createAgentSession SDK (no VSCode)     │
        └───────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                                │
                                                ▼
        ┌──────────────────────── receipt + side effects ─────────────────────────┐
        │  stdout:  ✓ <name> — agents=N Tms (source: …) run=<id> → <kind>          │
        │  --json:  { meta, runId, agents, durationMs, phases, result }            │
        │  disk:    <runsDir>/<RUN_ID>.log  (run log; default PWD/.pi/workflows/)   │
        └─────────────────────────────────────────────────────────────────────────┘
```

Two runtimes share the script *syntax* but not the gates: `workflow run` AND the
`workflow` tool's `name` param both target this engine (real
gate/retry/loopUntilDry/resume) through the same shared resolver; Claude Code's
`Workflow` tool is best-effort only. The diagram above is the Path A (CLI) flow;
Path B converges on the same resolver + engine from the `workflow` tool.

## knowledge-distill

WRITE-side distill pipeline. Takes a codebase source and atomises it into
graph-linked vault cards under engine gate control.

```bash
bun --cwd bun-apps/pi-agent src/cli.ts cli workflow run knowledge-distill \
  --model lm-studio/google/gemma-4-26b-a4b-qat --thinking low \
  --args '{"pr":[244,242],"folder":"Zettelkasten/distill","maxNotes":14,"minCards":10}'
```

Args:
- `pr` — PR number **or array** of numbers (fetched via `gh`, rendered to md).
- `sources` — array of markdown/text file paths (alternative to `pr`).
- `folder` — vault target folder (default `Zettelkasten/distill`).
- `maxNotes` — hint passed to `zk-extract --max-notes` (default 16).
- `minCards` — success threshold for net-new cards (default 10).
- `knowledgeFile` — optional `.knowledge.jsonl` for the `zk-ingest` graph-link phase.
- `vault` — override vault path (default `<root>/vaults_root/pi-agent-vault`).

Pipeline:
1. **Resolve** — repo root, vault, source list; fetch PR thread(s) → md.
2. **Baseline** — count cards in the target folder + `zk-query --health` snapshot.
3. **Distill** — `pipeline()` over sources; each runs `zk-extract` under a
   `gate()` that retries on failure (validator: exitOk && notesCreated > 0).
4. **GraphLink** *(optional)* — `zk-ingest` when `--knowledge-file` is given.
5. **Garden** — `gate()` around `zk-card check` + `zk-query --health`; validator
   requires `graphHealth.ok && deadLinks == 0`; failure feedback triggers a
   repair retry.
6. **Persist** — history receipt at
   `.claude/workflows/history/knowledge-distill/<RUN_ID>.json` carrying
   `cardsBefore/After`, `netNew`, `distill.trace`, `garden` verdict, and
   `healthBefore/After`.

### Live proof (2026-07-04)

Two-PR run (`pr:[244,242]`) → 9 atomic cards (5 + 4), both distill gates green
on attempt 1, garden gate OK, `graphHealth OK before→after`, 0 orphans / 0
dead-links, every card carries a `## 連結` section with `[[]]` links. Receipt:
`.claude/workflows/history/knowledge-distill/2026-07-04T16-41-35.json`.

The `netNew ≥ minCards` (10) target is **model-dependent** (how aggressively
the distill model splits source into atomic notes), not a workflow-determinism
property — the gate / retry / garden / health machinery is deterministic and
ran clean. A third source clears the ≥10 bar; the workflow itself is correct.

### Safety

Writes only to the target vault folder + the history receipt. Never touches
source code, never git-applies, never pushes. The garden gate is a floor (no
orphans / dead-links), not a ceiling on card quality — the READ-side retrieval
loop (`retrieval-quality-self-improve`) is the real quality signal.
