# flux2-image-director

Swift CLI for Flux2 Klein 9B image generation on Apple Silicon (MLX). Image
director for multi-reference composition, style transfer, and face/scene editing.

## Build

```bash
# ALWAYS build release to RUN (debug builds hit a metallib crash at runtime).
swift build -c release --package-path swift/flux2-image-director
# → .build/release/flux2
```

## `flux2 scene` — multi-reference composition (Phase 8 + v2)

Composes a scene from N reference identities. v2 adds **background-as-canvas**
and **multi-LoRA stacking**.

### Background-as-canvas (`--bg`) — Workstream 1

By default every `--ref` is an identity/scene reference that only *steers* the
environment. Pass `--bg <image>` to make one image the **actual denoise canvas**:
its VAE-encoded latent becomes the SDEdit init latent, so the background's
**layout/POV is inherited** while characters emerge on top via the prompt +
identity refs. The `--bg` image is excluded from the identity refs.

```bash
flux2 scene \
  --ref charA.png --ref charB.png \
  --bg classroom.png --bg-strength 0.55 \
  --prompt "兩個角色坐在教室裡考試，表情平靜" \
  --width 1024 --height 1024 --steps 6 --seed 42
```

`--bg-strength` (SDEdit denoise fraction): `0.3` = light refine, `0.5` = restyle
keeping the layout, `0.7` = loose redraw. Characters are placed by prompt +
identity conditioning; precise left/right placement still needs regional masks
(not yet implemented — sweep `--seed`).

### Multi-LoRA stacking (`--lora`) — Workstream 2

`--lora` is **repeatable**; multiple LoRAs are rank-stacked into one merged
adapter (`Flux2LoRALoader.merge`): `A_merged = hstack(sqrt(sᵢ)·Aᵢ)`,
`B_merged = vstack(sqrt(sᵢ)·Bᵢ)`, so a single runtime path applies the sum. A
single `--lora` is numerically identical to a direct load.

```bash
flux2 scene --ref ... --prompt "..." \
  --lora anime-girl-turned-into-real-person --lora highresolutionflux2-kelien-9b \
  --lora-scale 0.8 --lora-scale 1.0
```

`--lora-scale` is repeatable (one per `--lora`; trailing ones default to `1.0`).
LoRA names resolve to `models/lora/<name>/*.safetensors` (prefers `*.int8.*`).

### Self-gating

Every output is self-gated by the shared `ImageGate` (noise / blank / NaN check).
`--strict-gate` aborts (exit 1) on a FAIL.

## Reproduce the full workflow

```bash
bash scripts/multiref-scene.sh   # z-image refs → flux2 scene (--bg + LoRAs) → gallery
```
