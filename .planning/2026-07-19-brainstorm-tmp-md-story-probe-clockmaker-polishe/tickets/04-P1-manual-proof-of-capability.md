# P1 — Manual proof-of-capability clockmaker video

type: prototype
claimed: (unclaimed)
blocked by: R2 — Probe LTX i2v wiring, R3 — Probe TTS + word-timing wiring

## Question

Before fighting the pipeline's automated path, assemble a clockmaker video
**by hand** using the individual tools — proving the capability exists and
giving a reference artifact for what the automated pipeline should produce.

This de-risks the whole effort: if the manual assembly fails, the pipeline
can't succeed either, and we know exactly which tool is broken.

### Manual assembly recipe

1. **LTX i2v all 5 scenes** — for each `scene_{1..5}.png`, run LTX i2v with a
   motion prompt derived from the scene_plan (e.g. scene_1: "slow camera push
   in toward the workbench"). Produces 5 video clips. (~10–20 min GPU)
2. **TTS English narration** — run `run.py tts` for each script section's text
   with a warm male voice (en-US-GuyNeural). Produces 5 narration wavs + word
   timing.
3. **Word-pop captions** — if remotion browser resolves (R3), render via
   Story.tsx with the word-timing data. If not, fall back to ffmpeg-burned
   captions and note the gap.
4. **Compose** — stitch the 5 LTX clips + narration + captions + existing
   music into the final video.

### Output target

```
/tmp/md_story-probe/clockmaker_v3_manual.mp4
~90s | 1280×720 | LTX-animated scenes + English TTS + word-pop captions + music
```

This is the "good enough" reference. The automated pipeline (P2) must match or
beat it.

## How to resolve

- Claim only after R2 + R3 close (need to know the tools work).
- Follow the recipe above; if any step fails, surface the specific break.
- Link the output video from the resolution.

## Answer

_(pending)_
