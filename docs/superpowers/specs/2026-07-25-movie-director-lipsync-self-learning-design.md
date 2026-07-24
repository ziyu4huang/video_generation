# movie-director Lipsync Self-Learning — Design

**Goal:** talking-head video (image + audio-track → mouth movement, produced via
`native-i2v` + `run.py video lipdub`) currently produces no durable record of
what worked or failed. Every investigation into a bad result starts from zero.
This adds a new `evaluate-lipsync` command: given a produced video plus the
parameters that made it, it scores mouth-motion-vs-audio correlation and
returns a `lesson` the agent is instructed to persist via hermes-memory's
existing tools — so future generations can be informed by past ones instead of
repeating the same failed combinations.

**Architecture:** Single-package change, `pi-agent-ext-movie-director` only.
`hermes-memory` already exposes the two tools this needs (`memory` for writing,
`memory_search` for querying) — no changes to that package. The link between the
two extensions is a documented agent-facing contract (skill/doc instructions),
not a code import: this repo has no precedent for one extension importing
another's internals, and movie-director's own ubiquitous language is explicitly
agent-first ("the agent reads manifests + stage skills and drives the run; code
is only tools + persistence" — `pi-agent-ext-movie-director/CONTEXT.md`).

**Background (why this shape, not another):** This was scoped down three times
during brainstorming/planning:

1. First cut proposed a new movie-director-owned JSONL store; storing in
   hermes-memory was preferred so lessons are visible through the same memory
   surface as everything else, and searchable.
2. Second cut proposed movie-director importing hermes-memory's `MemoryStore`
   class directly as a workspace dependency; rejected in favor of agent
   tool-calls — no cross-extension import precedent exists in this repo, and it
   turned out unnecessary: hermes-memory's existing `memory` tool already
   supports exactly the shape needed (`target: "failure"`, `category:
   "tool-quirk"` for negative lessons; `target: "memory"`, `category:
   "insight"` for positive ones), and `memory_search` already filters by
   `category`. This plan touches zero files in `pi-agent-ext-hermes-memory`.
3. Third cut proposed hooking this into `generate`'s `command: "lipdub"` case.
   Dropped once the code showed **`lipdub` isn't wired into `generate` at
   all** — `registry.ts`'s `video_generation` capability only has two
   providers, `swift:ltx` (native-i2v etc.) and `mlx:runpy` (`run.py video
   t2i2v` only); `run.py video lipdub` has no bridge adapter anywhere in
   `pi-agent-ext-movie-director` or `pi-agent-ext-ltx`. This session's own
   dialogue-scene work called Swift `native-i2v` and Python `run.py video
   lipdub` as two independent shell calls, never through movie-director's
   `generate` — matching how any real caller would actually produce a lipdub
   video today. So `evaluate-lipsync` is a standalone command that takes an
   already-produced video path + the parameters used, decoupled from *how*
   that video was made. (Wiring `lipdub` into `generate` as a first-class
   provider is a separate, larger project — out of scope here.)

This design was motivated directly by the 2026-07-25 dialogue-scene-v2/v3/v4
iteration (see `2026-07-24-dialogue-driven-scene-design.md` and this session's
history): five separate manual investigations (portrait swap, voice swap,
prompt-enrichment, full identity swap, seed sweep) were needed to find that (a)
an "expressive" prompt actively suppresses mouth motion, and (b) native-i2v
motion amplitude is a probabilistic function of `(seed, audio content)`, not a
fixed property of an identity. None of that was captured anywhere reusable —
the next dialogue scene would start from the same zero.

## Component: `python -m app.lipsync_metrics` adapter

**New file:** `bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts` —
mirrors `runpy_tts.ts`'s shape exactly (same `_spawnImpl` test seam, same
`resolveRepoRoot`/`resolveRunPyPaths` resolution from `@repo/pi-agent-ext-ltx`),
adapted for a module invocation instead of `run.py <subcommand>`:

```
python -m app.lipsync_metrics <video_path>
```

run with `cwd = <repoRoot>/python/mlx-movie-director` (required for the `app.`
import to resolve — confirmed via `lipsync_metrics.py`'s own `__main__` block:
`python -m app.lipsync_metrics <mp4_path>`, printing `json.dumps(result,
indent=2)` to stdout). Parses stdout into `{ verdict, pearson_r,
mouth_ratio_std, caveat? }` (the exact fields `lipsync_metrics.py` already
returns — see `measure_lipsync_precision`'s callers this session).

Unlike `runpy_tts`'s best-effort-swallow-and-continue posture (which protects
an already-succeeded generation), `evaluate-lipsync` IS the action — a spawn
failure, non-zero exit, or non-JSON stdout is a real `{ok: false, error}`
result, not silently swallowed.

## Component: `evaluate-lipsync` dispatch command

