# Dialogue-Driven Two-Character Scene — Design

**Goal:** Prove out a "drama, not narration" production path — two characters
actually speak lip-synced dialogue on camera, cut together shot/reverse-shot —
built on the LipDub precision ceiling established this session (adequate
sync only for short, single-sentence, pause-free lines). Along the way, add
a local MLX-native TTS engine (Kokoro via `mlx-audio`) so narration/dialogue
audio no longer depends on the edge-tts cloud service.

**Architecture:** Two new/extended pieces:
1. `run.py tts --engine mlx` — a local Kokoro TTS path alongside the existing
   edge-tts path in `app/commands/tts.py`.
2. A per-line production loop (TTS → native-i2v → LipDub → verify → retry-once)
   run once per dialogue line, then assembled with `ffmpeg -filter_complex
   concat` (not the concat demuxer — see Background).

**Tech stack:** mlx-audio (Kokoro-82M), existing native-i2v (Swift/MLX
LTX-2.3 distilled), existing `run.py video lipdub` (Python LipDub IC-LoRA
pipeline), existing `app/lipsync_metrics.py` verification gate, ffmpeg.

---

## Background (why this design, not another)

This session ran a rigorous investigation (documented in memory as
`project_lipdub_monologue_iteration` — not yet saved) with five independent
LipDub attempts on a 9-second, multi-sentence monologue:

| Attempt | Condition | pearson_r | Verdict |
|---|---|---|---|
| 1 | extreme closeup, hood, ref-strength 1.0 | 0.17 | inadequate |
| 2 | same, ref-strength 0.6 | 0.11 | inadequate |
| 3 | clean closeup, "mouth closed" prompt | 0.21 | inadequate (degenerate mouth range) |
| 4 | same source, "lips parted" prompt | 0.20 | inadequate (hallucinated hand artifact found) |
| 5 | half-body framing (avoids closeup artifacts) | 0.17 | inadequate |

