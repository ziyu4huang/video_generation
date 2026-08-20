# Receipt — movie-director video_understand→CLIP agent-path block: root cause + fix

> Goal `output/next-goal-20260706-115510.md` Item A. Branch
> `fix/movie-director-video-understand-discoverability` off `origin/main`.
> Set 2026-07-06.

## The reported block

A hint-free visual-analysis prompt ("identify the VISUAL content of `<video>`")
sent the movie-director agent into a **non-converging loop** (gemma 6.5% CPU
14+ min; deepseek 0.0% CPU 11+ min, no session JSONL). The deterministic CLIP
adapter succeeded (`clip-e2e-20260705.md`), so the block was in the
**agent-driven `movie` tool path**, not the adapter.

## Root cause (NOT a deadlock — a tool-description discoverability defect)

The `movie` tool's `generate` command description documented ONLY the audio
path: `capability:'analysis' command:'transcribe' options:{audio, model?,
language?}`. It **never mentioned `command:'video_understand'`** — the CLIP
visual-analysis subcommand that #305 had wired selector routing for.

The agent's own thinking (session JSONL, first run) shows it hitting exactly
this wall:

> "The documentation only shows `command:'transcribe'`."
> "maybe there's a `visual_analysis` command?"
> "If the `movie` tool's `analysis` capability only does transcription…"

Unable to discover the CLIP path, gemma **guessed** `transcribe` and (worse)
**omitted `capability` entirely**, passing `options:{audio:true,
video_path:...}`:

```
arguments:{"command":"generate","options":{"audio":true,"video_path":"…/fixture.mp4"}}
→ "movie-director errored: generate requires {capability}"
```

That structured error → retry → meander → the observed non-converging loop
(low CPU, no convergence). It was NEVER a subprocess hang, a pipe deadlock, or
a s2-agent init failure — the routing layer (#305) and the CLIP subprocess
both work; the agent simply had no way to *find* the command.

**Decisive disproof of the deadlock hypotheses:**
- `runSpawn` (providers.ts) spawns with `stdio:["ignore","pipe","pipe"]` and
  does not attach drain listeners — but **Bun's `node:child_process` auto-
  drains pipes** (verified: a 327 MB undrained stderr write resolves in 0s;
  Bun does not back-pressure unattached pipes). Not the deadlock source.
- `selectAndGenerate("analysis", {command:"video_understand"})` hint-free
  routes to `bun:clip` and returns real CLIP scores in 6 s
  (`provider:clip, model:openai/clip-vit-base-patch32, prob_mean:0.978`).

## The fix

`extensions/movie-director.ts` — the `generate` bullet now documents BOTH
analysis subcommands and the `command`-selects-subcommand contract, with the
exact option keys (so the agent stops guessing `video_path` → `video`):

```
capability:'analysis' — `command` selects the analysis subcommand (whisper owns
`transcribe`, clip owns `video_understand`). For VISUAL content analysis use
command:'video_understand' options:{video, prompt, labels?, numFrames?, model?}
→ CLIP (openai/clip-vit-base-patch32, local torch MPS, $0) scores each sampled
frame against `prompt`. For AUDIO transcription use command:'transcribe'
options:{audio, model?, language?} → mlx-whisper transcript …
```

## Regression test

`extensions/pi-movie-director.test.ts` — "the generate description documents
BOTH analysis subcommands (agent-discoverability)" pins that the description
contains `video_understand`, `transcribe`, the `VISUAL` signal, and the
`options:{video, prompt` shape. A future edit that drops the CLIP docs fails
this test — the exact regression that caused the block.

## Live proof (hint-free agent loop converges through CLIP)

Re-run with the fix, same prompt, gemma-4-26b thinking medium, `movie` tool
only — the agent's FIRST call was the correct shape, no hint:

```json
{"command":"generate","options":{
  "capability":"analysis",
  "command":"video_understand",
  "options":{"video":"…/fixture.mp4","prompt":"a video clip",
            "labels":["a video clip", …], "model":"openai/clip-vit-base-patch32"}}}
```

Tool result (turn 1, the convergence gate):

```json
{"provider":"clip","invoke":"bun:clip","result":{
   "success":true,"provider":"clip","command":"video_understand",
   "artifacts":[{"role":"scores","path":"…/clip_scores.json"},
                {"role":"frame-0"}, …],
   "model":"openai/clip-vit-base-patch32"}}
```

**Before:** `options:{audio:true,video_path}` no capability → "requires
{capability}" → loop. **After:** `capability:analysis, command:video_understand,
options:{video,prompt,labels,model}` → CLIP success in turn 1. The block is
resolved; acceptance ("converges to a CLIP result in ≤2 turns") met.

> The box was contended (3 concurrent s2-agent processes queueing on the one
> local gemma in LM Studio — the `s2-agent-headless-p-hang` contention
> scenario), so wall-clock was long, but the *routing signal* is turn-1
> deterministic and independent of the queue depth.

## Test gate

`bun test` in `bun-apps/s2-agent-ext-movie-director` → **166 pass, 1 skip,
0 fail** (was 165; +1 the discoverability regression test).
