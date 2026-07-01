# `models/upscale/4x-nomos-webphoto-realplksr/` — 4xNomosWebPhoto (RealPLKSR)

The default ESRGAN/Real-PLKSR upscale model. 4× super-resolution tuned for
web/photo content. Used by `ZImagePipeline.upscale_esrgan` whenever `--upscale` is
set without an explicit `--upscale-model`.

## Required file

```
models/upscale/4x-nomos-webphoto-realplksr/4xNomosWebPhoto_RealPLKSR.pth
```

Filename **must** be exactly `4xNomosWebPhoto_RealPLKSR.pth` — `app.config.DEFAULT_UPSCALE_MODEL`
resolves to this path.

## Source

Download from the openmodeldb / GitHub release (search "4xNomosWebPhoto_RealPLKSR").
Place the `.pth` here. Override at runtime with `--upscale-model <path>`.
