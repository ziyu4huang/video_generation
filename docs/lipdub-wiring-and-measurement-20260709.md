# LipDub IC-LoRA wired into run.py + first precision measurement (2026-07-09)

Wired the vendored `LipDubPipeline` into run.py as a new `video lipdub`
sub-action, on the freshly-bumped ltx-2-mlx v0.14.15 tree (see
`docs/ltx-2-mlx-vendor-bump-v0.14.15-20260709.md`). LipDub is the reference-
video lip-dubbing path (two-stage IC-LoRA + VAE-encoded reference audio) —
the intended precision upgrade over the coarse IA2V (`video generate
--input-image X --audio Y`) talking-portrait path measured in
`docs/lipsync-precision-measurement-20260708.md`.

## What was wired

- **Checkpoint** (HF-gated — license accepted 2026-07-09):
  `Lightricks/LTX-2.3-22b-IC-LoRA-LipDub` /
  `ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors` (2.47 GB). Externalized like
  every other model binary: the 2.3 GB file lives in the external store
  (`../video_generation__models/<md5>.safetensors`), the repo carries only a
  git-tracked **symlink** at `mlx-models/lora/ltx-2-3-lipdub/`, and the entry
  is registered in `mlx-models/store-manifest.json`
  (md5 `ecc629668da1222455718ac1e24508fb`, 2466665072 bytes). No raw
  safetensors enters git.
- **`LTXVideoPipeline.generate_lipdub()`** (`app/ltx_pipeline.py`) — mirrors
  `generate_ic_lora()`; constructs the vendor `LipDubPipeline` (one lip-dub
  IC-LoRA) and calls its `generate_and_save(reference_video_path, ...)`.
- **`video lipdub` sub-action** (`app/commands/video-lipdub.py` +
  registration in `video.py`) — flags `--lipdub-reference-video`,
  `--lipdub-lora` (auto-detected from `mlx-models/lora/*lipdub*`),
  `--reference-strength`. Follows the `video vbvr` sub-action shape.

### Two integration gotchas (fixed)

1. **Distilled variant, not `distilled=True`.** LipDub's `ICLoraPipeline`
   base resolves its transformer via `transformer-distilled*.safetensors`,
   which only the DISTILLED flat assembly dir carries
   (`mlx-models/ltx-mlx/distilled/transformer-distilled-1.1.safetensors`).
   `LTXVideoPipeline(distilled=True)` yields the DEV assembly dir
   (`transformer-dev.safetensors` + runtime LoRA fusion) and the IC-LoRA
   loader can't find its weights. Construct with `transformer="distilled"`.
2. **`lora_path`/`lora_scale` must be LISTS for `RunConfig.from_args`.** The
   video CLI registers `--lora-path`/`--lora-scale` as scalars, but
   `RunConfig.from_args` resolves them via `resolve_lora_paths()` (the
   action="append" multi-LoRA contract). A bare string is iterated
   character-by-character (each char fuzzy-resolved as a LoRA name). Set
   `args.lora_path = [path]`, `args.lora_scale = [scale]`.

## Verification (end-to-end, valid clip)

`video lipdub --lipdub-reference-video <IA2V talking-portrait clip>
--prompt "..." --width 512 --height 512 --seed 42` ran end-to-end in ~160 s:
distilled stage-1 (8 steps) + stage-2 (3 steps) + audio-VAE decode + mux.
Output: h264 512×512 49-frame + aac, and the mid-frame is a coherent,
high-quality talking-head with consistent identity — the pipeline is
genuinely functional, not a stub.

## First precision measurement — HONEST result: no clear frame-level win

Ran this lineage's `app/lipsync_metrics.py` (mouth-open-ratio ↔ audio-RMS
envelope, lagged Pearson) on the same reference clip before vs after LipDub:

| clip | lag0_pearson_r | best-lag r | verdict* |
|---|---|---|---|
| BEFORE — plain IA2V talking-portrait | **+0.1334** | −0.2826 (lag +4) | inadequate |
| AFTER  — LipDub IC-LoRA              | **−0.0814** | −0.4377 (lag −4) | "adequate"* |

*The `verdict` keys off the best-lag |r|, but both hit the ±4 search
boundary — the metric's own caveat says to distrust best-lag on short clips
and treat **lag0_pearson_r** as the trustworthy statistic.

**Conclusion (do not overclaim):** on this test the trustworthy lag0
correlation did **not** improve — it moved from +0.13 to −0.08, i.e. both
clips sit near the noise floor with no meaningful frame-level mouth↔audio
correlation. LipDub is now wired and produces valid talking-head clips, but
this first measurement does **not** demonstrate a lip-sync precision gain
over IA2V.

Likely reasons (any/all), to disentangle next:
- **Weak test.** 49 frames / 2.0 s is a very short correlation sample; the
  reference was itself a *synthetic* IA2V clip whose audio is `say`-generated
  speech with limited envelope structure. A real talking-head reference with
  clear, dynamic speech is the proper input.
- **Coarse metric.** `lipsync_metrics.py` correlates opening *amount* vs RMS,
  not phoneme→viseme shape (documented limitation in the 2026-07-08 note). A
  viseme classifier would be a stricter test — and is the real bar for a
  "precision" claim.
- **Possible MLX-port issue.** The goal file anticipated the wiring might
  "reveal an MLX-port bug." Not confirmed either way here — the output is
  visually valid, so any issue would be subtle (e.g. audio-reference latent
  alignment), not a hard failure. Patch via `vendor_patches.py` if found,
  never edit the submodule.

**Next step:** re-measure with a real talking-head reference video + clear
speech, and ideally a phoneme-viseme metric, before making any
`lip_sync` precision claim in the capability matrix.
