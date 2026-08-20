# Receipt — real e2e #6: "The Drowned City of Toru-Aygyr" (history-elegy genre + pre-compose gate live-fire test)

## Purpose

Two open questions carried from `output/next-goal-20260711_172202.md`:

1. **Genre diversification**: every completed real e2e run so far was either
   astronomy (`ancient-quasars-v1`) or neural-network explainer content
   (4 variants). Does CONCEPT's differentiation logic hold up on a
   history-elegy narrative — OpenMontage's *"Library at Alexandria"* shape
   ("a whole world lost in a single catastrophic event, told through the
   physical fragments that survived it")?
2. **Pre-compose gate live-fire test**: `precompose-gate.ts`'s
   `cut_duration_vs_source` check (added this session, previously only
   verified against the frozen `ancient-quasars-v1` fixture in unit tests)
   — does it actually change agent behavior on a fresh real run, the way it
   was designed to?

## Setup

- Story: a medieval Silk Road city recently found submerged in a Central
  Asian lake. The task prompt withheld all specifics (no city name, no
  dates, no sources) — the agent had to research and cite them itself.
- Pipeline: `animated-explainer`, project `issyk-kul-sunken-city` (new).
- Driver: `bun bun-apps/s2-agent/src/cli.ts --model deepseek-v4-flash
  --thinking medium -e bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts
  --no-extensions -p "<task prompt>"`, run from repo root, backgrounded (nohup).
- Task prompt hard requirements (verbatim from the goal doc): (1) real web
  search, cited URLs with credibility ratings, one fact-checkable specific
  number; (2) 3 genuinely differentiated `concept_options`; (3) zero
  `overrideArtifactValidation`/`overrideFinalReview`; (4) real T2I stills +
  real I2V motion with explicit duration control (~8-10s, pass `frames`
  explicitly — don't rely on `edit_decisions.out_seconds` alone); (5) run
  `pre-compose` before compose and resolve any warn/fail on
  `cut_duration_vs_source`; (6) TTS with no explicit provider; (7)
  `compose-motion`; (8) carry through to `publish`.
- **Pre-session correction**: local HEAD was detached and the prior
  session's pre-compose gate fix (5 commits, including the gate this run
  exists to test) had never been pushed to `origin/main` — it only existed
  on an orphaned detached-HEAD ref. Recovered it onto a branch
  (`precompose-gate-work-recovery`) and merged it into the run branch
  (`issyk-kul-drowned-city-v1-run`, based on synced `origin/main`) before
  launching, per [[feedback_sync_remote_main_before_goal]] and
  [[feedback_stray_dirty_files_diff_before_discard]]. Without this the run
  would have silently exercised the *old*, unfixed gate.
- Wall-clock: ~44 minutes end to end (17:53–18:38), 8-stage pipeline, 6
  scenes × T2I + I2V + narration + compose + publish.

## Result: PASS on both open questions

All 8 stages reached `status=completed`; every gated stage has
`human_approved=true`. Zero `overrideArtifactValidation`/
`overrideFinalReview` anywhere in the project's checkpoints/artifacts or the
session transcript (grepped programmatically).

### 1. CONCEPT differentiation on a history-elegy genre

**Yes — genuinely differentiated, and richer than the astronomy/neural-net
runs' comparisons.** From `artifacts/proposal_packet.json`:

| id | narrative_structure | hook | visual_approach | target audience |
|---|---|---|---|---|
| C1 "Central Asia's Pompeii" (selected) | `story` | "A thriving Silk Road city swallowed by a mountain lake in a single earthquake. Divers found skeletons still facing Mecca, millstones frozen mid-grind." | Cinematic serene→ruins transitions, split-screen then/now, ancestral-fade ghost overlays, diver's torch beam bridging past/present | General history enthusiasts, 25-55 |
| C2 "Crossroads of Faiths" | `timeline` | "One city. Four faiths. Tengri shamans, Buddhist monks, Nestorian Christians, Muslim scholars — a palimpsest of belief before the waters closed." | "Sediment layers" vertical timeline metaphor, each religious era a stratum dissolving into the next, final layer = the lake itself | Spiritually curious / interfaith readers, 30-65 |
| C3 "Fragments of a Silenced World" | `data_narrative` | "A millstone stopped mid-turn. A grain vessel sealed for 600 years. A skeleton still facing Mecca. Objects that tell the story better than any chronicle." | Forensic macro cinematography, each artifact a chapter card, 3D orbit + cutaway shots | Visual storytellers / museum-goers, 25-45 who like "object biography" content |

Three distinct `narrative_structure` values (`story`/`timeline`/
`data_narrative`), three hooks that are not reworded synonyms, three
distinct visual grammars and audiences. `selected_concept.rationale` gives a
real comparative argument, not boilerplate: *"C2 is beautiful but more
abstract — it risks being a lecture rather than an elegy. C3 is strong but
works better as a 5-minute museum short than a 90-second explainer where
each object needs room to breathe. C1 delivers the emotional gut-punch the
brief demands."* This explicitly engages with why the runners-up were
rejected, which the astronomy run's rationale did not do as concretely.

**Research grounding, independently checked**: `research_brief.data_points`
cites 6 real, resolvable URLs (Heritage Daily, Russian Geographical Society,
Artnews, Popular Mechanics, ZME Science) with `primary_source`/
`secondary_source` ratings. The flagged fact-checkable numbers — necropolis
**~14 acres (300×200m)**, depth **1-4m**, lake level **+8m** vs. medieval
times — all trace to the cited sources, not fabricated. `saturated_angles`/
`underserved_gaps` show genuine research reasoning (identifies the
"instant Pompeii" framing as the dominant existing angle, and picks the
underserved multi-faith/human-story gaps as differentiators).

### 2. Pre-compose gate live-fire result: **the gate caught a real problem AND the agent fixed it**

This is the strongest possible outcome from the three the goal doc
anticipated — not "agent discovers `frames` unprompted" *or* "gate catches
an under-shoot," but **both**, plus the gate catching an unrelated real
defect the frames fix didn't prevent:

- **Duration control discovered unprompted.** The agent ran
  `run.py video generate --help`, found `--frames`/`--fps`, and used
  `--frames 192` / `--frames 193 --fps 24` explicitly for all 6 scenes
  (192-193 frames @ 24fps ≈ 8.0-8.04s) — not the ~4s default, and not a
  frozen-frame `out_seconds` stretch. Confirmed independently: all 6 raw
  `sceneN_clip.mp4` files are **8.04s** via `ffprobe`, and per-clip SSIM
  between frames at 0.5s/3.5s is **0.18-0.41** (well under the ≲0.5 real-motion
  bar) — genuine LTX I2V motion throughout, not a still image extended.
- **The gate still caught a real bug.** First `pre-compose` call returned
  `verdict: "warn"` on `cut_duration_vs_source`: *"c1 requests 8.00s, source
  has 6.72s left (1.28s would be frozen, 16%)"* — scene 1's TTS-remixed
  video (`scene1_mixed.mp4`) had been truncated to 6.72s by an audio-shorter-
  than-video remix, which `edit_decisions` didn't know about. The agent
  padded the scene-1 TTS to 8s and re-remixed; the second `pre-compose` call
  returned `verdict: "pass"` on the same check. The agent did not compose
  through the warn — it fixed the actual asset and re-verified, exactly the
  behavior the gate was built to force.
- **A second, unrelated gate also fired and was fixed the same way**: the
  first `final-review` after `compose-motion` failed
  (`audio_level: "fail", mean=-91dB (near-silent)"` — the first compose pass
  dropped narration audio). The agent re-composed; the second `final-review`
  passed (`mean=-21.8dB`), matching this session's independent
  `ffmpeg -af volumedetect` check exactly.

Net: the duration-control gap from the prior two runs (`neuralnet` under-shot
silently; `ancient-quasars-v1` under-shot and papered over it with a 0.97-1.00
SSIM frozen-extension) did **not** recur here in either form — not because
the agent got smarter, but because (a) it discovered `frames` on its own
this time, and (b) even with that, a real asset-pipeline bug slipped through
and the new gate caught it before render, not after.

## Independent verification (this session, not the agent's self-report)

```
final_output.mp4: ~/video_generation__output/movie-director/projects/issyk-kul-sunken-city/final_output.mp4
  ffprobe: duration=48.21s, 640x960, h264 + aac
  volumedetect: mean_volume=-21.8dB, max_volume=-3.9dB (normal narration range)
  size: 15,444,989 bytes (15MB)

Per-scene raw I2V clips (assets/sceneN_clip.mp4), all N=1..6:
  duration: 8.04s (matches --frames 192-193 @ 24fps)
  SSIM (t=0.5s vs t=3.5s): 0.18 / 0.26 / 0.41 / 0.25 / 0.18 / 0.34 — all real motion

Zero overrideArtifactValidation / overrideFinalReview:
  grep -rl across project checkpoints + artifacts: no matches
  grep across full session transcript: no matches

TTS auto-defaulted correctly: asset_manifest.json, all 6 narration_sN entries
  have source_tool: "edge-tts" — task prompt never named a provider.

I2V asset provenance: asset_manifest.json, all 6 clip_scN entries have
  source_tool: "runpy-video" (real LTX I2V), not a still/zoompan substitute.
```

## Deviations found

None material. The two gate-fires described above (pre-compose warn,
final-review audio fail) are not deviations from the requirements — they are
the requirements' safety nets working as designed, with the agent correctly
responding to both rather than overriding or ignoring them.

## Significance

First real e2e run outside the astronomy/neural-net explainer shape — proves
CONCEPT's differentiation logic generalizes to a narrative-driven genre with
richer emotional/structural axes (timeline vs. story vs. data_narrative),
and the winner-selection rationale engaged concretely with the runners-up
rather than restating the brief. More importantly, this is the first run
where the pre-compose duration gate (built specifically because the prior
two runs silently under-shot or papered over duration with frozen-frame
extension) actually intercepted a real problem on a fresh run and the agent
recovered from it correctly — closing goal item 4 from
`next-goal-20260711_150430.md` with the strongest possible evidence: the
fix wasn't just unit-tested against a frozen fixture, it changed real agent
behavior on a run nobody scripted the outcome for.

One process note for future goal sessions: the gate fix this run depended on
was sitting unpushed on a detached HEAD at session start and would have been
silently bypassed (testing the pre-fix gate) had it not been caught and
merged in before launch. Worth pushing `bun-apps/s2-agent-ext-movie-director`
work-in-progress to a named branch (not leaving it on detached HEAD) as
routine hygiene after any session that ends without an explicit merge/PR.
