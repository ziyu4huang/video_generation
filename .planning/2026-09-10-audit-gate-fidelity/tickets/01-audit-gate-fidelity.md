---
type: task
status: open
---

# 01 — audit-gate-fidelity: derive gates from package scripts + install preflight

## Question

Can the committed audit instrument measure each package by ITS OWN gates —
with per-gate provenance and an install preflight — so the file2md/hyperframes
class of fake red cannot recur?

## What to build

In `bun-apps/s2-agent-ext-ultracode/samples/audit-ext-packages.js` (and its
driver path via `samples/run.ts`): the child prompt for each package is
generated from that package's `package.json` `scripts` — `check`, `typecheck`,
`test` become the exact commands the auditor runs; a gate with no script is
instructed to report `absent` — with NO bare-command fallback (decision
tightened during implementation 2026-09-09: bare `bun test` in a package
without a test script is precisely the node_modules sweep that faked
hyperframes' red, so absent is recorded and ranked improvement room instead).
The result schema gains per-gate command provenance (e.g. `testCommand`) so
every verdict is re-runnable verbatim. The driver runs the workspace install preflight
(`bun install` from `bun-apps/`) before fanning out and records it in the
receipt; module-resolution-style failures classify as `env-drift`, a distinct
verdict from red. Extend the static-contract test
(`tests/audit-ext-packages.test.ts`, fake runner) to pin: per-package command
derivation, `absent` gates, provenance fields in the schema, and the
preflight step. End-to-end sanity: run the fixed audit over 2–3 sample
packages (file2md, hyperframes, zai-mcp) and confirm the verdicts match
today's hand-measured receipts (file2md green after install; hyperframes
green via `bun test tests/`; zai-mcp test `absent`).

## Acceptance

- [x] The audit script derives gate commands from package.json scripts (no
      hard-coded bare `bun test` except the labeled no-script fallback —
      tightened in-session to NO bare fallback at all; see What to build)
- [x] Result schema carries per-gate command provenance; `absent` is a
      distinct recorded verdict, never silently passed
- [x] Install preflight runs before gates and is recorded in the receipt;
      `env-drift` is a distinct verdict class from red
- [x] Static-contract unit test pins derivation + provenance + preflight
- [x] Sample run over file2md/hyperframes/zai-mcp matches the hand-measured
      receipts; `bun run check` in ultracode stays green
      (scripts-dir-contract untouched)

## Resolution (2026-09-09)

Implemented on `self-arc18-t01-gate-fidelity`; PR via the devops chain.
Rewrote `samples/audit-ext-packages.js` (Preflight phase → per-package
auditors with script-derived gates + provenance → synthesizer with
env-drift/absent classification) and `tests/audit-ext-packages.test.ts`
(6 static pins). Independent reviewer: REQUEST_CHANGES (4 findings —
env-drift counted as red, unguarded preflight null, symlink-glob false
DANGLING, frozen-log overwrite) → all applied → **VERDICT: APPROVE**
(transcript: `~/.zcode/cli/agents/sess_d63c865d-4a50-49ac-bf85-2affba364d54/agent_5bf807b3-dd9c-4727-8f20-239fd4c99dca/output.txt`).
Gates: ultracode check exit 0 / typecheck exit 0 / test:unit 1240 pass · 0
fail. LIVE receipt (`output/self-arc18-t01-sample-run.json`, real zai/glm-5.3,
5 children, ~7 min wall): preflight frozenExit=0 / lockfileDrift=false /
dangling=0; file2md ALL PASS via `biome check .` / `tsc --noEmit` /
`bun test --isolate`; hyperframes ALL PASS via its own `bun test tests/`
(check absent recorded); zai-mcp check+test absent recorded; 0 red,
0 env-drift; synthesizer: zero real failures, gaps = improvement room.

closed: (implemented — PR self-arc18-t01-gate-fidelity)
