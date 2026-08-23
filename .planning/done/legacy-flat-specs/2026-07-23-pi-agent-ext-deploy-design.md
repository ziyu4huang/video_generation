# pi-agent-ext-deploy — Build / Verify / Deploy Tools (Design)

**Date:** 2026-07-23
**Package:** `bun-apps/pi-agent-ext-deploy` (new)
**Status:** Design (pending implementation plan)
**Driver:** human-in-chat — the user asks the agent to build/verify/deploy and the agent invokes the tool as a one-off.

## Context & motivation

Today the pi-agent bundle + extension bundles are built/verified/deployed only by
running raw shell commands: `bun scripts/deploy.ts` (build+deploy) and
`bun-apps/pi-agent/run-test.sh <tier>` (verify). There is no agent-callable
surface for this. `pi-agent-cli` has ~22 subcommands but none for deploy/build.
The closest existing extension, `power-tool`, is agent self-introspection
(inspect_context / inspect_agent / bash) — a different concern.

This spec adds a **new, dedicated, dynamic** extension that exposes two tools —
`pi_deploy` and `pi_verify` — as thin structured wrappers over the existing
scripts. The scripts stay the single source of truth; the tools build argv,
spawn, parse, and return a concise result + log path.

The deploy-verify regression fixed in #756 (an unanchored regex in
`build-extensions.ts` misreading `is-unsafe`'s SQL catalog) is exactly the kind
of failure a future agent-driven self-heal loop would catch — but that loop is
out of scope here (see YAGNI). This extension is the foundation for it.

## Decisions (confirmed in brainstorming)

1. **New dedicated extension** (not added to `power-tool`). Matches the repo's
   one-extension-per-domain convention (flux2, ltx, krea2, research-tool,
   movie-director…). Build/verify/deploy is a distinct domain.
2. **Two tools:** `pi_deploy` (build + deploy, mirrors deploy.ts) and `pi_verify`
   (forwards to run-test.sh). Verify is separate because it is slow and is run
   independently / selectively.
3. **Dynamic registration** — `manifest.json` `extensions[]`, activated by the
   tool-gate on keywords `build`/`deploy`/`verify`/`bundle`/`dist`, or `-e deploy`.
   Not static (keeps the schema baseline lean).
4. **`pi_verify` is tier-selectable** — `quick|medium|high|readonly|full`,
   default `medium`.
5. **Human-in-chat driver** — a normal agent tool; no heavy autonomous-loop
   output contract required (though structured results are still returned).

## Scope & invariants

- **No duplicated logic.** `deploy.ts` and `run-test.sh` remain the only sources
  of truth. The tools only build argv, spawn, and parse output.
- **argv logic is pure + unit-tested.** All flag/mode/tier→argv mapping lives in
  `argv.ts`, isolated from spawning.
- **No top-level `cd`.** Spawn uses `cwd: <absolute bun-apps/pi-agent>` (repo
  shell discipline).
- **No network.** Both scripts are local; the tools add no network calls.
- **Capped.** Every spawn has a timeout (no unbounded long-running ops).

## Module layout

```
bun-apps/pi-agent-ext-deploy/
├─ extensions/deploy.ts        ← registered entry (1-line re-export of src factory)
├─ src/
│  ├─ index.ts                 ← factory: registers pi_deploy + pi_verify
│  ├─ argv.ts                  ← PURE: buildDeployArgv(params), buildVerifyArgv(params)
│  ├─ run.ts                   ← spawn helper: cwd-locked, capture+log, path guard, timeout
│  ├─ deploy-tool.ts           ← pi_deploy: argv → run → parse result
│  └─ verify-tool.ts           ← pi_verify: tier → run-test.sh → parse per-tier summary
├─ __tests__/                  ← argv unit (pure) + path-guard + spawn-mock; real e2e PI_AGENT_E2E-gated
├─ package.json + CONTEXT.md
```

## Tool contracts

### `pi_deploy` (build + deploy)

Mirrors `bun scripts/deploy.ts`.

| param | type | default | notes |
|---|---|---|---|
| `mode` | enum `bundle \| snapshot \| standalone \| exe` | `bundle` | deploy.ts flags |
| `outDir` | string (optional) | `dist/pi-agent` | **path-guarded** — must resolve under repo `dist/` or `os.tmpdir()`; else rejected |
| `noFreeze` | boolean | `false` | `--no-freeze` (skip chmod a-w) for dev |

Result:
```ts
{
  ok: boolean;
  mode: string;
  outDir: string;
  piAgentJsBytes?: number;                     // parsed from "✓ pi-agent.js (10.4 MB)" line
  extBundles: { built: number; failed: string[] }; // from build-extensions summary line
  exitCode: number;
  logPath: string;                             // full stdout/stderr in /tmp
  errorTail?: string;                          // last ~40 lines, only when ok=false
}
```

### `pi_verify` (run a run-test.sh tier)

Forwards to `./run-test.sh <tier>`.