**File:** `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts` — new entry in
the `COMMANDS` array (currently `dispatch.ts:66-88`) and a new `case
"evaluate-lipsync":` in the `dispatch()` switch, following the exact
`missingFields` + `jsonOut` pattern already used by every other simple command
(e.g. `"validate-artifact"`, `dispatch.ts:472-479`).

**Input:** `{ videoPath (required), seed?, promptSummary?, identityRef?,
voice? }` — the caller (agent) supplies the parameters it used to produce the
video, since `evaluate-lipsync` has no way to infer them from the file alone.

**What runs:** calls `runPyLipsync({ videoPath })`; on success, builds a
`LipsyncLesson` via a new pure function and returns `{ metrics, lesson }`.

**New file:** `bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.ts` — a
small, focused, independently testable module (mirrors `decision-log.ts`'s
shape):

```ts
export interface LipsyncLesson {
  target: "failure" | "memory";
  category: "tool-quirk" | "insight";
  content: string;
  reason?: string;
}

export interface LipsyncLessonInput {
  verdict: string;
  pearsonR: number | null;
  mouthRatioStd: number | null;
  seed?: number;
  promptSummary?: string;
  identityRef?: string;
  voice?: string;
  caveat?: string;
}

export function buildLipsyncLesson(input: LipsyncLessonInput): LipsyncLesson { ... }
```

`verdict === "adequate"` → `target: "memory"`, `category: "insight"`.
Anything else → `target: "failure"`, `category: "tool-quirk"`, `reason` set
from `caveat` (falling back to the verdict string). `buildLipsyncLesson` is
pure (no I/O), fully unit-testable without mocking the filesystem or a process
spawn.

## Component: agent-facing contract (docs, not code)

**File:** `bun-apps/pi-agent-ext-movie-director/CONTEXT.md`, new short entry
under a "Learning loop" heading (mirroring the file's existing terse
term-definition style):

- After producing a lipdub video (`native-i2v` + `run.py video lipdub`), call
  `evaluate-lipsync` with the video path and the seed/prompt/identity/voice
  used. When the result includes a `lesson`, immediately call hermes-memory's
  `memory` tool with `target=lesson.target`, `category=lesson.category`,
  `content=lesson.content` (and `reason=lesson.reason` when present).
- Before producing a new lipdub video, call `memory_search` first with
  `category: "tool-quirk"` and a query built from the character
  identity/voice, to check for known-bad combinations before picking
  seed/prompt.

This is intentionally a documented behavioral contract, not a code-enforced
one — consistent with how `pre-compose`'s `verdict: "fail"` already relies on
the agent choosing not to render rather than a hard block. If experience shows
the agent skips this reliably, a future iteration can escalate to something
more forceful; out of scope here.

## Error handling

`evaluate-lipsync` surfaces real errors like any other dispatch command
(missing `videoPath` → `{ok: false}`; `runPyLipsync` failure → `{ok: false,
error}`) — there is no "underlying successful generation" to protect here,
unlike the earlier (dropped) `generate`-hook design.

## Testing

`bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.test.ts` (new file) —
mirrors `runpy_tts.test.ts`'s spawn-injection pattern: ok=true with parsed
metrics on exit 0 + valid JSON stdout; ok=false on non-zero exit; ok=false on
malformed JSON stdout; ok=false when the spawn itself throws.

`bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.test.ts` (new file) —
pure unit tests for `buildLipsyncLesson`'s cases: adequate → memory/insight;
inadequate with a caveat → failure/tool-quirk with that caveat as `reason`;
inadequate with no caveat → `reason` falls back to the verdict string.

A new `describe("evaluate-lipsync")` block, added to
`bun-apps/pi-agent-ext-movie-director/src/commands.test.ts` (which already
exercises `dispatch()` directly for other simple commands) — covers: missing
`videoPath` → error; injected `runPyLipsyncImpl` returning an adequate verdict
→ `result.lesson.target === "memory"`; inadequate verdict → `result.lesson
.target === "failure"`; injected failure → `{ok: false}` propagates.

## Acceptance criteria

- `evaluate-lipsync` is reachable through all three existing surfaces for free
  (the `movie` tool, `movie_help`, and the CLI) once added to `COMMANDS` —
  confirmed via `commands.ts`'s `DETERMINISTIC_COMMANDS = COMMANDS.map(...)`
  derivation, no separate wiring needed.
- A `COMMAND_REFERENCE` bullet for `evaluate-lipsync` is added by hand (the
  existing test suite's `details.length > 20` check does NOT fail if this is
  forgotten — the "Unknown command" fallback string is long enough to pass
  vacuously — so this must be verified by reading the diff, not just green
  tests).
- `bun test` and `tsc --noEmit` pass in `pi-agent-ext-movie-director` with no
  changes required in `pi-agent-ext-hermes-memory`.
