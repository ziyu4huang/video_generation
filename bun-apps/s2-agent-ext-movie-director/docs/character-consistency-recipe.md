# Character Consistency — the local MLX recipe

> Step 2 of next-goal-20260708-080000. OM's #1 challenge is "identity anchored
> verbatim across shots." This is the honest local recipe, the primitives it
> stacks, and its real limits. Grounded in web research (2026-07-08): the
> reliable local pattern is **trained LoRA + seed/CFG lock + reference
> conditioning** (mayerdan), with CharaConsist (arXiv 2507.11533) and Story2Board
> (arXiv 2508.09983) as the SOTA reference shapes.

## The stack (strongest → weakest lever)

| Lever | Mechanism | Strength | Where in run.py |
|---|---|---|---|
| **Trained character LoRA** | A LoRA fine-tuned on the character bakes identity into the weights | **Strongest** — the only thing approaching a true identity embedding on local silicon | `import-lora-image` (download + quantize + symlink); applied via `--lora-path` on any image command |
| **Seed lock** | Same seed every shot → same noise prior → correlated identity | Reliable + free (no quality cost) | `--seed` (image-profile already locks one seed across all views for exactly this reason) |
| **Reference conditioning** | Flux2KleinEdit re-encodes the hero as a conditioning latent (`--ref-count` × copies at `--ref-strength`) | SOFT — style/identity influence, NOT an embedding; drifts under high denoise | `image-profile` / `image-i2i` / `image-anime2real` (`--ref-count`, `--ref-strength`) |
| **Style/palette anchor** | A shared prompt suffix locks the LOOK (lighting, grade, medium) so scenes read as one film | Indirect — keeps style consistent, not identity | the `styleAnchor` field on `CharacterLock` |

The four stack; they are not alternatives. The planner (`src/character_lock.ts`)
applies 2 + 3 + 4 by default and 1 when a `loraPath` is supplied.

## How to use it (via the agent bridge)

`profile` (multi-view) and `i2i` (arbitrary scene) are both agent-callable
through the `mlx:runpy-image` adapter landed in Step 1:

```
# Multi-view character sheet (front/back/side) — the built-in identity lock:
movie generate { capability:"image_generation", command:"profile",
                 options:{ input:"hero.png", pipeline:"flux2-klein",
                           seed:42, refCount:3, refStrength:0.8 } }

# Arbitrary cross-scene shots — the planner emits one locked i2i per scene:
# (plan in TS via planCharacterShots(), then drive each shot through the adapter)
```

For programmatic cross-scene consistency, `planCharacterShots({hero, lock, scenes})`
returns a reusable `IdentitySpec` (the local character-reference-bank entry) +
one locked `RunPyImageOptions` per scene. Each shot conditions on the hero with
identical seed/CFG/ref/LoRA/style. See `src/character_lock.ts`.

## Honest limits (do not over-claim)

- **Reference conditioning is SOFT, not identity embedding.** Flux2KleinEdit ref
  conditioning biases the output toward the hero's appearance but does NOT
  guarantee the same person — especially at the high denoise a new scene needs.
  Two shots of "the same character in different scenes" will resemble each other
  more than random, but a strict identity check can still fail. This is the
  fundamental gap vs. a true IP-adapter / identity embedding, which MLX does not
  have (deferred — see the goal's Future plan).
- **The strongest lever is a trained LoRA.** `import-lora-image` exists, but
  TRAINING a character LoRA is a separate workflow (collect 10–20 shots → train
  → quantize). It is out of scope for the planner; the planner just APPLIES a
  pre-trained `--lora-path` when given one.
- **Seed lock helps but is not magic.** Same seed + same prompt → identical image.
  Same seed + DIFFERENT prompt (different scene) → correlated but not identical
  identity. The correlation is the value, not a guarantee.
- **Best results need a VLM identity judge.** `image-profile` ships
  `_vlm_verify_identity` (multi-image: same_identity / face_match / hair_match /
  skin_match / outfit_match / identity_score) — the closed loop is generate →
  `mlx:caption`/profile-verify → regenerate weak shots. Use it; don't eyeball.

## MLX-bug awareness

When the ref-conditioning path breaks, consult FIRST:
- `python/mlx-movie-director/app/vendor_patches.py` (P11 LTX int4/g32, P12 mflux
  int8 LoRA noise — see [[mflux-int8-lora-noise-bug]]).
- Upstream: `filipstrand/mflux` (Flux MLX), `FiditeNemini/z-image-turbo-mlx`.
- Memory: [[i2i-flux2klein-tembedder-shape-bug]], [[anime2real-reference-conditioning]],
  [[multi-character-latent-couple]].

## What's deferred (next-goal)

- A dedicated `run.py image character` sub-action that bundles the planner's
  per-shot orchestration + writes the `IdentitySpec.json` alongside the set
  (today the planner is TS-side; the Python sub-action makes it a single CLI call).
- Closed-loop certification: hero → 4 scene shots → `_vlm_verify_identity` judges
  same_identity across the set → regenerate failures. The judge machinery EXISTS
  (profile); the multi-scene wiring + receipt is the next-goal.
- True identity embedding / IP-adapter on MLX (research; the goal marks this deferred).
