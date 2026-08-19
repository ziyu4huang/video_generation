# Vendor bump: ltx-2-mlx v0.14.9 → v0.14.15 (2026-07-09)

Bumped the vendored `ltx-2-mlx` MLX port from **v0.14.9 (`2678f49`)** to
**v0.14.15 (`755c3b5`)** — 18 upstream commits. The bump was a force
multiplier: three of those commits are the *official* upstream fixes for
things this repo previously hand-patched (Patches 1, 2, 4, 6b), so the bump
retired four monkey-patches instead of adding any.

## What was moved

- **Vendor tree** (imported at runtime via `app/ltx_pipeline.py` sys.path
  insert): `python/mlx-movie-director/vendor/ltx-2-mlx/` → `755c3b5`.
  This tree is **gitignored** (`.gitignore:52`), NOT a superproject
  submodule — it is not tracked in the repo, so the pin is recorded here and
  in `vendor_patches.py`'s module docstring.
- **Sibling clone** `../ltx-2-mlx` (used by `scripts/setup-repo-deps.sh` for
  the editable install on fresh clones): `main` fast-forwarded to `755c3b5`.
  Kept consistent with the vendor tree so a fresh `setup-repo-deps.sh` does
  not silently reintroduce v0.14.9.

The venv imports the **vendor tree** (`.../vendor/ltx-2-mlx/packages/*/src`
via `sys.path.insert` in `ltx_pipeline.py:35-38`), confirmed at runtime.

## Patches retired (upstream now owns these)

| patch | function | upstream fix | why retired |
|---|---|---|---|
| 1 | `_patch_upsample1d` | #34/#38 (`7a26987`) | Upstream applies the identical strided-assignment dodge for the mlx-0.31.2 Metal scatter bug at `vocoder.py:129`. Our patch replaced the whole `__call__` with an equivalent copy — pure redundancy + stale-copy risk. |
| 2 | `_patch_hann_sinc_resampler` | #34/#38 (`7a26987`) | Same fix at `bwe.py:99`. |
| 4 | `_patch_ltx_model_config` | #39 (`59a42d7`) | Upstream adds `LTXModelConfig.from_checkpoint_config` **and** `from_checkpoint_dir`. Upstream's `from_checkpoint_config` is a **strict superset** — it also maps `video_dim`/`audio_dim`/`av_cross_num_heads`/`av_cross_head_dim`, which our subset omitted. Keeping Patch 4 would have **overridden upstream's richer version and regressed those field mappings** (a latent bug an import test cannot catch). |
| 6b | `_patch_a2v_image_conditioning` | #56 (`cc0cacc`) | Upstream forwards `frame_rate` to `combined_image_conditionings` at both the `a2vid_two_stage.py` (:213, :293) **and** `lipdub.py` (:198, :282) call sites — the official fix for the `TypeError` this defensive callee-patch guarded (originally added as Patch 6b in #365). |

## Patch adjusted (kept, but simplified onto upstream)

- **Patch 5** (`_patch_orchestration`) — still required for the **bespoke
  `LTX_DEV_AUDIO` audio-stream transplant** that upstream has no equivalent
  for. Its hand-rolled `_load_transformer_config` (which re-read
  `embedded_config.json` and called the now-retired Patch 4
  `from_checkpoint_config`) was replaced with a direct call to upstream's
  `LTXModelConfig.from_checkpoint_dir(...)`. This drops the divergence, picks
  up upstream's `config.json` fallback, and uses upstream's richer field
  mapping. The `_orch._load_transformer_config` module assignment was removed
  (nothing else referenced it).

## Patches kept unchanged (bespoke / no upstream equivalent)

- **3** `_patch_audio_vae_decoder` — causal frame crop (`T*4-3`). `audio_vae.py`
  was untouched in the 18 commits; upstream `decode` still has no crop.
- **6** `_patch_ti2vid` — `audio_stage1_only` capture param.
- **10** `_patch_int8_lora` — int8 distilled-LoRA dequantize before fusion.
  Consistent with upstream #52/#53's `LTXV_LORA_BLOCK_PREFIX` = `transformer_blocks.`
  (the streaming `_DictBlockLoraSource` already used that prefix).
- **11** `_patch_connector_apply_quantization` — int4/g32 connector quant.
- **7, 8, 9, 12** — the four **mflux** patches; unaffected by an ltx-2-mlx bump.

Patch count: **13 (9 ltx + 4 mflux) → 9 (5 ltx + 4 mflux)**.

## Verification

- **Unit suite green**: `pytest python/mlx-movie-director/app/tests` →
  **1184 passed, 33 skipped** (skips are GPU/weights-absent guards, unchanged).
- **All 9 remaining patches apply cleanly** on the bumped tree (import of
  `app.ltx_pipeline` prints `Applied 9 patches (5 ltx-2-mlx + 4 mflux)`).
- **Upstream `from_checkpoint_dir` present** and used by Patch 5.
- **IA2V talking-portrait path re-certified end-to-end** (the capability
  #365 certified — the exact `combined_image_conditionings` family that #56
  fixed): `run.py video generate --input-image <z-image portrait> --audio
  <say-synthesized 6.3s speech> --width 512 --height 512 --frames 49`.
  Completed with no `TypeError`/crash; exercised stage-1 dev (20 steps) +
  stage-2 distilled int8-LoRA (Patch 10) + audio VAE decode (Patch 3).
  `ffprobe`: **h264 512×512 2.04s video + aac 2.04s audio, matched-duration
  streams** — a valid talking-portrait clip.

## Notes for the next session

- The **audio-shorter-than-video crash** (`ValueError:
  [broadcast_shapes]` in `rope.py` when a 1.85s clip drove a 2.0s video) is a
  **shape** error, not the mux truncation upstream #58 (`d9f566a`) addresses —
  #58 drops the `-shortest` ffmpeg flag in the *mux*, a different stage. The
  bump does not obviously resolve the shape crash; the IA2V verification above
  deliberately used audio **longer** than the video (the known-good
  direction). Re-testing the shorter-audio case against the bumped `rope.py`
  is still open.
- **LipDub is now safe to wire** on this tree: `lipdub.py` already forwards
  `frame_rate` (:198, :282) after #56, so wiring `LipDubPipeline` will not
  re-hit the frame_rate bug class. `LipDubPipeline(ICLoraPipeline)` needs
  exactly one lip-dub IC-LoRA; `generate_and_save(prompt, output_path,
  reference_video_path, height, width, reference_strength, images, seed,
  stage1_steps, stage2_steps)` takes a **reference video** (supplies both
  visual structure via IC-LoRA and source audio via VAE-encode) and returns a
  **3-tuple** `(video_latent, audio_latent, frame_rate)` — note the extra
  element vs the a2vid path when wiring.
  - **WIRED 2026-07-09** (the HF gate was accepted by the user mid-session, so
    the checkpoint downloaded and LipDub was wired + verified on this bumped
    tree). New `video lipdub` sub-action; runs end-to-end and produces valid
    talking-head clips. The first before/after `lipsync_metrics.py`
    measurement showed **no** clear frame-level improvement over IA2V (full
    history: `docs/openmontage-capability-matrix.md` `lip_sync` row).
- **`bd2217a` (#45) multi-anchor I2V** is now in the tree: the CLI
  `_legacy_single_image()` guard is gone, so repeatable `--image PATH
  FRAME_IDX STRENGTH` multi-anchor I2V works on `--one-stage`/`--distilled`
  natively.
