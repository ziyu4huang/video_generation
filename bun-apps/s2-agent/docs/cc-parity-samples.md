# CC-parity samples — s2-agent vs Claude Code's documented subagent & ultracode use cases

Every row below is an **executable, committed sample** in this repo that mirrors a
COMMON pattern from Claude Code's official docs — parity is proven by green named
assertions, not prose. Run the whole suite with the two commands at the bottom.

Sources mirrored:
- Subagents: <https://code.claude.com/docs/en/sub-agents> ("Common patterns" + the
  canonical code-reviewer example)
- Ultracode/dynamic workflows: <https://code.claude.com/docs/en/workflows>
  ("Example workflow prompts" + script primitives `agent()` / `parallel()` /
  `pipeline()` / `phase()` / `log()` / `args` / `meta` / null-for-stopped filtering)

## Subagent patterns (`s2-agent-ext-subagent`)

| Sample | CC doc pattern | What the green assertions prove | File |
|---|---|---|---|
| A1 | [Isolate high-volume operations](https://code.claude.com/docs/en/sub-agents) | The parent-facing tool result is the child's compact final message (corpus prose never crosses the boundary); the child carries the read tools to do the heavy reading in its own context; the run is durably recorded. | `bun-apps/s2-agent-ext-subagent/tests/cc-parity-subagent.test.ts` |
| A2 | Run parallel research | 3 read-only corpus probes fan out through the `subagents` batch tool; positional results return in input order; every child excludes edit/write/bash (non-overridable `READ_ONLY_EXCLUDED`). | same file |
| A3 | Chain subagents | Spawn #2's task carries spawn #1's output token (result-plumbing seam); the model-driven chaining behavior is receipted live by the tui-drive `cc-parity` scenario. | same file |
| A4 | Code-reviewer example (read-only, tools exclude Edit/Write) | A `cc-code-reviewer` definition binds its allowlist/denylist/prompt at the spawn seam, surfaces the planted defect in `tests/fixtures/cc-parity/planted-bug.ts`, and the reviewed file is sha256-identical after the review. | same file (+ `tests/fixtures/cc-parity/`) |

## Ultracode workflow use cases (`s2-agent-ext-ultracode`)

Real scripts under `samples/cc-parity/`, executed by the real `WorkflowManager`
with a deterministic content-keyed runner — no LLM in unit gates.

| Sample | CC workflows-doc use case | What the green assertions prove | Files |
|---|---|---|---|
| B1 | Audit many files for the same issue | `pipeline()` fans out one audit agent per file, verifies each verdict, and collects exactly the planted issue set (`samples/cc-parity/audit-corpus/`). | `samples/cc-parity/audit-many-files.js` + `tests/cc-parity-workflows.test.ts` |
| B2 | Keep fixing until a check passes | Bounded fixer→checker loop exits early on PASS and stops AT maxAttempts with `bounded:true` when never passing (stateful runner covers both paths). | `samples/cc-parity/verify-fix-loop.js` + test |
| B4 | Review every changed file and write one summary | `parallel()` reviewer per file; the one synthesizer's prompt carries every per-file finding; the run's final result is the synthesis. | `samples/cc-parity/review-per-file.js` + test |
| B5 | Research a topic across many sources | A stopped reader (empty output → runtime's recoverable-null slot) is dropped by the doc's `.filter(Boolean)` idiom; the synthesizer still runs on the survivors. | `samples/cc-parity/research-fanout.js` + test |
| B6 | Find issues until the list stops growing | Already receipted by the convergence loop: `samples/kcard-converge-loop.js` (`loopUntilDry`) — mapped, not duplicated. | `samples/kcard-converge-loop.js` |
| B3 | Migrate many files in parallel | `parallel()` writers with per-child `isolation: "worktree"` (`workflow-runtime.ts`): each child writes in its own `<repoRoot>/.pi/worktrees/` copy, the parent tree is untouched, teardown is per-call. NOTE: the batch `subagents` tool stays read-only by design (`READ_ONLY_EXCLUDED` — concurrent children share ONE tree); isolated WRITES are a workflow-layer capability. | `samples/cc-parity/migrate-in-parallel.js` + `tests/cc-parity-migrate.test.ts` (self-arc-13) |

Formerly descoped: B3 was "deliberately NOT sampled" in self-arc-12 because the
batch tool forbids writable fan-out. Self-arc-13 completed it at the workflow
layer, where per-child worktree isolation is the designed mechanism — the
batch tool's read-only rule is unchanged and remains the feature it was.

## Live receipts (real children, real TUI)

`tui-drive --scenario cc-parity` (in `s2-agent-ext-subagent/scripts/`) drives the
real TUI through chain + code-reviewer with real `zai/glm-5.3` children
(never flash; the `childModelIsGlm53` receipt check enforces it) — source tree and
deployed tree both. This is where the *model-driven* halves of A3/A4 and the
workflows doc's "one request → several workflows" behavior are proven.

## Run

```sh
( cd bun-apps/s2-agent-ext-subagent && bun test tests/cc-parity-subagent.test.ts )
( cd bun-apps/s2-agent-ext-ultracode && bun test tests/cc-parity-workflows.test.ts )
```

Headless real run of any workflow sample:

```sh
bun bun-apps/s2-agent-ext-ultracode/samples/run.ts \
  bun-apps/s2-agent-ext-ultracode/samples/cc-parity/audit-many-files.js \
  '{"filenames":["bun-apps/s2-agent-ext-ultracode/samples/cc-parity/audit-corpus/planted-todo.ts"]}'
```
