# common-image-director

Shared, model-AGNOSTIC infrastructure for this repo's image/video-director
Swift packages (`z-image-director`, `flux2-image-director`,
`krea2-image-director`, `ltx-video-director`). A library only — no CLI
executable, no `Tests/` target of its own; each consuming package tests these
primitives indirectly through its own suite.

Model-SPECIFIC code (transformer architectures, VAE per architecture, LoRA
loading, ControlNet) lives in each app's own package, **not** here — only add
something to this package if two or more sibling apps need the identical
logic.

## What's in here

| File | Purpose |
|---|---|
| `Config.swift` | Shared config plumbing. |
| `ESRGAN.swift` | ESRGAN-style pixel-space upscaler. |
| `ImageGate.swift` | Native (VLM-free) image quality gateway — noise/blank/artifact checks. |
| `ImageSave.swift` | PNG save helpers (CoreGraphics/ImageIO). |
| `Manifest.swift` | `.manifest.json` sidecar read/write — the run-metadata convention consuming CLIs use. |
| `OutputPaths.swift` | Shared output-directory resolution (mirrors `run.py`'s externalized-output-dir convention). |
| `QualityMetrics.swift` | Numeric image metrics (used by `ImageGate` and the quality CLIs). |
| `Resolution.swift` | Resolution presets / snapping helpers. |
| `RunConfig.swift` | Run-config persistence. |
| `Scheduler.swift` | FlowMatch-Euler scheduler — shared by Z-Image and Flux2 Klein (both rectified-flow models). |
| `VAEPrimitives.swift` | Small VAE building blocks reused across per-model VAE ports. |

## Build

```bash
cd swift/common-image-director
swift build
```

There's nothing to run directly — build it as a dependency check; real
coverage comes from the consuming packages' test suites (e.g.
`cd swift/z-image-director && swift test`).

## Requirements

- Swift 6.0+, macOS 15+ (Apple Silicon)
- `mlx-swift` (pinned to the same version as every sibling package, so the
  whole `swift/` tree resolves to one shared dependency graph).
