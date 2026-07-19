# Map — close the story-video gaps in pi-agent-ext-movie-director

## Destination

Ship a **finished, original story-video** (story → images/clips → narration →
music → captions → composed MP4) produced end-to-end by `pi-agent-ext-movie-director`,
demonstrating the same capability envelope as OpenMontage's story samples. Three
named gaps must close to get there:

1. **Music** — a `music_generation` provider that sources a royalty-free track
   (compose already mixes narration + music; only the source is missing).
2. **Richer compose** — particle overlays + TikTok-style word-pop captions in the
   Remotion tier (today `Explainer.tsx` has scenes + crossfade + section_title +
   audio, nothing richer).
3. **Story/short-film pipeline** — a `story.yaml` manifest (today only
   `animated-explainer` + `talking-head` exist).

Reaching the destination = all three land **and** one actual story runs through
to a playable MP4.

## Notes

**Domain:** one `@repo/` package — `bun-apps/pi-agent-ext-movie-director` (the
agent-first video production orchestration extension, a Bun port of OpenMontage).
Compose lives in `src/compose*.ts` + `remotion/src/`; providers in `src/registry.ts`
+ `src/bridge.ts`; pipelines in `data/pipeline_defs/`; the `movie` tool /
`dispatch()` in `src/dispatch.ts`.

**Skills every session should consult:** `wayfinder` (this map), `grilling`,
`domain-modeling`, `test-driven-development`, `verification-before-completion`.
From the parent repo: invoke the `movie` tool / `run.py` only via the documented
entry points (never top-level `cd`; venv at `python/venv`).

**Two settled decisions (resolved in the charting grill):**

