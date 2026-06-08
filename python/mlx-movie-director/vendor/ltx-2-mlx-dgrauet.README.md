# ltx-2-mlx-dgrauet — vendored submodule (read-only reference)

Source: https://github.com/dgrauet/ltx-2-mlx
Pinned to: `v0.14.9`
Used by: `app/ltx_pipeline.py` (video pipeline)

> **Note:** This is a **read-only reference copy**. The active submodule used by the pipeline is [`vendor/ltx-2-mlx/`](ltx-2-mlx/) (same upstream repo, pinned to the same or newer version). This copy exists for easy cross-referencing and diffing without touching the active submodule.

---

## Why Two Copies?

| Submodule | Purpose | Status |
|-----------|---------|--------|
| [`vendor/ltx-2-mlx/`](ltx-2-mlx/) | **Active** — imported by `app/ltx_pipeline.py` at runtime | Production, receives vendor patches |
| [`vendor/ltx-2-mlx-dgrauet/`](ltx-2-mlx-dgrauet/) | **Reference** — pinned snapshot for comparison/auditing | Read-only |

---

## Relationship to Acelogic Fork

The [Acelogic fork](ltx-2-mlx-acelogic/) (`vendor/ltx-2-mlx-acelogic/`) is an independent rewrite with a custom native MLX Gemma 3 text encoder. Key differences:

| Aspect | dgrauet/ltx-2-mlx (this repo) | Acelogic/LTX-2-MLX |
|--------|-------------------------------|---------------------|
| Text encoder | Uses **mlx-lm** (shared library) | Custom native MLX Gemma 3 |
| Audio pipeline | Full T2V/I2V/A2V with joint audio | Same architecture, different impl |
| Package structure | Monorepo (`packages/ltx-pipelines-mlx/`, `packages/ltx-core-mlx/`) | Single package (`LTX_2_MLX/`) |
| Audio issues | Tracked in upstream issues #36, #37 | Documented in [`AUDIO_ISSUES.md`](ltx-2-mlx-acelogic/AUDIO_ISSUES.md) |

See [`docs/ltx-voice.md`](../docs/ltx-voice.md) for a full comparison of text encoder diagnostics and why the Acelogic fixes are not needed for our pipeline.

---

## Cross-References

- [`vendor/ltx-2-mlx.README.md`](ltx-2-mlx.README.md) — Setup, model layout, and import instructions for the active submodule
- [`vendor/ltx-2-mlx-acelogic.README.md`](ltx-2-mlx-acelogic.README.md) — Acelogic fork notes
- [`vendor/mflux.README.md`](mflux.README.md) — mflux submodule notes
- [`docs/ltx-pipeline.md`](../docs/ltx-pipeline.md) — Pipeline architecture, CLI reference, vendor patches
- [`docs/ltx-voice.md`](../docs/ltx-voice.md) — Audio investigation, A/B tests, Acelogic comparison