All five failed the `ADEQUATE_R_THRESHOLD = 0.3` gate in `lipsync_metrics.py`.
The only prior *successful* ("adequate") LipDub result this session was on a
4.4-second, single, pause-free sentence ("You don't need music. You just
gotta feel it.") — this is the only regime with empirical evidence of working
reliably. This design deliberately stays inside that regime: 6 lines, each
3-6 words, each its own independent shot.

A separate real bug was found and fixed this session: concatenating clips
with mismatched audio parameters (48kHz stereo vs 24kHz mono) via the
`-f concat` demuxer produces a video/audio duration mismatch that some
players refuse to play, even though `ffmpeg` re-encodes without erroring.
Root cause: the concat demuxer assumes uniform stream parameters across
segments; it does not resample mid-stream. Fix: use `-filter_complex concat`
with an explicit `aformat=sample_rates=48000:channel_layouts=stereo` on each
input branch before the `concat` filter node. This design uses that approach
from the start.

## Component 1: MLX-native TTS engine

**File:** `python/mlx-movie-director/app/commands/tts.py`

Add `--engine {edge-tts,mlx}` (default stays `edge-tts` — no behavior change
for existing callers). When `--engine mlx`:
- `--voice` reinterpreted as an mlx-audio/Kokoro voice id (e.g. `am_michael`,
  `am_adam`, `af_heart`) instead of an edge-tts voice id. Validate against a
  known-prefix check (`af_`, `am_`, `bf_`, `bm_`, etc.) and print a clear
  error otherwise — don't silently pass through a wrong id to mlx-audio.
- New `--mlx-model` flag, default `mlx-community/Kokoro-82M-bf16`.
- `--rate` (edge-tts's signed-percentage rate) has no direct Kokoro
  equivalent; mlx-audio's Kokoro pipeline takes a `speed` float multiplier
  instead. Map `--rate` only if given (parse `+N%`/`-N%` to `1 + N/100`);
  default to speed `1.0` when `--rate` is left at its default `+0%`.
- Invoke `mlx_audio.tts.generate` via its Python API (not a subprocess —
  it's already an installed dependency in the venv), write the output to
  the same `--output` / auto-generated path convention as the edge-tts path.

**File:** `python/mlx-movie-director/requirements.txt`

Add: `mlx-audio`, `misaki`, `num2words`, `spacy`, `phonemizer`. Note in a
comment that `misaki`'s English G2P additionally needs the spaCy
`en_core_web_sm` model (auto-downloaded on first use, one-time network
fetch) and the `espeak-ng` binary (system dependency — brew on macOS,
already present on this dev machine; document as a new item in
`scripts/setup-offline.sh` / `scripts/setup.sh` prerequisites).

**Testing:** `pytest python/mlx-movie-director/app/tests` — add a test that
`--engine mlx` is accepted by the argparser and dispatches to the mlx path
(mock `mlx_audio.tts.generate` rather than actually invoking Kokoro in the
test, to keep the test fast/offline). Confirm the existing edge-tts test
path, if any, is untouched.

## Component 2: Character portraits

Two half-body portraits generated via `run.py image t2i`, reusing the
framing that worked cleanly in this session's attempt 5 (no hood, bare head,
facing camera, lips slightly parted, even frontal lighting, faint neon
background). One prompt per character with a distinct look (e.g. different
hair, one wearing a jacket vs the other a hoodie *pulled back* — avoid
re-triggering the hood-shadow issue from earlier attempts). Fixed seed per
character so all 3 of that character's lines reuse the identical portrait
(no per-line regeneration of the source image).

## Component 3: Per-line shot pipeline

For each of the 6 lines, in order:
1. **TTS**: `run.py tts --engine mlx --text "<line>" --voice <character's voice> --output <line>.wav`
2. **Base clip**: `native-i2v --prompt "<neutral 'lips slightly parted, relaxed, talking' prompt, no extra scripted motion>" --input-image <character portrait> --audio-track <line>.wav --seconds <ceil(line duration to next 8k+1 frame boundary)> --seed <character's fixed seed> --no-upscale --no-refine`
3. **LipDub**: `run.py video lipdub --lipdub-reference-video <base clip> --prompt "<character> talking directly to the camera, natural mouth and lip motion matching speech, neon-lit background" --width 384 --height 576`
4. **Verify**: `python -m app.lipsync_metrics <lipdub output>` (run with cwd
   `python/mlx-movie-director`). If `verdict != "adequate"`:
   - Retry **once** with the alternate framing/prompt variant that this
     session found to help most (half-body + "lips slightly parted, relaxed
     as if talking" — attempt 5's recipe) if not already the first choice.
   - If the retry also fails, accept the better-scoring of the two attempts
     and flag it in the final report — do not loop indefinitely (this
     session's own lesson: 2 failed attempts on a fresh hypothesis is the
     point to stop and report, not keep guessing).

## Component 4: Assembly

```bash
ffmpeg -y \
  -i shot1.mp4 -i shot2.mp4 -i shot3.mp4 -i shot4.mp4 -i shot5.mp4 -i shot6.mp4 \
  -filter_complex "\
[0:v]setpts=PTS-STARTPTS[v0];[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0]; \
... (same for 1..5) ...
[v0][a0]...[v5][a5]concat=n=6:v=1:a=1[outv][outa]" \
  -map "[outv]" -map "[outa]" -c:v libx264 -c:a aac -pix_fmt yuv420p final.mp4
```

Verify with `ffmpeg -v error -i final.mp4 -f null -` (must produce no
output/errors) and `ffprobe` duration-match check (video and audio stream
durations must match within a frame) before treating the file as done —
this is exactly the check that would have caught this session's concat bug
before shipping it.

## Testing / acceptance

- Each of the 6 shots individually passes `lipsync_metrics.py` with
  `verdict == "adequate"`, OR is explicitly flagged as best-effort with its
  actual pearson_r reported (no silent downgrade).
- Final assembled file: `ffprobe` reports matching video/audio durations;
  `ffmpeg -f null -` reports zero errors.
- Visual spot-check (frame grabs at start/mid/end of each shot) confirms no
  hallucinated artifacts (the hand+eyeliner-pencil bug from attempt 4) and
  confirms the two character portraits stay visually consistent across
  their 3 lines each.
