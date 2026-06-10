# Movie Director

A web-based GUI for AI-powered image generation and editing on Apple Silicon.

Built with **Bun** + **React** on the frontend, **Python** + **MLX/PyTorch** on the backend. All inference runs locally on your Mac's GPU.

---

## What It Does

12 AI image commands organized into 5 categories, with a real-time web interface:

| Category | Commands | What it does |
|----------|----------|-------------|
| **Generate** | Text → Image, Workflow | Create images from text prompts using ZImage Turbo or Flux2 Klein 9B |
| **Transform** | Image → Image, Anime → Real, Expansion | Modify existing images: style transfer, anime conversion, outpainting |
| **Edit** | Face Swap, Region Swap, ControlNet, Camera Angle | Surgical edits: swap faces/regions, edge/pose control, change viewpoint |
| **Analyze** | Character Profile, Quality | Generate multi-view character sheets, score image quality via VLM |
| **Tools** | Model Check | Validate model integrity and availability |

Every command shows a dynamic form, streams real-time logs via WebSocket, and saves results to a browsable gallery with full metadata.

---

## Quick Start

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Install frontend dependencies

```bash
cd bun/gui-movie-director
bun install
```

### 3. Set up Python environment

```bash
cd ../..                          # back to repo root
python3.13 -m venv python/venv
python/venv/bin/pip install -r python/mlx-movie-director/requirements.txt
```

### 4. Start the app

```bash
cd bun/gui-movie-director
bun run dev
```

Open **http://localhost:3099** in your browser.

### 5. Verify setup

- Click **Config** in the sidebar
- Click **Verify** next to the Python path — should show `mlx.core OK`
- (Optional) If you have [LM Studio](https://lmstudio.ai/) running with Qwen3-VL 4B, click **Test Connection** under VLM

### 6. Generate your first image

- Click **Text → Image** in the sidebar
- Type a prompt, e.g. `A moody cinematic portrait of a woman in rain`
- Click **Generate**
- Watch real-time logs stream in, then see the result appear in the Gallery

---

## Commands

### Generate

| Command | Description | Key Options |
|---------|-------------|-------------|
| **Text → Image** | Generate images from text prompts | Pipeline (ZImage Turbo / Flux2 Klein 9B), size, steps, seed, LoRA scale, draft mode, ESRGAN 4× upscale |
| **Workflow** | Multi-stage pipeline: generate → face detail → film grain → sharpen → upscale | Same as T2I plus face detailer, film grain, sharpening, ESRGAN upscale |

### Transform

| Command | Description | Key Options |
|---------|-------------|-------------|
| **Image → Image** | Modify an existing image using text guidance + optional ControlNet reference | Denoise strength, ControlNet strength, pipeline |
| **Anime → Real** | Convert anime artwork to photorealistic style | Realism style (4 presets), LoRA scale, reference strength, reference count |
| **Expansion** | Outpainting — extend image borders with AI-generated content | Direction or aspect-ratio mode, pixels per direction, feather, overlap |

### Edit

| Command | Description | Key Options |
|---------|-------------|-------------|
| **Face Swap** | Swap a face or head from one image onto another body | Head vs face mode, seed |
| **Region Swap** | Use SAM3 text-prompted segmentation to swap regions between images | SAM prompt (text-based), threshold, feather, blend |
| **ControlNet** | Generate images guided by edge/pose/depth maps | Canny, OpenPose, Depth, HED, Scribble, Gray; strength, blur, remove outlines |
| **Camera Angle** | Change the viewing angle of an existing image | Azimuth (−180 to 180), elevation (−90 to 90), prompt |

### Analyze

| Command | Description | Key Options |
|---------|-------------|-------------|
| **Character Profile** | Generate multi-view character sheets (front/back/side) | Views, standing/sitting pose, reference count |
| **Quality** | Score images on quality dimensions using a VLM | Multiple images, requires LM Studio + Qwen3-VL 4B |

### Tools

| Command | Description |
|---------|-------------|
| **Model Check** | Validate model file integrity and availability |

---

## How It Works

```
Browser (React SPA, :3099)
  │
  │  REST API  /api/run  /api/gallery  /api/jobs  ...
  │  WebSocket /ws  — real-time job logs + status
  │
Bun Server (server.ts)
  │
  │  subprocess spawn
  │  python/venv/bin/python run.py image <action> [args]
  │
Python Backend (mlx-movie-director)
  │
  │  MLX / PyTorch MPS
  │
Apple Silicon GPU
```

- **Frontend**: React 19 SPA bundled in-memory by Bun at startup — no separate build step
- **Backend**: Bun server spawns a Python subprocess for each job, streams stdout/stderr back via WebSocket
- **Gallery**: Output images served from `python/mlx-movie-director/output/` with sidecar manifest and run config metadata

---

## Configuration

Click **Config** in the sidebar, or edit `bun/gui-movie-director/config.json`:

```json
{
  "outputDir": "python/mlx-movie-director/output",
  "modelsDir": "python/mlx-movie-director/models",
  "vlmApiUrl": "http://localhost:1234/v1",
  "vlmModel": "qwen/qwen3-vl-4b"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `outputDir` | `python/mlx-movie-director/output` | Where generated images are saved |
| `modelsDir` | `python/mlx-movie-director/models` | Where model weights are stored |
| `vlmApiUrl` | `http://localhost:1234/v1` | LM Studio API for VLM features (Quality, Caption) |
| `vlmModel` | `qwen/qwen3-vl-4b` | Model name in LM Studio |
| `pythonPath` | `python/venv/bin/python` | Absolute path to the Python binary |

---

## Requirements

| Requirement | Details |
|-------------|---------|
| **Hardware** | Apple Silicon Mac (M1/M2/M3/M4) — uses MPS GPU backend |
| **Bun** | v1.0+ runtime for the frontend server |
| **Python** | 3.13 venv at `python/venv/` with MLX, PyTorch, Transformers |
| **Model Weights** | ~30 GB minimum for image generation (varies by pipeline) |
| **LM Studio** | Optional — needed for Quality Analysis and Caption features |

---

## Project Structure

```
bun/gui-movie-director/          # Frontend + Bun server
  server.ts                      # Entry point — Bun.serve on port 3099
  config.json                    # Runtime configuration
  api/                           # REST API routes + WebSocket handler
  lib/                           # Subprocess manager, config, schemas, paths
  frontend/                      # React 19 SPA
    app.tsx                      # Root component, command group definitions
    schemas/index.ts             # Form schemas for all 12 commands
    components/                  # Layout, CommandForm, Gallery, LogViewer, ...
    views/                       # Per-command views (generate/, transform/, edit/, analyze/)

python/mlx-movie-director/       # Python backend
  run.py                         # CLI entry point (subcommands: t2i, image, upscale, ...)
  app/commands/                  # Command modules (image-t2i, image-faceswap, ...)
  output/                        # Generated images + metadata (gitignored)
  models/                        # Model weights (gitignored)
```

---

## Development

```bash
# Watch mode (auto-restarts Bun server on file changes)
cd bun/gui-movie-director && bun run dev

# Production mode
cd bun/gui-movie-director && bun run start
```

The frontend is bundled in-memory by Bun at server startup — no separate build step. Edit `frontend/` files and the server will hot-reload in dev mode.

For ComfyUI setup, model management, FP8 patches, and Apple Silicon compatibility notes, see [CLAUDE.md](CLAUDE.md).
