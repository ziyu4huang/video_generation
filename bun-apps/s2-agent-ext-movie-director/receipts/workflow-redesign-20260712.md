# Workflow Integration — movie-director × s2-agent-ext-workflow

**Date:** 2026-07-12
**Plan:** `.planning/movie-workflow-redesign/`
**Status:** implemented + structurally verified; full GPU e2e deferred (see below)

## What was built

Additively layered movie-director's deterministic orchestration (`dispatch()`)
onto the workflow runtime, with **zero regression** to the existing `movie` tool
and standalone CLI. Three new surfaces:

### 1. `movie.*` host-fn bridge (deterministic, zero-token)
- `src/host-fns.ts` — `buildMovieHostFnEntries()` wraps all 20 `dispatch()`
  commands as `movie.<command>` host-fns + a `movie.dispatch` escape hatch;
  `buildMovieHostFnRegistry()` returns a duck-typed `{get,has,list}` for
  `runWorkflow({ hostFns })`.
- `extensions/movie-host-fns.ts` — `registerMovieHostFns(pi)` emits the entries
  over the `workflow:hostfn:v1:register` event bus + re-emits on request
  (knowledge-card `zk.*` pattern). Wired into `movie-director.ts`.

The full surface (callable from any workflow script):
`movie.preflight | pipeline-list | pipeline-show | init-project | list-projects |
next-stage | write-checkpoint | read-checkpoint | validate-artifact | generate |
compose | compose-remotion | compose-motion | pre-compose | final-review |
cost-estimate | cost-reserve | cost-reconcile | cost-snapshot | read-decision-log |
movie.dispatch` (escape hatch: `{command, options}`).

### 2. Four saved workflow commands
- `/produce-video` — full pipeline (init→idea→research/proposal→script→scene_plan→assets→edit→compose→publish) as one journaled-resumable workflow; composes the other three.
- `/scene-assets` — parallel per-scene T2I→I2V (chained for long scenes)→TTS.
- `/research-first` — parallel web research → `verify()` cross-check → proposal synthesis.
- `/review-cut` — `movie.final-review` probe + `verify()` adversarial review; gates publish.

### 3. Registration machinery
- `extensions/movie-workflows.ts` — `registerMovieWorkflows(pi, cwd)` runs each
  `.js` via `runWorkflow` with: explicit `hostFns` (the spike proved `runWorkflow`
  does NOT auto-wire the event bus), `loadSavedWorkflow` (so `/produce-video`'s
  nested `workflow(...)` calls resolve), and coding+web tools (for `/research-first`).

## Keystone findings (from the Phase-1 spike)

| Finding | Resolution |
|---|---|
| `runWorkflow` takes `options.hostFns` explicitly; the event bus only populates the workflow *extension's* manager registry | movie-director's own `/command` handlers build + pass `buildMovieHostFnRegistry()` themselves |
| `HostFnRegistry` is not in workflow's public exports | duck-type `{get,has,list}` — `call()` only reads `hostFns.get(name)`. Zero coupling, proven equivalent |
| workflow `dist/` was stale (predated the `call()` global feature) | **prerequisite:** run `( cd bun-apps/s2-agent-ext-workflow && bun run build )` whenever workflow src changes. dist is gitignored |
| workflow applies a host-fn's `schema` to the RETURN value, not args | dropped per-command schemas (input-shape schemas failed output validation); schemaless matches the `zk.*` pattern; dispatch already validates inputs/artifacts |

## Resume + cost model

- **Resume (the headline robustness win):** workflow's journaled resume covers
  BOTH `agent()` and `call()`. A `/produce-video` that crashes mid-assets
  (the documented 2026-07-12 kernel-panic data-loss class) replays finished
  agents + host-fn calls from the journal and runs only what's left.
- **Two-layer cost (complementary):** workflow `budget` tracks agent token cost;
  movie-director's `estimate→reserve→reconcile` lifecycle tracks media-generation
  `$` cost (inside `call('movie.generate')`). Both survive resume.

## Verification evidence

| Check | Result |
|---|---|
| `src/host-fns.test.ts` — 20 cmds registered, NAME_RE, timeouts, routing, dispatch hatch, registry shape | 13 pass |
| `extensions/movie-workflows.test.ts` — every workflow parses + every `call('movie.*')` ref resolves against the registry | 9 pass (4 workflows × 2 + 1) |
| Runtime routing proof — `call('movie.read-checkpoint')` resolved inside `scene-assets.js` via the explicit registry; returned `{checkpoint:null}`, reached script validation (`tokens:0`) | PASS |
| Full package suite (no regression) | **467 pass / 0 fail / 8 skip** |

## Deferred: full GPU e2e

A real `/scene-assets` → `/produce-video` run needs a model (for the ffmpeg
last-frame `agent()` calls + creative agents) and GPU (T2I/I2V). Reproduce when
both are available:

```bash
# prerequisite: workflow dist in sync with src
( cd bun-apps/s2-agent-ext-workflow && bun run build )

# load both extensions and run the flagship end-to-end
bun bun-apps/s2-agent/src/cli.ts \
  -e bun-apps/s2-agent-ext-movie-director \
  -e bun-apps/s2-agent-ext-workflow \
  -p "/produce-video concept='a 15s animated explainer about how tides work'"
```

Or drive a single workflow directly (library-level, no TUI):

```bash
bun bun-apps/s2-agent-ext-workflow/samples/run.ts \
  bun-apps/s2-agent-ext-movie-director/workflows/scene-assets.js \
  '{"scenes":[{"id":"s1","type":"generated","description":"a red cube rotating on a white table","start_seconds":0,"end_seconds":2}]}'
```

## Files

```
src/host-fns.ts                      # adapters + buildMovieHostFnRegistry
src/host-fns.test.ts                 # 13 unit tests
extensions/movie-host-fns.ts         # event-bus registration (workflow-ext runs)
extensions/movie-workflows.ts        # /command registration (own runWorkflow runs)
extensions/movie-workflows.test.ts   # structural test (parse + ref resolution)
extensions/movie-director.ts      # wired: registerMovieHostFns + registerMovieWorkflows
workflows/scene-assets.js
workflows/research-first.js
workflows/review-cut.js
workflows/produce-video.js
package.json                         # + @repo/s2-agent-ext-workflow workspace dep
```
