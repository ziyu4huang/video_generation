# ltx-2-mlx-acelogic — vendored submodule (reference)

Source: https://github.com/Acelogic/LTX-2-MLX
Pinned to: `heads/main`
Used by: **Not imported at runtime** — reference only for investigation and cross-comparison

---

## Why Vendored?

The Acelogic fork is included as a **reference for audio/video debugging**. It is not imported or used by the pipeline at runtime. The main reasons it's vendored:

1. **Text encoder comparison** — Acelogic wrote a custom native MLX Gemma 3 implementation with per-layer RoPE fixes. Our pipeline uses mlx-lm which already handles this correctly (diagnostic: cosine sim 0.964–0.999). See [`docs/ltx-voice.md`](../docs/ltx-voice.md) §5 for details.

2. **[`AUDIO_ISSUES.md`](ltx-2-mlx-acelogic/AUDIO_ISSUES.md)** — Comprehensive debugging log covering:
   - §7: Confirmed text encoder is NOT the bottleneck (exported ComfyUI embeddings → MLX still garbled)
   - AV cross-attention scale bug (same as our upstream [#37](https://github.com/dgrauet/ltx-2-mlx/issues/37))
   - Duration-dependent amplitude bug (5s loud, 10s 5× quieter)
   - Layer-by-layer MLX vs PyTorch numerical divergence analysis

3. **Implementation reference** — Different approach to the same MLX port problems, useful for understanding alternative solutions.

---

## Key Differences from dgrauet/ltx-2-mlx

| Aspect | dgrauet/ltx-2-mlx | Acelogic/LTX-2-MLX (this) |
|--------|-------------------|----------------------------|
| Text encoder | Uses **mlx-lm** (shared library) | Custom native MLX Gemma 3 implementation |
| Gemma RoPE | Handled by mlx-lm (correct out of box) | Required manual fix: 40 sliding + 8 full layers with different theta |
| Connector registers | REPLACE mode (256 tokens) | APPEND mode (1024 tokens) |
| Package structure | Monorepo: `packages/ltx-pipelines-mlx/`, `packages/ltx-core-mlx/` | Single package: `LTX_2_MLX/` |
| Runtime usage | **Active** — imported by our pipeline | **Reference only** |

---

## Acelogic Text Encoder Fixes — NOT NEEDED ✅

The Acelogic fork identified and fixed four text encoder issues in their custom Gemma 3 implementation. Our pipeline does **not** need these fixes because it uses **mlx-lm**:

| # | Fix | Why Acelogic needed it | Why we don't |
|---|-----|----------------------|--------------|
| 1 | Gemma per-layer RoPE (40 sliding + 8 full layers) | Wrote Gemma from scratch, got it wrong | mlx-lm `gemma3_text.Attention` handles `is_sliding` per layer correctly |
| 2 | Boolean attention masks | Custom impl used float masks | mlx-lm handles masks internally |
| 3 | Connector register append (1024) | Their impl replaced padding | Different behavior; Acelogic confirmed "didn't fix speech quality" |
| 4 | Double-precision RoPE for connector | Float32 vs float64 precision | Not applied; Acelogic confirmed "didn't fix speech quality" |

**Key evidence from Acelogic (AUDIO_ISSUES.md §7):**
> "Exported ComfyUI text embeddings → fed to MLX pipeline → still no clear speech"

This proves the remaining issues are in the **48-layer diffusion transformer**, not the text encoder. See [`docs/ltx-voice.md`](../docs/ltx-voice.md) for full investigation details.

---

## Cross-References

- [`vendor/ltx-2-mlx.README.md`](ltx-2-mlx.README.md) — Setup and model layout for the active pipeline submodule
- [`vendor/ltx-2-mlx-dgrauet.README.md`](ltx-2-mlx-dgrauet.README.md) — dgrauet submodule reference copy
- [`vendor/mflux.README.md`](mflux.README.md) — mflux submodule notes
- [`docs/ltx-pipeline.md`](../docs/ltx-pipeline.md) — Pipeline architecture, vendor patches, known issues
- [`docs/ltx-voice.md`](../docs/ltx-voice.md) — Full audio investigation with Acelogic comparison