1. **Destination shape = ship an original example, not a 1:1 sample copy.** Close
   the three gaps *and* run a real story to a finished MP4. Reusable for any future
   story. (1:1 reproduction of e.g. "THE LAST BANANA" was rejected — it leans on
   cloud Kling v3, which isn't wired in this native-MLX stack.)
2. **Music source = royalty-free stock via network** (Pixabay-style), mirroring
   what OpenMontage's samples actually use ("royalty-free Pixabay strings /
   piano"). Free, no API key, offline-after-cache. Cloud generative music
   (Suno/Udio) and offline/user-supplied were both rejected.

**Key facts (already verified — don't re-litigate):**

- **Compose already mixes audio.** `compose-motion` runs an `amix` pass
  (`src/compose_motion.ts:287-296`, `mixAudioOnto` at :360): narration trimmed/
  looped to video duration, music looped + volume (default 0.4) + fade, both
  `amix`. `audio_mixer` provider IS configured (`registry.ts:347`). So the music
  gap is **only the source provider** — `edit.audio.music.src` needs a file.
- **`music_generation` capability is declared but has NO provider.**
  (`registry.ts:20`; no entry under that capability.) `assets-encoder.ts` handles
  only `video_generation` + `tts` today — wiring music means a provider entry +
  assets-encoder branch.
- **`story_generation` provider EXISTS** (`mlx:runpy-story`, `bun:lmstudio-story`)
  — idea/script text is available; the story-pipeline gap is a *manifest* gap,
  not a generation gap.
- **Remotion is NOT installed** here (`remotion/node_modules` missing, no
  `remotion` on PATH). `compose-remotion` needs a one-time `bun install` in
  `remotion/` + a browser (`REMOTION_BIN` or `bunx`; reuse system Chrome via
  `REMOTION_BROWSER_EXECUTABLE`). `compose-motion` (ffmpeg) is always available
  but cannot do particles or word-pop.
- **`compositionId` is hardcoded to `Explainer`** (`src/remotion.ts:300`).
  Adding a `Story` composition = register it in `remotion/src/Root.tsx` +
  parameterize the id in `renderRemotion()`.
- **Word-level timestamps exist.** Whisper (`bun:whisper`) emits `words.json`;
  `subtitle_gen` already derives cues from it (`providers.ts:516`). So word-pop
  captions have a data source — the gap is a Remotion per-word component, not
  timestamp math.
- **Full 8-stage pipeline is proven** on real MLX+ffmpeg (rainbows receipt,
  13.2s/1080p, 679/0 tests). The foundation this effort builds on is reliable.

**Standing prefs:** PLAN-FIRST; HONESTY OVER FACE-SAVING; conversation zh-TW,
artifacts English; one-question-at-a-time grilling; Apple-Silicon MPS / native
MLX only (no CUDA, no cloud-GPU).

## Decisions so far

<!-- the index — empty until the first ticket closes -->

- [01 — Royalty-free music source](tickets/01-royalty-free-music-source.md) — researched Pixabay/Openverse (FMA ruled out), **then REVISED at 04** to **local MLX generative** (user: "MLX + open-source + free") — the Pixabay findings stand as a documented alternative.
- [02 — Rich-compose runtime + feasibility](tickets/02-rich-compose-runtime-feasibility.md) — **feasible**: Remotion tier is the right home; compositionId seam (`src/remotion.ts:300` → `Root.tsx`) + word-timestamp path (`words.json` → `wordCues`) both confirmed; install-not-yet-run is a prototype step for 05/06.
- [03 — Story pipeline scope](tickets/03-story-pipeline-scope.md) — **lean 8-stage spine + a conditional `character_design` stage** (between script & scene_plan, `condition: "recurring_characters_declared"`; locks flux2 t2i refs, assets applies faceswap); **render_runtime selector in proposal** (Story vs compose-motion, default Story); retires the character-consistency fog; character_design schema deferred to 07.
- [04 — Music provider integration](tickets/04-music-provider-integration.md) — **landed + proven on real MLX**: local **MusicGen via mlx-audiocraft** (CC-BY-4.0) wired as `musicgen_music` (`invoke: "mlx:runpy-music"`), mirroring TTS; real 5s gen → valid non-silent WAV (mean -19.9 dB); `bun test` 698/0. Mood→prompt **derivation** still open.
- [05 — Richer compose design](tickets/05-richer-compose-design.md) — **new `Story.tsx` composition** (not extending Explainer); **particle layer** DOM+interpolate (`{type:density:drift}`, sparkle/petal/firefly); **word-pop captions** from a `wordCues` prop (words.json-derived); fallback to compose-motion+SRT. No hard choice — recommendations applied.
- [07 — story.yaml manifest](tickets/07-story-yaml-manifest.md) — **`story.yaml` (cinematic, lean 8-stage + conditional `character_design`) + `character_design.schema.json` landed + schema-valid**; new optional stage-level `condition:` field added to the pipeline schema (backward-compatible); `pipeline-list`/`pipeline-show` surface it.
- [06 — Story compose composition](tickets/06-story-compose-composition.md) — **`Story.tsx` built + proven on a real render**: `ParticleLayer` (sparkle/petal/firefly, seeded) + `WordPopCaption` (TikTok word-pop from `wordCues`); `compositionId` parameterized (default Explainer); real render → 5s 1080p MP4, frame non-black; `remotion.test` 11/0.
- [08 — Ship the story-video example](tickets/08-ship-the-story-video-example.md) — **DESTINATION REACHED**: "The Lighthouse Keeper" — 14.55s/1080p story-video, every asset via a registered provider (3× flux2 images, edge-tts narration, **MLX MusicGen score**, whisper word cues) composed through **`Story`** (particles + word-pop). **Audio non-silent (mean -25.7 dB)**, frames non-black. Retires the last fog (mood→query = explicit prompt; motion source = flux2+Remotion).

## Not yet specified

<!-- in-scope fog you can't ticket yet; graduates as the frontier advances -->

**FRONTIER EMPTY — destination reached.** All 8 tickets closed; the two
remaining fog items graduated + resolved by [08](tickets/08-ship-the-story-video-example.md):

- **Mood→query mapping** — resolved: the provider takes an explicit `--prompt`
  authored from scene mood (derivation is a thin driver/agent wire, not a
  research item; the mechanism is proven).
- **Example motion source** — resolved: **flux2 images + Remotion motion**
  (Candyland-style), exercising the Story composition's ken-burns/zoom/pan.

What remains is *polish*, not decisions: per-word DTW (swift whisper already
emits per-word timestamps, so even this is largely done), a doc note on the CLI
`--options` nesting gotcha, and the (out-of-scope) cloud video-gen / SVG-rig
paths the destination deliberately rules out.

## Out of scope

- **Cloud video generation (Kling v3 / fal.ai / Veo).** The destination is the
  native-MLX stack; cloud video-gen was rejected when the destination was set.
  LTX-2.3 (local) is the in-scope motion source.
- **Cloud generative music (Suno / Udio).** Rejected — royalty-free stock via
  network is the chosen music source.
- **SVG rig-based character animation** (OpenMontage's `character-animation`
  pipeline: `svg_rig_builder`, `pose_library`, `action_timeline`). Overkill for a
  native image+motion story; ruled out unless [03](tickets/03-story-pipeline-scope.md)
  explicitly resurrects it (default: out).
- **Brand-new pipelines beyond `story`.** `cinematic`, `documentary-montage`,
  etc. are not needed to reach this destination.
