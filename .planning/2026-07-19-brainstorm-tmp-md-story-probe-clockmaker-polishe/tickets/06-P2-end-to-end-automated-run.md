# P2 — End-to-end automated run-pipeline story (all three gaps closed)

type: prototype
claimed: (unclaimed)
blocked by: P1 — Manual proof-of-capability, T1 — Fix LLM content drift

## Question

The destination ticket: run `run-pipeline story` from a clean state and verify
it **automatically** produces a clockmaker video with all three gaps closed —
LTX i2v animation, English TTS narration, word-pop captions — matching or
beating the manual reference (P1).

This is the proof that the pipeline (not just the individual tools) can drive
all three. If it succeeds, the effort is done. If it surfaces remaining wiring
gaps, they become follow-up tickets.

### Verification criteria

1. `run-pipeline {projectId:"story-probe-v3", pipeline:"story", model:<from T1>}`
   completes all 9 stages without manual checkpoint overrides.
2. The `assets` stage produces 5 LTX i2v video clips (non-empty paths).
3. The `assets` stage produces TTS narration wavs with word-timing data.
4. The `compose` stage renders via remotion with word-pop captions.
5. Output video exists, is ~90s, 1280×720, with audible narration + music +
   visible captions.

### Output target

```
<project output>/clockmaker_v3_automated.mp4
```

Compare side-by-side with P1's manual reference. The automated run should
match it.

## How to resolve

- Claim only after P1 (manual proof) AND T1 (LLM fix) close.
- Reset/clone the story-probe project so run-pipeline starts fresh.
- Run the pipeline; capture which stages succeed/fail.
- If wiring gaps remain (R2/R3 found issues not yet fixed), surface them as
  new tickets and note the gap here.
- The effort closes when this ticket closes with a shipped automated video.

## Answer

_(pending)_
