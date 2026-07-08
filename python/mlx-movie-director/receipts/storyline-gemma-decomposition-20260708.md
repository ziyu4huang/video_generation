# Receipt — Storyline creation: gemma decomposition + closed loop (Step 1 of next-goal-20260708-220000)

**Date:** 2026-07-08
**Goal:** Turn the certified deterministic storyboard backbone (PR #363) into a
real story→storyboard tool: wire the **local gemma brain** to decompose free-form
story text into a `SceneSpec[]` (Story2Board-shaped), then close the loop
(generate → `mlx:caption` score + multi-image identity judge → regen weak). The
user's #1 emphasis. Zero cloud.

## Verdict: SUCCESS

| Gate | Result |
|---|---|
| `run.py image storyboard --story <text>` gemma-decomposed | ✅ gemma-4-26b decomposed a 3-sentence story → 4 SceneSpec panels, recurring `elias_thorne` identity, diverse cinematography |
| 4-panel storyboard produced | ✅ 4 frames + contact_sheet.png + storyboard.json, character-locked, $0 cloud |
| Closed loop judges + regenerates | ✅ identity judge flagged beat-2 `same=False` → regenerated once (OM D12), re-judged |
| pytest + bun green | ✅ 1131 pytest (+7 decompose) / 219 bun / pyflakes clean / check:schema no drift |
| No cloud | ✅ brain = local gemma (LM Studio); judge via `mlx:caption` + `_vlm_verify_identity`; generation local flux2-klein |

## What landed

- **`app/planning/decompose_prompt.py`** — pure: `build_decompose_prompt(story,
  num_panels, style_hint)` embeds the SceneSpec JSON schema + OM's 5-aspect CHAI
  self-review gate + the "identity anchored verbatim, diverse camera" rules;
  `parse_decomposition` strips `<think>`, handles ```json fences, recovers
  inner-think text, falls back to span-extract. 7 unit tests.
- **`app/planning/gemma_brain.py`** — `decompose_story()`: text-only chat
  completion to the local gemma brain (reuses `caption.resolve_default_model` +
  `_lmstudio_ensure_model`); parses `content` then falls back to
  `reasoning_content` (Gemma-4 puts the answer in reasoning when the token budget
  runs out mid-content).
- **`app/commands/image-storyboard.py`** — `_gemma_decompose` wired (was a stub);
  `--story` / `--num-panels` / `--style-hint` args; the closed loop:
  `_judge_frames` (mlx:caption score) + `_judge_identity`
  (`_vlm_verify_identity` multi-image vs hero) + `_regenerate_weak_identity`
  (regen-once + re-judge). `--vlm-api-url`/`--vlm-model` reused from profile's
  shared-parser registration.

## E2E certify run

```
$ run.py image storyboard --story "Detective Elias Thorne discovers a cryptic
  note in a rain-soaked alley, traces the clue to an all-night diner, and finally
  corners his suspect on a rooftop as dawn breaks." \
  --character <hero.png> --num-panels 4 --seed 42 --steps 8 --judge
[storyboard] gemma decomposed 4 panels.
[storyboard] 4 shots, recurring characters: ['elias_thorne']
[storyboard 1/4] beat-1 (lock) — 50mm close-up, hand reaches for note
[storyboard 2/4] beat-2 (lock) — 35mm medium, dolly in, staring
[storyboard 3/4] beat-3 (lock) — 24mm wide, tilt up
[storyboard 4/4] beat-4 (lock) — 85mm over-shoulder, revolver aimed
[identity] beat-2: same=False score=1 → WEAK (will regen)
[storyboard] regenerating 1 identity-weak frame(s) once (OM D12 loop)
[regen] beat-2 re-judged
[storyboard] ✓ 4 frames → .../storyboard_20260708_221107 (6:33 wall, $0 cloud)
```

`storyboard.json`: 4 shots all `character_locked`, recurring `['elias_thorne']`,
hero set, per-frame captions recorded; beat-2 `regen_attempted=True` after
`identity.same_identity=False`.

## Honest limits (do not over-claim)

- **Decomposition is slow (~3–5 min).** Gemma-4-26b-a4b-qat is a THINKING model
  that ignores `enable_thinking:false` and emits a large reasoning block before
  the JSON. `_MAX_TOKENS=14000` + `timeout=600s` lets the reasoning complete (the
  JSON then lands in `content` and/or `reasoning_content`; the parser checks
  both). It is a one-time planning call per storyboard — acceptable, but a
  faster non-thinking local model would be a better decomposition brain (the
  stack's fallback `deepseek-v4-flash` is cloud → ruled out by constraint 2).
- **Gemma multi-image identity JSON is flaky.** Of 4 identity judgments, only
  beat-2 returned parseable JSON (`same=False` → correctly triggered regen);
  the other 3 raised `JSONDecodeError` → recorded as "judge unavailable,
  skipped." `_vlm_verify_identity` was designed for Qwen3-VL (per profile's
  docstring); gemma-4-26b as the brain is less reliable for multi-image JSON.
  The closed-loop MACHINERY is proven (beat-2 end-to-end: judge→weak→regen→
  re-judge); VLM reliability is the soft spot — loading Qwen3-VL for the
  identity judge tier (it's the no-gemma fallback in `caption._resolve_model`)
  would harden it. No silent failure: unavailable judges are recorded, never
  block the storyboard.
- **Reference conditioning stays SOFT** (see `docs/character-consistency-recipe.md`);
  the CharaConsist v2 upgrade is Step 3 of this goal.

## Web references used

- Story2Board (arXiv 2508.09983) — training-free narrative→panels with consistent
  identity + layout diversity (the decomposition target shape).
- OM `cinematic/asset-director.md:106` — the 5-aspect CHAI self-review gate
  embedded in the prompt.
