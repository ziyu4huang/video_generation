# Receipt — real e2e #5: "Ancient Quasars" (agent-driven, research-first CONCEPT proof)

## Purpose

Closes the gap identified in `output/next-goal-20260711-v3-concept-function-new-story.md`:
every prior real e2e run ("How Neural Networks Learn", 4 variants) reused the
same hand-authored research content, so the CONCEPT function's actual web-research
grounding and concept-differentiation had never been stress-tested on a topic
the agent had to research itself. This run gives the agent **only a one-sentence
topic** — no research brief, no concept options, no facts — sourced fresh from
the internet (astronomy news, not from OpenMontage's own prompt list).

## Setup

- Story: "Ancient quasars that shouldn't exist" — astronomers have found
  extremely old, extremely bright quasars that strain current supermassive
  black hole growth models. The task prompt deliberately withheld the actual
  numbers/sources and told the agent to find them itself.
- Pipeline: `animated-explainer`, project `ancient-quasars-v1` (new).
- Driver: `bun bun-apps/s2-agent/src/cli.ts --model deepseek-v4-flash
  --thinking medium -e bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts
  --no-extensions -p "<task prompt>"`, run from repo root, backgrounded (nohup).
  Model choice matches the standing note that deepseek-v4-flash converges
  cleanly on deep artifact nesting where gemma-4-26b stalls.
- Task prompt hard requirements: (1) real web search for the research_brief,
  cite real URLs, no fabrication; (2) 3 genuinely differentiated
  `concept_options`; (3) zero `overrideArtifactValidation`/`overrideFinalReview`;
  (4) real T2I stills + real I2V motion clips with explicit duration control
  (~8-10s, not the ~4s default); (5) TTS with no explicit provider (let the
  runtime default fire); (6) `compose-motion`; (7) carry through to `publish`.
- Wall-clock: ~35 minutes end to end (8-stage pipeline, 7 scenes × T2I + I2V
  + narration + compose + publish).

## Result: PASS on the two things this run exists to test, with one honest deviation

All 8 stages reached `status=completed`; every gated stage (`proposal`,
`script`, `scene_plan`, `assets`, `compose`, `publish`) has
`human_approved=true`. Zero `overrideArtifactValidation`/`overrideFinalReview`
found anywhere in the checkpoint files (grepped programmatically, not
self-reported).

### 1. Did research-stage web lookup actually happen and get cited?

**Yes — verified independently, not just from the agent's self-report.**
`checkpoint_research.json`'s `research_brief.data_points` cites real URLs with
`credibility: "primary_source"`, e.g.:

- `https://www.esa.int/Science_Exploration/Space_Science/Euclid/Euclid_discovers_the_most_ancient_quasar_in_the_Universe`
  — claim: Euclid found 31 ancient quasars in 2026, two at redshifts 7.77/7.69,
  dating to **670 million years after the Big Bang**.
- `https://science.nasa.gov/missions/webb/nasas-webb-reveals-black-hole-that-formed-before-its-galaxy/`
  — claim: JWST's QSO1 (Abell2744-QSO1) hosts a 50-million-solar-mass black
  hole comprising two-thirds of its host system's mass.
- Plus ScienceDaily, Quanta Magazine, Popular Mechanics (uSIDM dark-matter
  theory, Grant Roberts/UCSC), Space.com, Imperial College London — 7 sources
  total, all real, checkable URLs, not placeholder text.

The `landscape.saturated_angles` / `underserved_gaps` fields also show genuine
research reasoning (e.g. noting no existing short explainer connects the
Euclid 31-quasar haul with the QSO1 finding into one storyline) rather than
boilerplate. This is exactly the kind of grounding a placeholder or
hallucinated brief could not produce, and the ~670-million-year figure — the
single fact-checkable number the goal explicitly flagged as the easiest way
to catch fabrication — is correct and traceable to a real source.

### 2. Were the 3 concept_options genuinely different?

**Yes.** From `checkpoint_proposal.json`:

| id | narrative_structure | hook | visual_approach | target audience |
|---|---|---|---|---|
| `cosmic-crime` (selected) | `story` | "The universe is too young for these monsters. Who broke the rules?" | dark cinematic space, forensic-style red markers, timeline compression, Eddington-limit "speedometer" | general curious viewers |
| `dark-matter-architect` | `problem_solution` | "What if dark matter built the first supermassive black holes?" | abstract particle-physics sim, uSIDM clumping, minimalist infographic, warm-vs-cold palette | dark-matter/tech enthusiasts |
| `cosmic-time-machine` | `journey` | "Every ancient quasar is a time capsule — travel 13 billion years back" | Hubble Ultra Deep Field zoom-throughs, redshift ladder, astronaut-perspective grading | space-enthusiast/social-media audience |

Three distinct `narrative_structure` enum values, three distinct hooks not
reworded synonyms of each other, three distinct visual languages, three
distinct target audiences. `selected_concept.rationale` gives a real reason
("most differentiated from existing dry-informative explainer content ...
naturally accommodates both the Euclid discovery and QSO1 finding as plot
points") rather than a generic justification. This is the first run where
concept differentiation was actually checked against content, not just
schema shape.

## Independent verification (this session, not the agent's self-report)

```
final.mp4: ~/video_generation__output/movie-director/projects/ancient-quasars-v1/final.mp4
  ffprobe: duration=225.958s, 1024x576, h264 24fps + aac (22050Hz)
  volumedetect: mean_volume=-20.4dB, max_volume=-1.0dB (real narration audio)
  size: 10,816,584 bytes
```

- **TTS auto-defaulted correctly**: `checkpoint_assets.json`'s narration asset
  has `source_tool: "edge-tts"` — the task prompt never named a provider,
  confirming the edge-tts-first fallback (PR #463) still fires with zero
  steering, same as the v4 receipt.
- **Real I2V motion confirmed within each raw clip**: SSIM between frames at
  0.5s and 3.5s of `scene-hook-video.mp4` (the raw per-scene I2V output,
  before compose) = **0.34** — far below what a static/panned-still source
  would show. All 7 scene videos are real `ltx-runpy` I2V outputs
  (`source_tool: "ltx-runpy"` in the asset manifest), not zoompan-over-a-still.

### Deviation found (disclosed by the agent itself, confirmed independently)

**Requirement #5 (~8-10s real I2V per scene) was not met.** All 7 raw I2V
clips are **4.04s** — the default duration the task prompt explicitly asked
the agent to avoid — and the agent did not pass an explicit frame count to
extend them. Instead, `checkpoint_edit.json`'s `edit_decisions.cuts` set
`out_seconds` far beyond each source's real length (e.g. `hook`:
`out_seconds: 32` against a 4.04s source), and `compose-motion` freeze-extends
the last frame to fill the gap. Independently confirmed via SSIM on the
**final composed video**: within the `hook` scene's 0–32s span, frame SSIM is
0.40 (t=1s vs t=3s, inside the real 4s clip) but jumps to **0.97–1.00**
(t=6s vs t=10s, t=15s vs t=20s, t=20s vs t=28s) — i.e. only the first ~4-6s of
each ~12-47s scene is real generated motion; the remainder is a static held
frame. The agent's own summary was honest about this ("各 ~4 秒，以 zoompan 延伸至對應腳本時長") —
this is a disclosed shortcut, not a hidden failure, but it means the "real
motion throughout" bar from the v4 receipt was not actually cleared here: v4
regenerated at `--frames 241` for true ~10s I2V per scene, this run did not.

## Significance

First run to prove the CONCEPT function's two hardest, previously-unchecked
claims on a topic nobody hand-authored for it: (1) research-stage web lookup
is real and fact-checkable, not fabricated or placeholder; (2) the 3
`concept_options` are genuinely differentiated by content, not just
schema-valid. Both PASS. Reveals one concrete, reproducible gap for a
follow-up: the `assets` stage's discoverability problem flagged in the v4
receipt ("how do I control clip duration" isn't obvious from the `movie
generate` options schema) recurred here and this time the agent didn't
self-correct — it silently accepted the 4s default and papered over the gap
with a frozen-frame extension in `edit_decisions` instead of regenerating
longer I2V clips. Worth either surfacing duration control more prominently in
the `video_generation` options schema, or having `pre-compose`'s slideshow-risk
check flag "cut `out_seconds` far exceeds source clip duration" as a warning.
