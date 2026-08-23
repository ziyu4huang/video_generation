# Ticket 02 — ship-bun-and-launcher

status: closed
closed: 2026-08-23 — PR branch feat/deploy-ship-bun-and-launcher (ticket 01 landed
first via PR #1860).

## Resolution (2026-08-23)

- **`deploy/lib/bun-cache.ts`** NEW — mirrors core-cache: `<outRoot>/.buns/<hash>`
  keyed on sha256(bun version + platform + arch); `ensureCachedBun` copies
  `process.execPath` on miss (tmp+rename), `linkBun` hardlinks into
  `<version>/bin/bun` (0o755), `pruneOrphanBuns` collects nlink==1 entries past the
  same 1 h grace window, called from `runShDeploy` beside `pruneOrphanCores`.
- **`s2-agent.sh`** is the launcher (template `S2_AGENT_SH`): body identical to the
  old run.sh below the exec line, which becomes
  `exec env S2-AGENT_CODING_AGENT_DIR=… ${S2_AGENT_BUN:-$SCRIPT_DIR/bin/bun} $SCRIPT_DIR/s2-agent.js "$@"`.
  Header documents the platform contract (bundle neutral, bin/bun per-platform,
  same-Bun.version swap = cross-platform relocation). **`run.sh`** stays as a
  symlink-safe one-line exec shim into it (deprecated).
- **deploy.json** gains `coreKind: "bun-bundle"` + `runtime { bunVersion, platform,
  arch, bytes, cached }`; **deploy-report** renders a `runtime (bin/bun)` row and
  the launcher row names `s2-agent.sh`; `DeployShResult` carries `runtime` +
  `prunedBuns` (deploy-tool fakes updated).
- **Verified**: scratch deploy ×2 to /tmp — first run fresh-copy, second run core +
  runtime both cache hits; `./run.sh --ext-list` boots the FULL chain
  (shim → s2-agent.sh → bin/bun → s2-agent.js) 17/17; `./s2-agent.sh doctor --json`
  reports `sh` with 0 fails; `S2_AGENT_BUN` override honored; deploy L1 e2e 22/22
  (the "run.sh is executed" probe now exercises the whole chain, sandbox-exec
  included); devops full suite 829 green; local_ci overall pass (277 s, incl. the
  L1 e2e gate that now runs against the shipped-bun layout).

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
