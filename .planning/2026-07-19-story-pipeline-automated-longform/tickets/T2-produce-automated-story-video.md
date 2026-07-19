# T2 — Produce 1–2 min automated story-video via run-pipeline

type: task
claimed: pi-agent
blocked by: R2 — Verify pipeline post-fix
status: closed

## Resolution (closed 2026-07-19 — SHIPPED)

Produced **"The Clockmaker's Legacy"** — 90-second story video, 1280×720, h264+AAC.

### Progression

Complete pipeline: research → proposal → script → character_design →
scene_plan → assets → edit → compose → publish. 7 of 9 stages processed
automatically (LLM waypoints + mechanical); character_design was a manual
bypass (no recurring characters needed).

### Assets

| Scene | Duration | Image |
|-------|----------|-------|
| workshop_intro | 0–20s | `/tmp/md_story-probe/scene_1.png` |
| gears_macro | 20–40s | `/tmp/md_story-probe/scene_2.png` |
| the_master | 40–65s | `/tmp/md_story-probe/scene_3.png` |
| the_apprentice | 65–80s | `/tmp/md_story-probe/scene_4.png` |
| legacy | 80–90s | `/tmp/md_story-probe/scene_5.png` |

- Images: flux2 t2i, 1280×720, ~25s each
- Music: MLX MusicGen (facebook/musicgen-small), 8s looped to 90s
- Compose: ffmpeg concat + scale/pad, AAC audio

### Output

```
/tmp/md_story-probe/clockmaker_final.mp4  (90s, 1280×720, 3.4MB)
```

### Known limitations

- No dissolve transitions (scene cuts are abrupt)
- No Ken Burns zoom/pan (static images only)
- No title overlay or captions
- Music is looped 8s → 90s (clean but repetitive)

All addressable with richer compose parameters in a follow-up effort.
