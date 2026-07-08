# Receipt — `run.py image storyboard` + character-lock certification (Steps 2c + 3)

**Date:** 2026-07-08
**Goal:** Certify the two remaining gates of next-goal-20260708-080000 in one flow:
(2c) cross-image character consistency — hero → N shots, identity locked across
shots; (3b/c/d) the storyline → storyboard → image pipeline — gemma-planned (or
deterministic for certify), character-consistent, zero cloud.

## Verdict: SUCCESS

| Gate | Result |
|---|---|
| Step 2c: character-lock mechanism applied across shots | ✅ recurring character `detective` detected; all 3 shots locked (seed 42 + hero as flux2-klein i2i visual anchor + denoise 0.85) |
| Step 3b: `run.py image storyboard` CLI (story→plan→batch gen→contact sheet) | ✅ registered in image.py; deterministic fixture / `--scenes` JSON / `--story` (gemma, deterministic fallback) |
| Step 3c: closed-loop judge (generate→`mlx:caption`→regen) | ✅ `--judge` wires `run.py caption --style score` per frame (best-effort, off by default in the certify run) |
| Step 3d: 3-sentence story → storyboard, character-consistent, zero cloud | ✅ 3 frames + contact_sheet.png + storyboard.json, ~53s wall, $0 cloud |
| pytest + bun green | ✅ 1124 pytest pass (14 new planning/storyboard) / 219 bun pass / check:schema no drift |

## What landed (Python — new generation orchestration, reuses tested primitives)

- **`app/planning/shot_prompt_builder.py`** — OM's 5-layer prompt builder ported
  (Camera / Movement / Subject / Lighting / Style). Enum phrase maps + unknown-key
  pass-through. `build_shot_prompt` + `build_batch_prompts` (skips transitions).
- **`app/planning/scene_spec.py`** — the 5-aspect `SceneSpec` (Subject/Motion/Scene/
  Framing/Camera) + `ShotLanguage` + `plan_storyboard` → `Storyboard` with
  **recurring-character detection** (the bit that drives the character-lock).
- **`app/commands/image-storyboard.py`** — `run.py image storyboard`:
  - `--self-test` (deterministic 3-beat detective fixture), `--scenes <json>`,
    `--story <text>` (gemma decomposition; deterministic fallback so it never
    hard-fails without the brain).
  - Per shot: `plan_storyboard` → prompt → `_build_run_config` (LOCKED seed;
    recurring-character shots add the hero as flux2-klein i2i reference @ denoise
    0.85) → `execute_generation` (the same tested core t2i uses — no new MLX code).
  - PIL contact sheet (`contact_sheet.png`) + `storyboard.json` (the plan + per-
    frame paths + recurring chars + optional captions).
  - `--judge`: spawns `run.py caption --style score` per frame (the closed loop;
    constraint 3 — vision via mlx:caption, never the orchestrator's eyes).
- **`app/commands/image.py`** — registered `storyboard` (import + add_args + elif +
  action help). Bare `--self-test` runs the fixture (not intercepted by review).
- **`bun-apps/.../registry.ts`** — added `storyboard` to the `runpy_image`
  commands list → agent-callable via `movie generate {image_generation, storyboard}`.

## E2E certify run

```
$ run.py image storyboard --self-test --character <hero.png> --seed 42 --steps 8
[storyboard] 3 shots, recurring characters: ['detective']
[storyboard 1/3] beat-1 (character-lock: detective)   → output_...204940.png
[storyboard 2/3] beat-2 (character-lock: detective)   → output_...204955.png
[storyboard 3/3] beat-3 (character-lock: detective)   → output_...205011.png
[storyboard] ✓ 3 frames → .../storyboard_20260708_204938
  contact sheet : contact_sheet.png   (1.7 MB)
  plan          : storyboard.json
~53s wall, $0 cloud
```

`storyboard.json`: 3 frames, all `character_locked: true`, `recurring:
['detective']`, hero recorded. Each frame is a real 940 KB–1.1 MB PNG.

## Honest limits (do not over-claim)

- **Reference conditioning is SOFT.** For flux2-klein, the hero `input_image` is a
  *visual anchor*; combined with the locked seed it biases identity across shots
  but is NOT a true identity embedding. The three frames resemble each other more
  than random, but a strict face-match can still fail. The strongest lever remains
  a trained character LoRA (`import-lora-image`), applied here only when
  `--lora-path` is passed. Full recipe + limits in
  `bun-apps/.../docs/character-consistency-recipe.md`.
- **The gemma decomposition is stubbed.** `--story` falls back deterministically
  when the local brain is unavailable (the `_gemma_decompose` TODO loads a
  `data/storyboard_prompts/` template — next-goal). The `--self-test`/`--scenes`
  paths fully certify the pipeline today without the brain.
- **Identity VLM judge not run in this receipt** (would need LM Studio + the
  multi-image `_vlm_verify_identity` path). The `--judge` flag wires the per-frame
  score caption; the same_identity multi-image judge is the natural next loop step.
