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
```

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
