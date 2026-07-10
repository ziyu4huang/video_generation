# `pi-agent workflow` — headless engine runner

`pi-agent workflow run <name>` runs a [pi-agent-ext-workflow][pdw] engine script
from the CLI, a shell script, or a hook — **headlessly**, without the VSCode
workflow editor. It calls `runWorkflow()` directly, so the deterministic
primitives (gate / retry / loopUntilDry / journaling / resume) are reachable
outside the GUI.

[pdw]: ../bun-apps/pi-agent-ext-workflow/

This is a **non-agent** meta-command. It does NOT spin up an agent session the
way `zk-extract` or `vlm-describe` do. The engine's own `WorkflowAgent` calls
the LLM (via the same `createAgentSession` SDK the rest of the CLI uses — no
VSCode dependency).

## Usage

```bash
bun bun-apps/pi-agent-cli/src/cli.ts workflow run <name> [options]
bun bun-apps/pi-agent-cli/src/cli.ts workflow list
```

### `workflow run <name>`

Resolves `<name>` to a script, then runs it through the engine.

**Script resolution (first hit wins):**

1. `<name>` as a literal path (absolute, or relative to cwd).
2. `.claude/workflows/<name>.js` (repo engine scripts).
3. `bun-apps/<pkg>/workflows/<name>.js` (package-local engine scripts).
4. The literal `<name>` with a `.js` suffix tried in (2) and (3).

**Flags:**

| Flag | Effect |
|------|--------|
| `--args '<JSON>'` | JSON value for the script's `args` global |
| `--model <spec>` | session main model (`id` or `provider/id`); also the default for agents the script leaves untagged |
| `--provider <name>` | provider prefix when `--model` has no `/` |
| `--thinking <level>` | off\|minimal\|low\|medium\|high\|xhigh |
| `--dry-run` | parse + validate the script only (no agents, no LLM) |
| `--no-persist-logs` | skip writing the run log to disk (logs persist by default) |
| `--json` | emit the full receipt + result as JSON |
| `-V` / `--verbose` | show per-phase + per-agent progress |

**Examples:**

```bash
# dry-run: validates the script parses + meta is well-formed (no LLM)
bun bun-apps/pi-agent-cli/src/cli.ts workflow run closed-loop-proof --dry-run

# run with args + an explicit model
bun bun-apps/pi-agent-cli/src/cli.ts workflow run my-workflow \
  --args '{"source":"commit-abc123"}' \
  --model lm-studio/google/gemma-4-26b-a4b-qat

# run a script by path
bun bun-apps/pi-agent-cli/src/cli.ts workflow run ./my-workflow.js --json
```

**Output:** a one-line receipt (`✓ <name> — agents=N Tms (source: …) run=<id> → <kind>`)
plus, under `--json`, the full receipt and result. A run log is written to disk
unless `--no-persist-logs` is set.

### `workflow list`

Enumerates `.claude/workflows/*.js` and `bun-apps/<pkg>/workflows/*.js`, parsing
each script's `export const meta` to print name + description + source dir.
Scripts that fail to parse are reported (not skipped), so a broken script is
surfaced. Use `--json` for machine-readable output.

## Two runtimes — pick deliberately

This repo has TWO executors that share the workflow script *syntax*
(`export const meta`, `agent()`, `parallel()`, `phase()`, `log`):

| Runtime | Where | Gates |
|---------|-------|-------|
| **pi-agent-ext-workflow engine** (`runWorkflow`) | `bun-apps/<pkg>/workflows/` + `.claude/workflows/`, run by `workflow run` or the VSCode editor | real deterministic gate / retry / loopUntilDry / journaling / resume |
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
> live end-to-end (`pi-agent workflow run closed-loop-proof` → receipt with
> `graphKnowledge.count`, `publishKnowledge.published`, `contract.graphHealth.ok`).

## Engine workflows shipped

| Workflow | Location | Purpose |
|----------|----------|---------|
| `closed-loop-proof` | `.claude/workflows/` | End-to-end proof of the knowledge-graph closed loop (READ + gate + WRITE) — a live receipt is the proof. |
| `knowledge-distill` | `bun-apps/pi-agent-cli/workflows/` | WRITE-side distill: PR/markdown → atomic vault cards under gate/retry + garden gate. |
| `retrieval-quality-self-improve` | `bun-apps/pi-agent-cli/workflows/` | READ-side retrieval loop: adversarial query-gen → zk-ask in two blend modes → blind judge → receipt + `.knowledge.jsonl`. |

All three are runnable via `pi-agent workflow run <name> --model <spec>`.

## Why this matters

Before this command, the deterministic engine was reachable **only** from the
VSCode workflow editor. Every automated knowledge task was either a hand-rolled
bash script or a best-effort Claude Code `Workflow` tool call — neither has the
engine's gates. `workflow run` makes any engine workflow a CLI-addressable,
gate-protected, hook-callable one-liner, which is the keystone for the
knowledge-distill and retrieval-quality workflows.