| param | type | default | notes |
|---|---|---|---|
| `tier` | enum `quick \| medium \| high \| readonly \| full` | `medium` | exact run-test.sh tiers |
| `bail` | boolean | `false` | forwards `--bail` |

Result:
```ts
{
  ok: boolean;                                 // exit code 0
  tier: string;
  steps?: { name: string; passed: boolean; seconds: number }[]; // parsed "✓/✗ <name> (Ns)"
  logPath: string;
  errorTail?: string;
}
```

Both return `logPath` + `errorTail` so the agent can decide next-step from the
structured fields + tail, and read the full log only when needed (no
multi-hundred-KB dump into the tool result).

## Subprocess, safety & output handling

**`run.ts` — `runScript({ cmd, args, cwd, env?, logFile, timeoutMs })` → `{ exitCode, logPath }`:**
- `cwd` is the absolute `bun-apps/pi-agent` dir.
- Tee stdout+stderr to `/tmp/pi-deploy-<pid>.log` AND capture in memory.
- Caller parses its slice and builds `errorTail` (last ~40 lines) only on failure.
- **Timeouts:** deploy 5 min; verify scaled — quick 60s, medium 5m, high/full 15m, readonly 5m. On timeout: kill process tree, `errorTail = "<op> exceeded <cap>s"`, return `ok:false`.

**Safety (defense-in-depth):**
1. **Path guard** on `pi_deploy.outDir` — reject unless under `<repo>/dist/` or `os.tmpdir()`.
2. **Closed-enum mode/tier** at the argv layer (deploy.ts also rejects unknown flags).
3. `pi_verify` has no path param and only ever invokes run-test.sh (builds into `$TMPDIR`).
4. No network in either tool.

**Locating the pi-agent dir:**
- Bundle mode: the baked `BUN_APPS_DIR`/run-dir-base that `resolve.ts` exposes (same path other bundled extensions use for repo-relative files).
- Source/dev mode: `import.meta.dir`-relative walk, or `PI_AGENT_DIR` env override.
- Unresolvable → `ok:false` with `"could not locate pi-agent dir; set PI_AGENT_DIR"` (no wrong-cwd spawn).

## Registration, gating & schema cost

- `bun-apps/pi-agent/run-dir/manifest.json` → `extensions[]`:
  `"pi-agent-ext-deploy/extensions/deploy.ts"`.
- **tool-gate keywords:** `build`, `deploy`, `verify`, `bundle`, `dist`. Activates
  the extension on keyword match; else stays out of the schema. Also `-e deploy`.
- **Not** in `static-extensions.ts` (avoids double-register).
- **Schema-cost canary** measures it automatically (in `manifest.json`); keep
  descriptions ≤2 lines each.

## Testing

- **`argv.ts` pure unit tests:** `buildDeployArgv({mode:"standalone",noFreeze:true})` →
  `["scripts/deploy.ts","--standalone","--no-freeze"]` (+ outDir positional when given);
  `buildVerifyArgv({tier:"high",bail:true})` → `["run-test.sh","high","--bail"]`;
  defaults mode→bundle, tier→medium.
- **`run.ts` path-guard unit tests:** under `dist/` ✓, under `/tmp` ✓, source tree ✗, `/etc` ✗.
- **Spawn-mock tests** (inject the spawn fn): assert cwd/argv/log-file behavior without a real 50s deploy.
- **Real e2e (gated `PI_AGENT_E2E=1`):** `pi_deploy` mode=bundle into temp outDir →
  `ok:true`, `extBundles.built === manifest count`, `failed:[]`; `pi_verify` tier=quick → `ok:true`.
  Skipped in normal `bun test` so CI stays fast.
- **Cross-package typecheck** (REQUIRED CI gate): `bun run --cwd bun-apps/pi-agent typecheck` EXIT 0.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| argv drift from deploy.ts/run-test.sh flag changes | argv.ts is the single pure mapping, fully unit-tested; deploy.ts also rejects unknown flags. |
| LLM points deploy at a destructive path | path guard: `dist/` or `os.tmpdir()` only. |
| Long verify blocks the session | per-tier timeout cap; log to file, return summary. |
| pi-agent dir unresolvable in a foreign cwd | explicit resolve + `PI_AGENT_DIR` fallback; fail loudly, never wrong-cwd spawn. |
| Schema cost | dynamic + gated; descriptions ≤2 lines. |
| Cross-package typecheck (REQUIRED CI) | implements the standard ExtensionFactory contract; measured by canary. |

## Rollback

Dynamic + keyword-gated: if problematic, remove the `manifest.json` line and the
extension never loads. No upstream behavior change (deploy.ts / run-test.sh
untouched).

## Explicit YAGNI (not in v1)

- No `cli-subcommand.ts` facade (`bun-pi-agent-cli deploy`) — add later.
- No `pi_clean` / `pi_dist_info` / deploy-history / metadata DB.
- No deploy-verify self-heal loop (future effort; this extension is its foundation).
- No git/PR integration — the tools build/verify/deploy only.
