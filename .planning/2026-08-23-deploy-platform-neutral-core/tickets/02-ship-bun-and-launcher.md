# Ticket 02 — ship-bun-and-launcher

status: open

blocked-by: `01-core-bundle-seam.md` (the launcher execs the bundle; the bundle must
self-anchor first).

## Goal

Every version dir carries the runtime it needs: `<version>/bin/bun` (copied from the
build machine's `process.execPath`, content-cached), and the launcher is
`s2-agent.sh` exec-ing `bin/bun s2-agent.js` — with `run.sh` kept as a deprecation shim.

## Steps

1. **`deploy/lib/` NEW `bun-cache.ts`** — mirror `core-cache.ts`: `<outRoot>/.buns/
   <hash>/bun` keyed on (Bun.version, process.platform, process.arch); copy
   `process.execPath` into the cache on miss, hardlink into `<stage>/bin/bun` on hit;
   `chmod 0o755`; orphan-prune alongside `pruneOrphanCores` (same grace window, called
   from the same place in `runShDeploy`). Measured bun size: 63,558,256 B (1.4.0) —
   hardlink keeps per-version cost ~0.
2. **`run.ts` `RUN_SH` template → `s2-agent.sh`** — body preserved verbatim (SCRIPT_DIR
   resolution through symlinks, `JITI_FS_CACHE`, dashed `S2-AGENT_CODING_AGENT_DIR`
   via `env`, system-Chrome probe for puppeteer); the final line becomes
   `exec env "S2-AGENT_CODING_AGENT_DIR=$_agent_dir" "$SCRIPT_DIR/bin/bun"
   "$SCRIPT_DIR/s2-agent.js" "$@"`. Header comment states the platform contract:
   the bundle is neutral, `bin/bun` is this platform's — swap it (same Bun.version)
   to relocate across platforms.
3. **`run.sh` stays as a one-line shim** — `exec "$(dirname …)/s2-agent.sh" "$@"` with a
   deprecation comment; drop in a later effort. Written by `runShDeploy` beside
   `s2-agent.sh` (same 0o755).
4. **`deploy.json`** — record `coreKind: "bun-bundle"`, `bunVersion`, `bunPlatform`,
   `bunArch`, `bunBytes` (+ `cached` like the core row); `deploy-report.ts` renders bun
   as its own row next to the core row.
5. **Tests** — bun-cache unit tests mirroring core-cache's (miss/copy, hit/link, orphan
   prune); launcher integration inside the existing deploy tests: the emitted
   `s2-agent.sh` execs `bin/bun` with the dashed env intact (assert on file contents +
   a staged boot where feasible).

## Done-when

- A scratch deploy's version dir contains `bin/bun` (hardlink, 0o755), `s2-agent.sh`,
  the `run.sh` shim, `s2-agent.js` + assets; second deploy with unchanged bun is a
  cache hit (no 63 MB copy).
- `<stage>/s2-agent.sh --ext-list` loads the full expected set from inside the staged
  tree with no environment prerequisites beyond `PATH`-less defaults; `run.sh` still
  works and forwards.
- `bun test` green in s2-agent-ext-devops.
