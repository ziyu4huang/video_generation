# Z-Image Turbo Fun ControlNet Union 2.1 Lite (2602-8steps)

Union-style ControlNet for ZImage-Turbo supporting multiple control types via a
4-dimensional type indicator.

## Architecture

- **5 control layers** + 2 refiner blocks (Lite version; full has 15+2)
- Residual injection into main ZImage transformer at stride-2
- 132-dim input: 64 noise + 64 control + 4 union type

## Supported Control Types

| Index | Type       | Description          |
|-------|------------|----------------------|
| 0     | Canny      | Edge detection       |
| 1     | Depth      | Depth map            |
| 2     | Pose       | Pose estimation      |
| 3     | HED        | Holistically-nested  |
| 4     | Scribble   | Freehand sketch      |
| 5     | Gray       | Grayscale control    |

## Inference

- **8 steps** distilled (vs 20+ for full model)
- Optimal `control_context_scale`: 0.65–1.00
- Recommended resolution: 512–1536px

## Source

- HuggingFace: <https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1>
- Developer: Alibaba PAI team
- File: `Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors`

## Changelog (vs v2.0)

- Fixed double-forward-pass bug (v2.0 typo causing 2× slowdown)
- Added scribble and gray control types (2602 variant)
- 8-step distillation for faster inference
- Lite version: 5 control layers instead of 15, ~1.9 GB vs ~5.3 GB
