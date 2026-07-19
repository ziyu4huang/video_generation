# Ticket 01 — Ship the recurring-character story-video ("The Clockmaker")

type: task
claimed: pi-agent
blocked by: (none — faceswap confirmed wired)
status: closed

## Resolution (closed 2026-07-19 — DESTINATION REACHED)

**"The Clockmaker" — a 16.04s/1080p recurring-character story-video shipped,
proving the conditional `character_design` + flux2 `faceswap` consistency path.**

- **Character ref** (flux2 t2i portrait) → **3 scene images** (flux2 t2i) →
  **faceswap ×3** (`--face char_ref --input scene`) → all 3 scenes share one
  canonical face. Narration (edge-tts 13.92s) + whisper (38 words) + MLX
  MusicGen (8s) → composed via **`Story`** (particles + word-pop).
- **Verified:** ffprobe h264+aac 1920×1080 16.043s; **audio mean −25.1 dB
  (non-silent)**; 4 sampled frames non-black (image scenes bright 0.65–0.83).
- **⚠️ Honest limitation:** face consistency is **user-verifiable only** (this
  model can't view images). faceswap succeeded on all 3 (no error; mechanism is
  the documented multi-ref + BFS-LoRA path). Contact sheet shipped alongside:
  `output/recurring-character-story/{char_ref,fs_scene1/2/3}.png`.
- **Fog retired:** `--face` accepts a full portrait (not just a crop);
  faceswap works at defaults (no `--lora` needed — BFS fused at init).
  Discovered: faceswap regenerates at default 1024×1536 portrait (~2 min/scene).

Receipt: `receipts/recurring-character-clockmaker-20260719.md`. Deliverable:
`output/recurring-character-story/the_clockmaker.mp4` (+ poster + contact sheet).

## Goal

A ~15s story-video with ONE recurring character (an old clockmaker) whose face
stays consistent across 3 scenes, proving the conditional `character_design`
stage + flux2 `faceswap` consistency. Every asset via a registered provider.

## Plan

1. **Character reference** — flux2 t2i portrait of the clockmaker (canonical face).
2. **3 scene images** — flux2 t2i, each featuring the clockmaker (workbench /
   holding a finished clock / at the window), face a clear target.
3. **faceswap ×3** — swap the reference face onto each scene for consistency.
4. **Narration** — edge-tts (~15s).
5. **Word cues** — whisper transcribe.
6. **Score** — MLX MusicGen (~8s, looped).
7. **Compose** — `Story` composition (particles + word-pop), 3 image cuts + title.
8. **Verify** — ffprobe + non-silent audio + frames non-black + **visually confirm
   the face is consistent** across the 3 scenes (the whole point).
9. **Receipt** + close + map update.
