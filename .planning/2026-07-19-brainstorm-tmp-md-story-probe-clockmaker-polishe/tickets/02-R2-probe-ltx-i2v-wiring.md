# R2 — Probe LTX image-to-video pipeline wiring

type: research
claimed: (unclaimed)
blocked by: (none)

## Question

The story pipeline's `assets` stage lists `image_selector` and (implicitly)
video generation as tools. In the R2 probe, the auto-generated asset_manifest
showed `source_tool: "ltx"` and `generation_summary: "generated via t2i2v"` —
so the pipeline TRIED to use LTX — but all asset `path` fields were **empty**.

Does `produceAssets()` in `driver-wiring.ts` correctly drive LTX i2v when
given a correct scene_plan + the scene reference images? Trace the wiring:

1. Read `produceAssets()` — how does it decide t2i2v vs i2v vs stills? Where
   does it get the input image for i2v?
2. Does it call the `movie generate` (or `ltx native-i2v`) dispatch with the
   scene image path?
3. Do a **single-scene smoke test**: manually invoke whatever the pipeline
   would invoke for ONE clockmaker scene (e.g. `scene_1.png` → LTX i2v) and
   confirm a video clip is produced.

The destination needs all 5 scenes as LTX i2v clips. This probe confirms the
mechanical path works (or surfaces what's broken) before we commit 10–20 min
of GPU time to render all 5.

## How to resolve

- Read `driver-wiring.ts` `produceAssets()` + `assets-encoder.ts`.
- Check the dispatch path for LTX i2v: `ltx native-i2v {image, prompt}` or
  `movie generate`.
- Run one i2v render: `ltx native-i2v {image:"/tmp/md_story-probe/scene_1.png",
  prompt:"workshop intro, slow camera push in"}` — does it produce an mp4?
- Surface: does the pipeline wiring work, or does it need code fixes?

## Answer

_(pending)_
