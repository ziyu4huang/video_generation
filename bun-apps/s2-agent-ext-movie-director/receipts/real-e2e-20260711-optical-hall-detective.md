# Receipt — real e2e #7: "The Case of the Missing Magnetic Signal" (physics-mystery genre) — technical gates PASS, narrative coherence FAIL

## Purpose

Track A of `output/next-goal-20260711_193302.md`: another fresh,
internet-researched real e2e (this time a "150-year physics mystery solved"
narrative — a genre distinct from the astronomy/neural-net/history-elegy
topics already tested), running the full gated 8-stage pipeline with the
existing edge-tts narration path. Track B (LTX-native-voice vs edge-tts
side-by-side) was deferred pending this run's output.

## Setup

- Topic withheld from the agent: "a physics mystery unsolved for ~150 years,
  finally cracked recently — frame it as a detective story." No facts,
  sources, or angle given. The agent researched and picked its own topic
  (see Result §1) — different from the "gallium" candidate this session's
  planning doc suggested, which is expected and fine (the prompt withheld
  everything on purpose).
- Pipeline: `animated-explainer`, project `optical-hall-detective` (new).
- Driver: `bun bun-apps/s2-agent/src/cli.ts --model deepseek-v4-flash
  --thinking medium -e bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts
  --no-extensions -p "<task prompt>"`, backgrounded (nohup), run from repo root.
- Hard requirements (verbatim intent): real cited web research with a
  fact-checkable number; 3 differentiated `concept_options`; zero
  `overrideArtifactValidation`/`overrideFinalReview`; ~8-10s of real I2V
  motion per scene with explicit `frames`; `pre-compose` run and any
  `cut_duration_vs_source` warn/fail resolved before composing; TTS with no
  explicit provider; `compose-motion`; carry through to `publish`.
- Wall-clock: ~35 minutes (19:50–20:30).

## Result

### 1. Research — real and independently verifiable

The agent picked the **optical Hall effect**, not gallium: Edwin Hall tried
and failed to detect it optically in 1881; Nadav Am Shalom and Prof. Amir
Capua (Hebrew University of Jerusalem, with Weizmann Institute, Penn State,
University of Manchester) detected it in non-magnetic metals (Cu, Au, Al,
Ta, Pt) using a 440nm blue laser + a Ferris-MOKE technique, published in
*Nature Communications*, **2025-07-17**. Flagged fact-checkable number: a
**11.48×** signal ratio (Permalloy vs. copper) explaining ~144 years of
non-detectability.

