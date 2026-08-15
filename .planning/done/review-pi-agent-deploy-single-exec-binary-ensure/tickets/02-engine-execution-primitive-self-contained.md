---
type: research
status: closed
---

# 02 — Execution primitive + multi-file survival inside a compiled binary

## Question

How does the engine actually **execute** a resolved pack entry, and does that
primitive work inside `bun --compile`? Does a pack's entry survive if it imports
sibling files (multi-file packs)?

## Resolution

**`node:vm`, portable, and packs are self-contained — multi-file is moot.**

`bun-apps/pi-agent-ext-workflow/src/workflow.ts` executes the pack entry by:
1. Reading the entry script **text** from disk (`workflow-pack.ts` → `ResolvedWorkflow.script`).
2. Parsing with `acorn` (the `export const meta` must be the first statement).
3. Wrapping the body: `` `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()` ``.
4. Running it as `new vm.Script(wrapped, { filename }).runInContext(context)`
   (workflow.ts:970). The `context` (`vm.createContext`) injects **only** host
   functions — `agent`, `parallel`, `pipeline`, `workflow`, `verify`,
   `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`,
   `checkpoint`, `call`, `log`, `phase`, `args`, `cwd`, a frozen `process`,
   `budget`, and a `console` shim. It deliberately injects **no** `require` /
   `import` / `module`.

`node:vm` is a Bun builtin → **works inside `--compile`**. The acorn parse
**rejects `import` statements** (workflow.ts:~998: *"imports are not allowed —
workflows must be self-contained"*). So:

- **Execution is portable** — no file-system module resolution happens at run
  time; the entry is pure text run in a vm sandbox.
- **Multi-file packs do not exist.** A conforming pack is exactly
  `manifest.json` + a self-contained entry `.js`. The `bun-apps/pi-agent-cli/
  workflows/lib/` directory is test infra (a `.mjs` + its `.test.ts`), **not**
  imported by any pack entry.

**Consequence for the destination:** "any user-supplied pack (general runner)"
reduces to "read any self-contained 2-file pack folder from disk and run its
entry text." No module-graph or sibling-import concerns to design around.

**Probe confirmation (2026-07-19 build probe).** Ran the compiled exe from a
**foreign cwd** (`mktemp -d /tmp/pi-probe.*` — verified no `.pi/workflows` /
`bun-apps` ancestry, so `findRepoRoot` returns undefined) against the `echo`
pack by **absolute path** (resolver branch 1):
- `--dry-run` → `✓ echo — agents=0 (source: path) → object {validated}`, exit 0
  (confirms inlined resolver + acorn parse + manifest validate, in-compile).
- **real run** (no `--dry-run`, no `--model` → pi-default `zai/glm-5.2`) →
  `✓ echo — agents=1 1232ms (source: path) run=run-mrqveske → object {echoed, args}`,
  exit 0 in 1.4 s; run log persisted to `$FOREIGN/.pi/workflows/runs/`.
  This executes `vm.Script.runInContext` inside the compiled binary and drives
  one `agent()` call end-to-end. Definitive — `vm` execution is portable.

**Bonus:** the real run used the pi-default model fallback with no `--model`
and no repo-local settings from the foreign cwd → model-resolution portability
is confirmed (clears the map's model-config fog note).
