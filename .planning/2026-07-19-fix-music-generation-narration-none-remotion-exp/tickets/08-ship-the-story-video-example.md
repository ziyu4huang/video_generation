# 08 — Ship the story-video example

## Question

Run an **actual, original story** end-to-end through the new `story` pipeline
(music provider [04](04-music-provider-integration.md) + `Story` compose [06](06-story-compose-composition.md)
+ `story.yaml` [07](07-story-yaml-manifest.md)) to a **finished, playable MP4** —
the demo that defines "done" for this effort. What's the story, and does it clear
every gate?

Concretely:

1. **Pick the story.** A short (30-90s) original narrative suited to the native
   stack. Decide its motion source (flux2 images + Remotion motion, Candyland-
   style; or LTX-2.3 generated clips) — this is the map's "example motion source"
   fog graduating here. Pick one that exercises recurring characters if possible
   (to prove the consistency path), but don't over-scope.
2. **Run the full chain.** `run-pipeline` (or the `movie` tool) through all 8
   stages: idea → proposal (gated) → script → scene_plan → assets (image/video +
   TTS narration + **music** via [04](04-music-provider-integration.md)) → edit →
   compose (the **`Story`** composition with particles + word-pop captions via
   [06](06-story-compose-composition.md)) → publish.
3. **Verify, don't assert.** The final MP4 must: pass `final_review` (audio level
   non-silent — music + narration mixed), play in ffprobe, show particles + word-
   captions in sampled frames, and carry a real (non-silent) soundtrack. Produce a
   receipt under `receipts/` mirroring `run-pipeline-full-chain-20260714-rainbows.md`.
4. **Close the fog.** Running the example resolves the remaining "Not yet
   specified" items (character consistency verdict, mood→query fidelity) by
   evidence — record them in the map's Decisions-so-far.

### Context (pre-gathered — don't re-investigate)

- The full 8-stage chain is proven (rainbows receipt, 13.2s/1080p) — this ticket
  re-runs it with the three new capabilities attached, not a from-scratch pipeline
  proof.
- The destination (map.md) is **ship an original example** — this ticket IS the
  destination. Until it lands, the three pillar tickets are unproven together.

type: task
claimed: pi-agent
blocked by: 04 — Music provider integration, 06 — Story compose composition, 07 — story.yaml manifest
status: closed

## Resolution (closed 2026-07-19 — DESTINATION REACHED)

**"The Lighthouse Keeper" — a finished 14.55s/1080p story-video shipped, every
asset through a registered provider, all three gaps closed together.**

- **Assets (all via the extension's providers):** 3× flux2 t2i scene images;
edge-tts narration (11.35s); **MLX MusicGen score** (8s, local, CC-BY-4.0);
whisper **32 per-word cues**.
- **Compose:** the **`Story` composition** (06) — 5 cuts (2 text + 3 image w/
  ken-burns/zoom/pan) each with a **particle overlay** (sparkle/firefly/petal),
  **TikTok-style word-pop captions** from the word cues, narration + looped
  ducked music.
- **Verified:** ffprobe h264+aac 1920×1080 14.549s; **audio mean -25.7 dB
  (non-silent — narration+music mixed)**; 4 sampled frames non-black, image
  scenes bright-frac 0.57–0.61. Receipt:
  `receipts/story-example-lighthouse-keeper-20260719.md`; deliverable:
  `output/story-example/lighthouse_keeper.mp4` (+ poster).
- **Fog retired:** character-consistency mechanism in place but not exercised
  (no recurring character — by design); mood→query = explicit prompt authored
  from scene mood; motion source = flux2 images + Remotion motion.
- **CLI gotcha surfaced:** `--options` nests provider opts under `{"options":{...}}`
  (flat silently drops them) — worth a doc note.
