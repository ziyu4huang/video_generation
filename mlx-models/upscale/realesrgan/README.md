# Real-ESRGAN Vendor Location (offline face-restore)

This directory holds the vendored `RealESRGAN_x4plus.pth` background-upsampler
weight used by `image facerestore --bg-upsampler`.

## Why here

`face_restore_bridge.py` runs in `python/face-venv` (a torch venv with **no**
`app.` imports). Under `--offline` it must NEVER reach GitHub at runtime, so it
resolves the weight from, in order:

1. `<weights-dir>/RealESRGAN_x4plus.pth` (the legacy `gfpgan/weights/` dir).
2. **This directory** (`mlx-models/upscale/realesrgan/`), passed via the
   `FACE_RESTORE_EXTRA_WEIGHTS_DIRS` env var by `image-facerestore.py`.
3. If still missing and `FACE_RESTORE_OFFLINE=1` → **fail loud** (never download).
4. If still missing and online → legacy GitHub-release download.

## Populate it (ONLINE, once)

```bash
# Run while you still have network; then generation is fully offline.
curl -L -o mlx-models/upscale/realesrgan/RealESRGAN_x4plus.pth \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
```

After this, `image facerestore --bg-upsampler --offline` resolves the weight
locally with zero egress.

> Note: the file is gitignored (it lives in the externalized `mlx-models/` store,
> same convention as all model binaries). It must be present on each machine.
