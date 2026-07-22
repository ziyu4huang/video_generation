# pi-agent-ext-deploy

Two dynamic, tool-gated tools that wrap the existing build/verify/deploy scripts.

## Tools
- **pi_deploy** — build + deploy the pi-agent bundle + thin extension bundles. Mirrors `bun-apps/pi-agent/scripts/deploy.ts` (codegen → bundle → ext bundles → factory-verify → freeze). Params: `mode` (bundle|snapshot|standalone|exe, default bundle), `outDir` (path-guarded to `<repo>/dist/` or `$TMPDIR`), `noFreeze`.
- **pi_verify** — run a `run-test.sh` tier (quick|medium|high|readonly|full, default medium). `high` = the exact CI `deploy -- verify` job. Params: `tier`, `bail`.

## Layout
- `extensions/deploy.ts` — registered entry (re-exports the factory).
- `src/index.ts` — factory; registers both tools.
- `src/argv.ts` — PURE param→argv mapping (unit-tested, isolated from spawning).
- `src/run.ts` — locate the source `bun-apps/pi-agent` dir (`PI_AGENT_DIR` env or upward walk), path-guard `outDir`, spawn helper with timeout + log file.
- `src/deploy-tool.ts` / `src/verify-tool.ts` — run + parse each script's output into a structured result.

## Invariants
- `deploy.ts` and `run-test.sh` are the single source of truth — no deploy logic is duplicated.
- Scripts exist only in the **source repo**; the tools resolve that dir and refuse to spawn if unreachable (never a wrong-cwd spawn). Set `PI_AGENT_DIR` to override.
- No top-level `cd`; spawn uses `cwd: <absolute pi-agent dir>`.
- Dynamic + tool-gated (keywords build/deploy/verify/bundle/dist); not static.
