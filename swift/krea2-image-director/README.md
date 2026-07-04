# krea2-image-director

Swift front-end for **Krea 2 Turbo** T2I/I2I on Apple Silicon. Sibling to
`z-image-director` / `flux2-image-director` / `ltx-video-director`, sharing
`image-gen-utils` and `common-image-director`; reuses `z-image-director`'s
native Qwen3 text encoder.

See [PLAN.md](PLAN.md) for the port log — the python reference
(`python/mlx-movie-director/app/krea2_*.py`) is fully parity-validated;
the native Swift DiT/VAE/encoder port is in progress (`--bridge` still shells
out to the python pipeline where the native path isn't done yet).

## Build

```bash
cd swift/krea2-image-director
swift build
./scripts/setup-metallib.sh   # one-time: copy the venv's mlx.metallib next to the built binary
swift test
```

## Usage

```bash
# Text-to-image, native Swift engine
swift run krea2 t2i --prompt "a cinematic portrait, dramatic lighting" \
  --width 1024 --height 1024 --steps 8 --seed 42 --out out.png

# Text-to-image via the python bridge (Phase 0 fallback)
swift run krea2 t2i --prompt "..." --bridge

# Image-to-image (SDEditor-style, native Swift)
swift run krea2 i2i --input source.png --prompt "..." --strength 0.6 --out out.png

# ControlNet = Control LoRA (facok/comfyui-krea2-controlnet port). Supply a
# preprocessed conditioning image (e.g. a depth map) + the Control LoRA weights
# (Patil/Krea-2-depth-controlnet depth-control-lora.safetensors).
swift run -c release krea2 controlnet \
  --prompt "..." --control-image depth.png \
  --control-lora depth-control-lora.safetensors --strength 1.0 \
  --channel-mode gray --normalize minmax --out out.png

# Style transfer (jieg9341-lab/ComfyUI-Krea2-StyleTransfer port). Training-free;
# applies a style reference image's style to the prompt's generation. No weights.
swift run -c release krea2 style-transfer \
  --prompt "..." --style-image reference.png --strength 1.0 --out out.png

# ControlNet + Style Transfer composition (both features in one engine call).
swift run -c release krea2 control-style \
  --prompt "..." --control-image depth.png --style-image reference.png \
  --control-strength 1.0 --strength 1.0 --out out.png
```

> **Composition note:** `control-style` runs the LoRA-injected DiT + control
> tokens + styled 2-B attention in one forward. Both effects stay live, but the
> Control LoRA suppresses the style's palette transfer (style shift +132 → ~0).
> See `docs/controlnet-styletransfer-validation.md` (composition addendum).

## ControlNet & Style Transfer

Two ComfyUI krea2 features ported to pure-native Swift/MLX. See
[`docs/controlnet-styletransfer-port.md`](docs/controlnet-styletransfer-port.md)
for the full design + the minimal-port scope.

- **`controlnet`** — the "ControlNet" is actually a rank-64 Control LoRA
  (`Patil/Krea-2-depth-controlnet`, 862 MB) + an expanded input projection. The
  control image (depth/pose/edge, preprocessed externally) is VAE-encoded →
  patchified → added at the DiT input projection; 224 low-rank LoRA pairs are
  applied to the block linears. Injects ONCE at the input (not per-block).
- **`style-transfer`** — training-free K/V attention injection. Three
  mechanisms: (1) a Reference-Forecast cache (forward-integrate the style
  latent along the sampler sigmas with the base model velocity, Heun PC γ=0.5);
  (2) 2B batch `[target ; ref_noisy]` each step; (3) per-frequency-scaled K +
  AdaIN-mixed V injection in blocks 7…27. No adapter weights required.
- **`control-style`** — both features in one engine call (LoRA + control + styled
  2-B). The two modify orthogonal DiT paths so they compose; the LoRA's reshape
  of the block linears suppresses the style's palette transfer (honest, characterized).

## Requirements

- Swift 6.0+, macOS 15+ (Apple Silicon)
- The repo's converted Krea 2 weights + the mlx venv (for `--bridge` and for
  `scripts/dump_*_reference.py` parity dumps).

## Layout

```
Sources/Krea2ImageDirector/      # DiT, VAE, sampler, RunPyBridge
Sources/Krea2ImageDirectorCLI/   # t2i / i2i commands
scripts/dump_*_reference.py      # python reference tensor dumps for parity tests
test_refs/                       # captured reference tensors (rope, dit, vae)
Tests/Krea2ImageDirectorTests/   # *ParityTests.swift against test_refs/
```
