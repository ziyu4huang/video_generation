# Receipt — real e2e #2: "How Neural Networks Learn" (deterministic, schema-strict)

**Date:** 2026-07-11
**Goal:** Prove the CONCEPT-stage schema gate (closed 2026-07-10, see
`concept-e2e-20260710.md`) composes cleanly with a FULL real 8-stage pipeline
run on a story disjoint from every prior test (sky-blue, internet-history,
coffee, solar-panel), with **zero `overrideArtifactValidation` calls** —
every checkpoint is genuinely schema-valid, not bypassed.

## Setup

- Story: OpenMontage Quick Start prompt class — "Make a 45-second animated
  explainer about how neural networks learn" — narrowed to a 20s two-shot
  brief ("How Neural Networks Learn": guess→correct, backprop + gradient
  descent named as a duo).
- Research grounded in 5 real, cited web sources (IBM, indepth.dev, Medium,
  Pluralsight, a Substack post) fetched live 2026-07-11, not invented facts.
- Pipeline: `animated-explainer`, project `neuralnet-real-e2e-v1`.
- Driver: **deterministic script** (`scripts/run-real-e2e-neuralnet.ts`), no
  LLM in the loop — same rationale as `run-h-real.ts`: isolates "does the
  real pipeline + real gate work" from local-model tool-adherence flake.
- Assets: `runpy-image` (local MLX Z-Image T2I, 2 scenes, 9 steps each) +
  macOS `say` (Samantha) narration — same tooling class as the agent-driven
  skyblue real e2e, zero cloud spend.
- Compose: `compose-motion` (ffmpeg zoompan + xfade), not Remotion — no
  browser/Node subprocess dependency.

## Result: full PASS, zero overrides, 3 real bugs found and fixed along the way

All 8 checkpointed stages (`research → proposal → script → scene_plan →
assets → edit → compose → publish`) completed with `status:"completed"`,
schema-valid artifacts, and the compose/publish human-approval gates
satisfied — via genuine schema-conformant content, not
`overrideArtifactValidation`. `final_review` passed all 6 checks including
`audio_level` (mean −16.1dB, real narration, not silence). Final video:
19.5s, 1024×576, h264/aac, 1.46MB.

Getting to this clean state surfaced three real, previously-undiscovered
bugs — each one only shows up when you drive the full pipeline schema-strict
(a fixture-only or override-tolerant test would never hit them):

### Bug 1 — `composeMotion`'s `opts.output` is not the final file

`composeMotion(edit, { output })` only names the **pre-audio-mix join**
file. Once narration/music mixing runs, the real deliverable is a
separately-named `motion_audio_<ts>.mp4` in the same workDir, and
`report.outputs[0].path` reflects that — `opts.output` does not get
overwritten or symlinked. A caller that trusts its own requested `output`
path (as this script initially did, and as any hand-rolled caller of
`compose-motion` reasonably would) silently reviews/publishes the **silent
pre-mix bed** instead of the real mixed video. Confirmed by direct A/B:
`neuralnet_explainer_20s.mp4` (the requested path) measured mean_volume
−91dB; `motion_audio_1783734738.mp4` (the actual `report.outputs[0].path`)
measured −16.1dB. Not fixed in source (workaround: always read
`report.outputs[0].path`, never trust the requested `output` param) —
tracked as a follow-up in `next-goal.md`.

### Bug 2 (fixed) — `render_report.render_grammar` schema enum rejected every real composer's own output

`data/schemas/artifacts/render_report.schema.json`'s `render_grammar` enum
only listed `renderer_family` values (`explainer-data`, `cinematic-trailer`,
...). But `compose_motion.ts:313` stamps `render_grammar: "motion"` and
`remotion.ts:322` stamps `render_grammar: "remotion"` — neither value was in
the enum. Any real (non-overridden) `write-checkpoint` on the `compose`
stage using either composer was **guaranteed to fail** the artifact gate.
Fixed: broadened the enum to `[...renderer_family values, "remotion",
"motion"]` (`render_report.schema.json`), confirmed live by this run's
`compose` checkpoint completing schema-valid post-fix, and by
`bun test src/compose_motion.test.ts src/remotion.test.ts` still green (34
pass, 0 fail across the touched test files).

### Bug 3 — my own script's `publish_log` shape didn't match schema

Root-caused to me guessing the shape from `run-h-real.ts`'s comment style
instead of reading `publish_log.schema.json` — the real schema is
`{version, entries: [{platform, status, timestamp, ...}]}`, not a flat
`{mp4_path, duration_seconds, ...}`. Fixed in the script. Not a repo bug —
recorded here as evidence the gate genuinely rejects wrong shapes rather
than rubber-stamping.

## Artifacts

- Script (reusable, re-runnable): `scripts/run-real-e2e-neuralnet.ts`.
- Checkpoints + assets + final video:
  `../video_generation__output/movie-director/projects/neuralnet-real-e2e-v1/`.
- Run log: captured inline in this receipt's authoring session.

## Conclusion

The CONCEPT-stage gate (2026-07-10) and the full 8-stage pipeline compose
cleanly for a real, schema-valid, override-free run — this is the first time
that's been proven end-to-end without any `overrideArtifactValidation` at
any stage. Two of the three bugs found were real repo defects (one fixed,
one open); both are exactly the class of gap that only surfaces once you
insist on schema-strict, non-override, non-fixture-copied content — which
was the point of running a genuinely new story instead of replaying
sky-blue.
