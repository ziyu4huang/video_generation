# `s2-agent workflow` — headless engine runner

`s2-agent workflow run <name>` runs a [s2-agent-ext-ultracode][pdw] engine script
from the CLI, a shell script, or a hook — **headlessly**, without the VSCode
workflow editor. It calls `runWorkflow()` directly, so the deterministic
primitives (gate / retry / loopUntilDry / journaling / resume) are reachable
outside the GUI.

[pdw]: ../bun-apps/s2-agent-ext-ultracode/

This is a **non-agent** meta-command. It does NOT spin up an agent session the
way `zk-extract` or `file2md` do. The engine's own `WorkflowAgent` calls
the LLM (via the same `createAgentSession` SDK the rest of the CLI uses — no
VSCode dependency).

## Two entry paths, one resolver

A workflow pack is reachable through **two** entry paths that share the **same**
pack resolver (in the engine's `workflow-pack.ts`):

| Path | Entry | How |
|------|-------|-----|
| **A — CLI (this command)** | `s2-agent cli workflow run <name>` | headless meta-command; this layer is a thin wrapper (flag parsing + receipt). |
| **B — interactive `workflow` tool** | `./s2-agent.sh` → TUI → the `workflow` tool with `name: "<pack>"` | the workflow extension is built-in in the TUI; the tool's `name` param resolves the pack through the same resolver. |

Both call the same `resolveWorkflowScript` → `runWorkflow`, so name resolution,
pack-over-file precedence, and args/model merging are identical across paths.

> **`manifest.model` asymmetry.** On Path A, `--model` overrides `manifest.model`
> (CLI flag wins). On Path B, the session's `mainModel` governs and
> `manifest.model` is **not** applied (the manager has no per-run model hook;
> applying it would mutate shared session state). Per-run model on Path B is
> future work (an `ExecOptions.mainModel` → `runWorkflow` thread).

## Usage

```bash
./s2-agent.sh cli workflow run <name> [options]
./s2-agent.sh cli workflow list
```

### `workflow run <name>`

Resolves `<name>` to a script, then runs it through the engine.

**Script resolution (first hit wins):**

1. `<name>` as a literal path (absolute, or relative to cwd).
2. `.pi/workflows/<name>.js` (project engine scripts, under `PWD/.pi`).
3. `bun-apps/<pkg>/workflows/<name>.js` (package-local engine scripts).
4. The literal `<name>` with a `.js` suffix tried in (2) and (3).

> `.claude/workflows/` is **no longer name-resolved** by `workflow run` (it is
> Claude Code's Workflow-tool dir). To run one of those scripts, pass its path
> explicitly: `workflow run .claude/workflows/<name>.js`.

A `<name>` (or path) that resolves to a **directory containing `manifest.json`**
is a **workflow pack** — see [Workflow packs](#workflow-packs) below. Per
location, a pack directory wins over a same-name `.js` file.

**Flags:**

| Flag | Effect |
|------|--------|
| `--args '<JSON>'` | JSON value for the script's `args` global |
| `--model <spec>` | session main model (`id` or `provider/id`); also the default for agents the script leaves untagged |
| `--provider <name>` | provider prefix when `--model` has no `/` |
| `--thinking <level>` | off\|minimal\|low\|medium\|high\|xhigh |
| `--dry-run` | parse + validate the script only (no agents, no LLM) |
| `--no-persist-logs` | skip writing the run log to disk (logs persist by default) |
| `--out-dir <dir>` | run-log output dir (default `PWD/.pi/workflows/runs`; also via `PI_WORKFLOWS_OUT_DIR` env; absolute or cwd-relative) |
| `--json` | emit the full receipt + result as JSON |
| `-V` / `--verbose` | show per-phase + per-agent progress |

**Examples:**

```bash
# dry-run: validates the script parses + meta is well-formed (no LLM)
./s2-agent.sh cli workflow run closed-loop-proof --dry-run

# run with args + an explicit model
./s2-agent.sh cli workflow run my-workflow \
  --args '{"source":"commit-abc123"}' \
  --model lm-studio/google/gemma-4-12b

# run a script by path
./s2-agent.sh cli workflow run ./my-workflow.js --json
```

**Output:** a one-line receipt (`✓ <name> — agents=N Tms (source: …) run=<id> → <kind>`)
plus, under `--json`, the full receipt and result. A run log is written to disk
(`<runsDir>/<runId>.log`, default `PWD/.pi/workflows/runs/`) unless
`--no-persist-logs` is set. Redirect it with `--out-dir <dir>` or
`PI_WORKFLOWS_OUT_DIR`.

### `workflow list`

Enumerates `.pi/workflows/*.js` and `bun-apps/<pkg>/workflows/*.js`, parsing
each script's `export const meta` to print name + description + source dir.
Scripts that fail to parse are reported (not skipped), so a broken script is
surfaced. Use `--json` for machine-readable output.

## Workflow packs

A **workflow pack** is a richer form of an engine workflow: a **folder**
containing a `manifest.json` (what it is + how to run it) plus an entry workflow
script. It runs with the same `workflow run <name|path>` and the same
deterministic engine. A pack identifies itself by its manifest; a single-file
script by its `export const meta`.

### Folder shape

```
<name>/
  manifest.json   # required — see schema below
  <entry>.js      # the workflow script (entry is suffix-agnostic; .mjs ok)
```

### `manifest.json` schema

Minimal load-bearing. Required fields gate execution; optional fields are
defaults the CLI merges under its flags.

| field | required | purpose |
|---|---|---|
| `name` | ✅ | pack identity (`workflow list`, the run receipt) |
| `description` | ✅ | one-line description (`workflow list`) |
| `entry` | ✅ | path to the entry script, relative to the pack dir (suffix-agnostic) |
| `args` | optional | default `args` for the script's `args` global (shallow-merged under `--args`) |
| `model` | optional | default model spec (overridden by `--model`) |
| `thinking` | optional | declared, **not yet wired** (the engine exposes no `thinking` key on this path) |
| `howToRun` | optional | human-facing "how to run it" prose |
| `kind` | optional | self-identification — `"workflow-pack"`; lets a pack folder self-describe the way a pi extension folder does (minimal alignment with pi's extension folder form) |
| `engine` | optional | which engine runs the entry (e.g. `"s2-agent-ext-ultracode"`) |

### Resolution (dir-or-file)

`workflow run <name>` resolves under the project workflow dirs (`.pi/workflows/`,
`bun-apps/<pkg>/workflows/`). A `<name>` that is a directory with `manifest.json`
resolves as a pack; otherwise the single-file `<name>.js` resolution applies.
**A pack directory wins over a same-name `.js` file** in the same location. A
literal directory path also works (`workflow run ./my/pack`), so a pack can live
in any folder.

### Precedence (manifest defaults vs CLI flags)

CLI flags override manifest values; manifest fields are defaults.

- `--args` shallow-merges over manifest `args` (CLI wins on key conflict;
  non-object `args` replaces entirely).
- `--model` overrides manifest `model`.

### `--dry-run`

`workflow run <pack> --dry-run` validates the manifest + parses the entry script
— no agents, no LLM. The fastest way to check a pack is well-formed.

### Example packs shipped

| pack | location | purpose |
|---|---|---|
| `echo` | `bun-apps/s2-agent/workflows/echo/` | smoke test — one `agent()` echoing args; proves folder → manifest → engine |
| `args-demo` | `bun-apps/s2-agent/workflows/args-demo/` | optional manifest `args` + the `parallel()` primitive; proves packs carry real behaviour |

```bash
./s2-agent.sh cli workflow run echo --dry-run
./s2-agent.sh cli workflow run args-demo --dry-run
./s2-agent.sh cli workflow list   # shows [pack] vs [file]
```

## Two runtimes — pick deliberately

This repo has TWO executors that share the workflow script *syntax*
(`export const meta`, `agent()`, `parallel()`, `phase()`, `log`):

| Runtime | Where | Gates |
|---------|-------|-------|
| **s2-agent-ext-ultracode engine** (`runWorkflow`) | `.pi/workflows/` + `bun-apps/<pkg>/workflows/` (named), or any path, run by `workflow run` or the VSCode editor | real deterministic gate / retry / loopUntilDry / journaling / resume |
| Claude Code's `Workflow` tool | `.claude/workflows/*.js`, run interactively by Claude Code | best-effort `agent()`/`parallel()` — no deterministic gates |

`workflow run` targets the **engine**. That is the whole point: deterministic
gates on the CLI. A "loop" authored with `loopUntilDry` only has its gates when
run through the engine.

> ⚠️ **Parser strictness differs.** The engine parses scripts with a strict
> acorn config (`sourceType: module`, no top-level `import`). Scripts authored
> only for Claude Code's `Workflow` tool may not parse under the engine —
> `workflow run --dry-run` surfaces this immediately. The parser also enforces
> determinism: `Date.now()` / `Math.random()` / no-arg `new Date()` throw (they
> break resume) — get timestamps via an `agent()` Bash call (`date -u`), and the
> literal `Math.random` token is rejected even inside a comment, so reword any
> prose that mentions it.
>
> This is how `.claude/workflows/closed-loop-proof.js` was repaired: three
> authoring bugs (unescaped backticks in a template literal, a `const vault =`
> with its value commented out, and a `${vault}` reference in a scope where it
> was undefined) were surfaced by `--dry-run`, fixed, and the script now runs
> live end-to-end (`s2-agent workflow run closed-loop-proof` → receipt with
> `graphKnowledge.count`, `publishKnowledge.published`, `contract.graphHealth.ok`).

## Engine workflows shipped

| Workflow | Location | Purpose |
|----------|----------|---------|
| `closed-loop-proof` | `.claude/workflows/` *(path-only)* | End-to-end proof of the knowledge-graph closed loop (READ + gate + WRITE) — a live receipt is the proof. |
| `knowledge-distill` | `bun-apps/s2-agent/workflows/` | WRITE-side distill: PR/markdown → atomic vault cards under gate/retry + garden gate. |
| `retrieval-quality-self-improve` | `bun-apps/s2-agent/workflows/` | READ-side retrieval loop: adversarial query-gen → zk-ask in two blend modes → blind judge → receipt + `.knowledge.jsonl`. |

`knowledge-distill` and `retrieval-quality-self-improve` are name-runnable
(`workflow run <name>`). `closed-loop-proof` lives in `.claude/workflows/`, which
is no longer name-resolved — run it by path:
`workflow run .claude/workflows/closed-loop-proof.js --model <spec>`. All accept
`--model <spec>`.

## Why this matters

Before this command, the deterministic engine was reachable **only** from the
VSCode workflow editor. Every automated knowledge task was either a hand-rolled
bash script or a best-effort Claude Code `Workflow` tool call — neither has the
engine's gates. `workflow run` makes any engine workflow a CLI-addressable,
gate-protected, hook-callable one-liner, which is the keystone for the
knowledge-distill and retrieval-quality workflows.
