# Upstream provenance — pi extension packages

Recorded 2026-08-10. The `memory` tool was unavailable this session, so this committed doc is the durable record of where each pi extension package in `bun-apps/` originates. Use it to decide whether a change is fork-local or should be ported back upstream.

## pi-agent-ext-subagent

- **Local package:** `bun-apps/pi-agent-ext-subagent/` — npm name `@repo/pi-agent-ext-subagent` (v0.1.0)
- **Upstream repo:** **pi-subagents** — https://github.com/nicobailon/pi-subagents (ssh: `git@github.com:nicobailon/pi-subagents.git`)
- **Upstream local checkout:** `/Users/huangziyu/proj/pi-subagents` (pkg `pi-subagents`, v0.45.1 at capture; HEAD `67b4f60`)
- **Dual provenance:**
  - The package's own description states it was *"Extracted from pi-agent-ext-workflow as a lower-dependency library"* — i.e. the code originally came from the workflow extension in THIS repo.
  - Separately, there is a selective upstream-sync target of `pi-subagents`, documented in `bun-apps/pi-agent-ext-subagent/docs/upstream/pi-subagents.pin.md` (a selective port, not a full mirror).

## pi-agent-ext-workflow

- **Local package:** `bun-apps/pi-agent-ext-workflow/` — npm name `@repo/pi-agent-ext-workflow` (v2.9.0)
- **Upstream repo:** **pi-dynamic-workflows** — https://github.com/QuintinShaw/pi-dynamic-workflows (ssh: `git@github.com:QuintinShaw/pi-dynamic-workflows.git`)
- **Upstream local checkout:** `/Users/huangziyu/proj/pi-dynamic-workflows` (npm pkg `@quintinshaw/pi-dynamic-workflows`, v3.5.1 at capture; HEAD `bab5ad7`)
- This package's own `package.json` `repository.url` already points at the upstream (`git+https://github.com/QuintinShaw/pi-dynamic-workflows.git`).

## Implication for ongoing work

The active effort `.planning/2026-08-10-simplify-recent-code/` (Phase 2: extract `src/workflow.ts` into `workflow-script-parser` / `workflow-timeout` / `workflow-stdlib` / `workflow-runtime` modules + `createStdlib` / `createRuntime` factories) modifies code whose origin is `pi-dynamic-workflows`. These are **fork-local structural refactors**; if upstreaming to `pi-dynamic-workflows` is ever desired, the extraction would need to be ported back.

## Capture method

GitHub URLs captured via `git remote -v` in each upstream checkout on 2026-08-10; corroborated by the packages' own docs (`pi-subagents.pin.md`, README "Upstream sync" sections, `CONTEXT.md`, `package.json repository.url`).