Sources cited, all real and resolvable:
[Nature Communications](https://www.nature.com/articles/s41467-025-61249-4),
[SciTechDaily](https://scitechdaily.com/this-blue-laser-just-solved-a-150-year-physics-mystery/),
[ScienceDaily](https://www.sciencedaily.com/releases/2025/07/250718031227.htm),
[EurekAlert](https://www.eurekalert.org/news-releases/1091024),
[AFHU](https://www.afhu.org/2025/07/17/shedding-new-light-on-invisible-forces-hidden-magnetic-clues-in-everyday-metals-unlocked/).
The 11.48× ratio and the 1881/2025 dates trace directly to these sources —
not fabricated.

### 2. CONCEPT differentiation — PASS

| id | narrative_structure | hook |
|---|---|---|
| `detective` (selected) | `story` | "In 1881, Edwin Hall walked away from an unsolvable case. 144 years later, his heirs cracked it." |
| `whisper` | `analogy` | "A whisper so quiet that for 150 years no one could hear it. Finally a microphone sensitive enough." |
| `switch` | `problem_solution` | "Copper wires hid a magnetic superpower for 150 years. Scientists just found the switch." |

Three distinct structures/hooks. Rationale: *"Whisper lacked detective
narrative structure; Switch sacrificed historical depth for speed."* — a
real comparative argument, matching the quality bar of the last two
receipts.

### 3. Gates — all technically PASS, zero overrides

All 8 checkpoints `status=completed`; every gated stage
(`proposal`/`script`/`scene_plan`/`assets`/`publish`) has
`human_approved=true`. Zero `overrideArtifactValidation`/
`overrideFinalReview` anywhere. `final-review` verdict was `pass` (one
`warn` on `audio_level`, see §5). `pre-compose`'s `cut_duration_vs_source`
had nothing to catch this run: each raw I2V clip is 8.04s and every cut
requests exactly `out_seconds: 8` — cut ≤ source in all 7 cases, so the
gate correctly stayed quiet. This is a genuine, different outcome from the
Issyk-Kul run (gate fired there); here the gate's specific check simply
wasn't the failure mode present.

### 4. **The real problem: the delivered video does not tell the story it wrote**

The user watched `final_video_optical_hall_detective.mp4` and reported it
felt incoherent — "感覺很混亂，這個影片不知道在說什麼." Investigating
independently found a genuine, undisclosed defect:

- `checkpoint_script.json`'s `script.sections` plans a **120-second**
  7-act narrative (s1 18s, s2 17s, s3 20s, s4 18s, s5 22s, s6 20s, s7 5s) —
  a real detective arc: setup (1881 failure) → why it stayed unsolved →
  the 11.48× number → the 2025 Hebrew University team → the MOKE technique
  → the physics explanation → resolution (paper published, case closed).
- The synthesized narration audio (`assets/narration_full.mp3`) is
  **162.9 seconds** — consistent with the 120s script at natural speech
  pace.
- But every scene's I2V clip was generated at a flat **8.04s** (per
  requirement #4's "~8-10s of real motion per scene"), and `edit_decisions`
  locked every cut to exactly `out_seconds: 8` with **no adjustment for the
  wildly different per-section script lengths** (17-22s vs. one flat 8s).
  Final composed video: **7 × 8.04s ≈ 56.3s total** — well under half the
  120s the script was written for.
- `assets/narration_part1.mp3` (a 27.3s file, present alongside the 163s
  full narration) and `silencedetect` on the delivered file's audio track
  both indicate the actual mixed narration does not correspond 1:1 with
  the full script — the audio heard in the final video does not carry the
  story through to its resolution (the Hebrew University breakthrough,
  MOKE technique, and "case closed" beats land on-screen visually in
  scenes 4-7, but the narration that should explain them was never fully
  synthesized/mixed at the length the script needed).
- `checkpoint_publish.json`'s `publish_log` shows `status: "published"`
  with **no disclosure** of this gap — unlike the `ancient-quasars-v1` run
  (where the agent explicitly told the user "各 ~4 秒，以 zoompan 延伸"),
  this run silently published a video whose narration cannot possibly cover
  what its own script and visuals promise.

**Net: every existing gate this pipeline has (`pre-compose`'s
`cut_duration_vs_source`, `final-review`'s container/stream/audio-level
checks) is checking the wrong kind of duration mismatch for this failure
mode.** They check "does a cut exceed its source clip's length" and "is
there an audio stream at a normal volume" — neither checks "does the
composed video's total runtime actually have room for the narration the
script itself specified." A script written for 120s squeezed into a 56s
video is exactly what happened, and nothing caught it.

### 5. Secondary issue: audio level

`final-review`: `audio_level: warn, mean=-9.6dB, peak=0.0dB`. Independently
confirmed via `ffmpeg -af volumedetect`: `mean_volume=-9.6dB,
max_volume=0.0dB`. This is much hotter than every prior run (typically
~-20dB mean) and peaks are already at the digital ceiling — a real
clipping risk, flagged by the pipeline's own gate as `warn` but not
escalated to a fail or acted on before publish.

## Independent verification

```
final_video_optical_hall_detective.mp4:
  ffprobe: duration=56.12s (video) / 56.26-56.28s (audio streams), 448x704, h264 + aac
  volumedetect: mean_volume=-9.6dB, max_volume=0.0dB  (hot; prior runs ~-20dB)
  size: 23,970,246 bytes

Per-scene raw I2V clips (7x): all 8.04s, source_tool=ltx-i2v — matches
  edit_decisions cuts exactly (out_seconds=8 <= source 8.04s), so
  cut_duration_vs_source correctly found nothing to flag.
SSIM (t=0.5s vs t=3.5s, scene1): 0.80 — real but comparatively subtle motion
  (higher than the 0.18-0.41 range of prior runs; not the 0.97-1.00
  frozen-extension signature).

Script vs. delivered runtime:
  script.sections total: 120s (7 sections, 17-22s each)
  narration_full.mp3: 162.9s
  narration_part1.mp3: 27.3s (partial asset, present in outputs dir)
  final composed video: 56.28s  <-- less than half the scripted narrative

Zero overrideArtifactValidation / overrideFinalReview: grep across all
  checkpoint_*.json — no matches.
TTS: edge-tts (en-US-GuyNeural), no provider specified in the prompt —
  runtime default fired correctly.
```

## Deviations found

**Material.** Unlike the last two runs (where the duration-control gap was
either avoided or disclosed), this run's core defect — the delivered video
cannot narrate the story its own script and scene plan describe — was
**silently published**, not disclosed. This is the deviation the user
directly caught by watching the output, not something this session's
checklist (copied from prior receipts) was written to catch, because prior
receipts' checks target *source-clip-vs-cut* duration, not
*script-vs-final-runtime* duration.

## Significance

Confirms (again) that `pre-compose`'s `cut_duration_vs_source` check and
`final-review`'s technical gates are necessary but not sufficient: a run can
pass every existing automated/self-reported check and still deliver an
incoherent video, because none of the gates compare the **script's planned
narrative runtime** against the **actually composed video's runtime**. This
is a new, third category of duration mismatch (distinct from "cut exceeds
source" and "frozen-frame extension"), and it's arguably the most
user-visible one, since it directly produces "I can't tell what this video
is about."

**Concrete follow-up worth prioritizing over Track B**: add a
`pre-compose` (or `scene_plan`/`edit`) check comparing
`sum(script.sections[].duration)` (or narration audio duration) against the
sum of planned cut durations, warning/failing when the composed runtime
would need to cut off more than some threshold (e.g. >20%) of the scripted
narrative. Until that exists, "~8-10s of real motion per scene" as a flat
requirement will keep conflicting with scripts that plan variable-length,
narratively necessary sections — the agent has no mechanism today to
reconcile the two, and nothing tells it (or the user) when they diverge
this badly.

Track B (LTX-native-voice vs. edge-tts side-by-side) is deferred until a
rerun (or a scene/script-duration-reconciled version of this same story)
produces a video that actually tells its story end-to-end — comparing voice
quality on a broken cut is not a meaningful test.
