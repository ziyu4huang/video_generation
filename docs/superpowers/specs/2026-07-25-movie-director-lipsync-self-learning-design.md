# movie-director Lipsync Self-Learning — Design

**Goal:** `generate` calls for lipdub-style talking-head video (image + audio-track
→ mouth movement) currently produce no durable record of what worked or failed.
Every investigation into a bad result starts from zero. This adds an automatic,
best-effort feedback loop: after a lipdub `generate` call, movie-director
evaluates the result with `lipsync_metrics` and surfaces a `lesson` the agent is
instructed to persist via hermes-memory's existing tools — so future generations
can be informed by past ones instead of repeating the same failed combinations.

**Architecture:** Single-package change, `pi-agent-ext-movie-director` only.
`hermes-memory` already exposes the two tools this needs (`memory` for writing,
`memory_search` for querying) — no changes to that package. The link between the
two extensions is a documented agent-facing contract (skill/doc instructions),
not a code import: this repo has no precedent for one extension importing
another's internals, and movie-director's own ubiquitous language is explicitly
agent-first ("the agent reads manifests + stage skills and drives the run; code
is only tools + persistence" — `pi-agent-ext-movie-director/CONTEXT.md`).

**Background (why this shape, not another):** This was scoped down twice during
brainstorming. The first cut proposed a new movie-director-owned JSONL store;
storing in hermes-memory was preferred so lessons are visible through the same
memory surface as everything else, and searchable. The second cut proposed
movie-director importing hermes-memory's `MemoryStore` class directly as a
workspace dependency; this was rejected in favor of agent tool-calls, both
because no cross-extension import precedent exists in this repo and because it
turned out unnecessary — hermes-memory's existing `memory` tool already supports
exactly the shape needed (`target: "failure"`, `category: "tool-quirk"` for
negative lessons; `target: "memory"`, `category: "insight"` for positive ones),
and `memory_search` already supports filtering by `category`. Net effect: this
plan touches zero files in `pi-agent-ext-hermes-memory`.

This design was motivated directly by the 2026-07-25 dialogue-scene-v2/v3/v4
iteration (see `2026-07-24-dialogue-driven-scene-design.md` and this session's
history): five separate manual investigations (portrait swap, voice swap,
prompt-enrichment, full identity swap, seed sweep) were needed to find that (a)
an "expressive" prompt actively suppresses mouth motion, and (b) native-i2v
motion amplitude is a probabilistic function of `(seed, audio content)`, not a
fixed property of an identity. None of that was captured anywhere reusable —
the next dialogue scene would start from the same zero.

## Component: lipsync evaluation hook in `generate`

**File:** `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts`, the `"generate"`
case (currently `dispatch.ts:480-576`).

**Trigger condition:** `capability === "video_generation"` AND `command ===
"lipdub"` (the existing routing already passes `req.command` through to the
video director bridge — see `providers.ts:1057-1066`). Any other video_generation
command (plain compose, b-roll, etc.) is unaffected.

**What runs:** After `selectAndGenerate` returns a successful result, best-effort
invoke `python -m app.lipsync_metrics <output video path>` via the same
local-spawn pattern already used by `runpy_tts.ts` / `runpy_image.ts`
(`resolveRepoRoot` + `resolveRunPyPaths` + `runSpawn`, see `spawn.ts:25`). Parse
the JSON result (`verdict`, `pearson_r`, `mouth_ratio_std`, plus any `caveat`).

**New file:** `bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.ts` —
mirrors the shape of `decision-log.ts` (a small, focused, independently testable
module):

```ts
export interface LipsyncLesson {
  target: "failure" | "memory";
  category: "tool-quirk" | "insight";
  content: string;
  reason?: string;
}

export function buildLipsyncLesson(input: {
  verdict: "adequate" | "inadequate";
  pearsonR: number;
  mouthRatioStd: number;
  seed: number;
  promptSummary: string;
  identityRef: string; // basename of the input portrait path from opts.options
  voice: string;
}): LipsyncLesson { ... }
```

`identityRef` is derived in `dispatch.ts` from `opts.options`'s input-image path
(the same field the `lipdub`/`native-i2v` command already receives to know which
portrait to animate) via `node:path`'s `basename()` — no new option is added to
the `generate` call surface; this only reads what's already being passed.

`buildLipsyncLesson` is pure (no I/O), so it's fully unit-testable without
mocking the filesystem or a process spawn — the spawn + JSON-parse + call site
lives in `dispatch.ts` and stays thin.

**Result shape:** `generate`'s existing return is `{ ok: true, text: jsonOut({
provider, invoke, costEntryId, result }) }`. This adds one optional field inside
that JSON: `result.lesson` (the `LipsyncLesson` object), present only when the
call matched the trigger condition and evaluation succeeded. Every other
`generate` call (including lipdub calls where evaluation itself failed) is
byte-for-byte unchanged.

## Component: agent-facing contract (docs, not code)

**File:** `bun-apps/pi-agent-ext-movie-director/CONTEXT.md`, new short entry
under a "Learning loop" heading (mirroring the existing terse
term-definition style of that file):

- When a `generate` result includes a `lesson` field, call hermes-memory's
  `memory` tool immediately with `target=lesson.target`,
  `category=lesson.category`, content=`lesson.content` (and
  `reason=lesson.reason` when present, for the failure case).
- Before calling `generate` for a `lipdub` video, call `memory_search` first
  with `category: "tool-quirk"` and a query built from the character
  identity/voice, to check for known-bad combinations before picking
  seed/prompt.

This is intentionally a documented behavioral contract, not a code-enforced
one — consistent with how `pre-compose`'s `verdict: "fail"` already relies on
the agent choosing not to render rather than a hard block (`CONTEXT.md`'s
"pre-compose" entry). If experience shows the agent skips this reliably, a
future iteration can escalate to something more forceful (e.g. a stage-skill
that hard-fails `next-stage` on an unread `lesson`); out of scope here.

## Error handling

The lipsync-metrics spawn, JSON parse, and lesson-building are all wrapped in a
single best-effort `try/catch` in `dispatch.ts`, mirroring the existing
`recordDecision` best-effort call (`dispatch.ts:564-570`): any failure (Python
not installed, bad video path, malformed JSON, non-lipdub video with no
mouth-detection possible) is swallowed and `generate` returns its normal
success result with no `lesson` field. This must never turn a successful
generation into a reported failure.

## Testing

`bun-apps/pi-agent-ext-movie-director/src/dispatch.test.ts` (existing file)
gains three cases:

1. A `generate` call with `capability: "video_generation", command: "lipdub"`
   against a fixture/mock that returns an `adequate` lipsync_metrics verdict →
   `result.lesson` is present with `target: "memory"`, `category: "insight"`.
2. Same, but `inadequate` verdict → `result.lesson.target === "failure"`,
   `category: "tool-quirk"`, `reason` includes the `pearson_r`/`mouth_ratio_std`
   figures.
3. Lipsync evaluation throws (simulate a spawn failure) → `generate` still
   returns `ok: true` with the underlying generation result, and no `lesson`
   field — proves the best-effort wrapper never masks a real success.

`bun-apps/pi-agent-ext-movie-director/src/lipsync-lesson.test.ts` (new file) —
pure unit tests for `buildLipsyncLesson`'s four quadrants (adequate/inadequate ×
the caveat-present/absent cases already defined in `lipsync_metrics.py`, e.g.
flat-mouth-spurious-correlation and strong-negative-correlation).

## Acceptance criteria

- Non-lipdub `video_generation` calls are provably unaffected (test 3's sibling:
  a `command !== "lipdub"` call never invokes the spawn at all).
- A lipdub `generate` call's existing return fields (`provider`, `invoke`,
  `costEntryId`, `result`) are unchanged in both shape and value — `lesson` is
  strictly additive.
- `bun test` and `tsc --noEmit` pass in `pi-agent-ext-movie-director` with no
  changes required in `pi-agent-ext-hermes-memory`.
