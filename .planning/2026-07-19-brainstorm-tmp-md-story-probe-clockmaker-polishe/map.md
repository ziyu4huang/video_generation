# Effort — Polishing "The Clockmaker's Legacy" with LTX + TTS + Word-pop Captions

## Destination

Prove that `run-pipeline story` can automatically drive all three gaps the
`clockmaker_polished.mp4` (v2) is missing — **LTX image-to-video** for all 5
scenes, **English TTS narration** synced to the script, and **word-pop
captions** via compose-remotion — and ship a clockmaker video that is visibly
better than the static Ken Burns + looped-music v2.

## Notes

- **Carries execution into the map.** The destination is a working video, not
  just decisions — so prototype tickets here ARE deliverables, not pre-decision
  artifacts (wayfinder override).
- **Domain skills**: `grilling`, `domain-modeling`. Pipeline code lives in
  `bun-apps/pi-agent-ext-movie-director/`; MLX generation via
  `python/venv/bin/python python/mlx-movie-director/run.py`.
- **Environment facts (verified 2026-07-19)**:
  - LTX: native MLX, `run.py video generate --input-image <png>` does i2v.
  - TTS: `run.py tts --text "..." --voice <id>` → edge-tts (needs network).
    Supports WordBoundary events for word-level timing.
  - compose-remotion: `bun-apps/pi-agent-ext-movie-director/remotion/` has
    `Story.tsx` (word-pop + particles) from PR #687 — but it needs a browser
    and has NOT been verified end-to-end in this environment.
  - LM Studio: `google/gemma-4-12b-qat` via `~/.pi/agent/models.json`.
- **Creative decisions locked**: LTX = all 5 scenes i2v · TTS = English ·
  Captions = word-pop synced (→ remotion runtime, NOT ffmpeg compose-motion).
- **Standing preference**: local-only MLX; honesty over face-saving.

## Decisions so far

<!-- none yet — research frontier is unclaimed -->

## Not yet specified

1. **Remotion browser dependency.** compose-remotion needs a headless browser
   to render. Does the environment have one (Chromium/Puppeteer)? If not, this
   is a hard blocker for word-pop captions — either install a browser or fall
   back to ffmpeg-burned captions (losing the kinetic typography). Graduates
   once R3 probes the TTS+word-timing path (the same probe can check remotion).
2. **Music under narration.** v2 loops a single 8s MusicGen clip for 86s. With
   TTS narration added, the mix changes — does the music need ducking under
   speech? Does the single loop still work, or should mood vary per scene?
   Depends on hearing the narrated rough cut first.
3. **Faceswap / character consistency.** The script has 2 recurring characters
   (Elias + apprentice). v2's images were generated independently → faces
   drift across scenes. The story pipeline has a `character_design` stage +
   faceswap for exactly this. Not in the user's stated gaps, but a real quality
   issue. Likely a SEPARATE effort unless the user widens scope.

## Out of scope

- **New story / different topic.** This effort polishes the existing clockmaker
  story; a new narrative is a fresh effort.
- **Long-form (>2 min).** The script is 90s; scaling to 5+ min is a different
  effort.
