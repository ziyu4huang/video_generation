# image-gen-utils

Shared Swift utilities for image-generation **directors** — the LM-Studio VLM
caption / score / review integration, extracted from `z-image-director` so that
every director (`z-image-director` today, `flux2-image-director` next, others
later) reuses **one** Qwen3-VL / Gemma-4 client instead of duplicating it.

Pure **Foundation + CoreGraphics** — no MLX dependency, so it builds in seconds
and imports cheaply into any image-gen tool.

## What it provides

| Type | Purpose |
|------|---------|
| `CaptionClient` | High-level VLM client: `caption()`, `score()`, `callVLM()` |
| `CaptionScore` | Parsed quality-score payload + `passes(threshold:)` |
| `CaptionScoreParser` | Robust JSON extraction (handles ```json fences, prose prefix, numeric strings) |
| `StylePrompts` + `CaptionStyle` | The style → prompt registry (verbatim port of `run.py caption` `_STYLE_PROMPTS` + `_DEFECT_BLOCK`) |
| `ImageEncoder` | Image → downscale ≤1024px → JPEG q85 → base64 |
| `CaptionError` | Typed errors (unreadable / encode / connection / http / bad-response) |

## Configuration

Defaults resolve in this order: **explicit arg → env var → baked default**.

| Setting | Env var | Default |
|---------|---------|---------|
| LM Studio API base | `LMSTUDIO_API_URL` | `http://localhost:1234/v1` |
| VLM model id | `LMSTUDIO_MODEL` | `qwen/qwen3-vl-4b` |

## Styles (mirror `run.py caption --style`)

`default` · `photography` · `t2i` · `score` (JSON) · `review` (JSON, needs the
original T2I prompt for element-level adherence check). Unknown strings are
treated as literal free-form prompts.

The `score` and `review` styles ship a deliberately **adversarial** defect-check
block (plasticky skin, hand/finger count, face symmetry, background melting) so
the VLM hunts for flaws instead of over-praising polished-looking outputs. This
block is ported byte-for-byte from `python/mlx-movie-director/app/commands/caption.py`
to keep scores comparable across the Python and Swift directors.

## CLI

`image-gen-utils` is also a standalone executable — usable from shell scripts
without spawning a full image-gen pipeline:

```bash
swift run image-gen-utils caption photo.jpg --style photography
swift run image-gen-utils score  photo.jpg --threshold 7 --check   # CI gate
swift run image-gen-utils review photo.jpg --prompt "a woman in a garden"
swift run image-gen-utils styles                                    # list styles
```

## Usage from another Swift package

```swift
// Package.swift
.package(path: "../image-gen-utils"),
// target deps
.product(name: "ImageGenUtils", package: "image-gen-utils"),
```

```swift
import ImageGenUtils

let raw = try CaptionClient.caption(imageURL: url, style: "score")
let score = CaptionScoreParser.parse(raw)
if score?.passes(threshold: 7) == false { /* retry with more steps */ }
```

`z-image-director` consumes it exactly this way (see
`swift/z-image-director/Sources/ZImageDirectorCLI/T2ICommand.swift` — the
`--self-critique` retry loop).

## Parity with Python

This package is the Swift counterpart of `python/mlx-movie-director/app/commands/caption.py`.
The prompt strings and JSON schema are kept identical so a given image scores
the same whether reviewed by `run.py caption`, `zimage caption`, or
`image-gen-utils score`.
