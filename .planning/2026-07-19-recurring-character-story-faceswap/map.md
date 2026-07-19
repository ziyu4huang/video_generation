# Wayfinder map: 2026-07-19-recurring-character-story-faceswap

## Destination

Ship a story-video with a **recurring character whose face stays consistent
across scenes**, proving the conditional `character_design` stage + flux2
`faceswap` consistency end-to-end — the one capability envelope the
lighthouse effort (2026-07-19-fix-music-...) deliberately did NOT exercise.

Same manual-artifact flow as the lighthouse destination, plus faceswap in the
assets loop.

## Notes

- **faceswap is wired** (confirmed 2026-07-19): registered command on
  `flux2_image` (`registry.ts:114`, `bridge.ts:360`), Swift-native
  (`FaceSwapCommand.swift`), driven by `--face <ref>` + `--input <scene>`.
  So this is a usage/proving effort, not a code effort.
- **Prescribed flow** (`character_design.schema.json`): character_design
  produces a flux2 t2i character reference; assets generates each scene then
  faceswaps the reference face onto the scene's person for consistency.
- **Chosen story** (propose + proceed, lighthouse precedent): **"The
  Clockmaker"** — a single old clockmaker across 3 scenes (workbench / holding
  a finished clock / at the window). Visually rich, face clearly the focus in
  each scene (so faceswap has a clear target).
- Warm model caches from the lighthouse effort (musicgen-small, whisper-large-v3)
  — no re-download.

## Decisions so far

- [01 — Ship the recurring-character story-video](tickets/01-ship-recurring-character-story.md) — **DESTINATION REACHED**: "The Clockmaker" — 16.04s/1080p story-video, one character ref → 3 flux2 t2i scenes → **faceswap ×3** for consistency, composed via `Story`. Audio non-silent (mean −25.1 dB), frames non-black. **faceswap proven wired + working** (Swift-native `FaceSwapCommand`, `--face`+`--input`, ~2 min/scene). Face-consistency is user-verifiable only (contact sheet shipped).

## Not yet specified

**FRONTIER EMPTY — destination reached.** Both fog items resolved by [01](tickets/01-ship-recurring-character-story.md):

- **`--face` input shape** — resolved empirically: a full portrait works
  (FaceSwapCommand accepts the char_ref portrait directly; no tight crop needed).
- **faceswap fidelity/strength** — resolved: defaults work (no `--lora` required;
  BFS LoRA is fused at init). faceswap regenerates at a default 1024×1536 portrait
  aspect (face-conditioned generation, not a pixel paste) — scene composition can
  drift, the face is the invariant.

Polish (not decisions): a perceptual/face-embedding consistency check to remove
  the "user-verifiable only" caveat; forcing faceswap to honor the input aspect.

## Out of scope

- Training a character LoRA (heavier than faceswap; faceswap-per-scene is the
  in-scope mechanism).
- Cloud video-gen / multi-character scenes (one recurring character only).
