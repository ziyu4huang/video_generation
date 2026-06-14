"""ltx_pipeline — LTX-2.3 22B video generation wrapper (ltx-2-mlx vendored submodule).

Model loading priority:
  1. Explicit model_dir (if provided)
  2. Local pre-downloaded components → symlink assembly into flat dir → ltx-2-mlx loads
  3. HF auto-download (fallback, downloads to ~/.cache/huggingface/)

Symlink assembly (symmetric with flux2_pipeline.py, but inverted):
  flux2: component dirs → symlink subdirs  → mflux sees root/{component}/ hierarchy
  ltx:   component dirs → symlink files    → ltx-2-mlx sees root/*.safetensors flat layout

The assembly dir must survive for the pipeline's entire lifetime (block-streaming mode
memory-maps weights lazily from disk), so cleanup is deferred to __del__ / close().
"""

import os
import shutil
import sys
import tempfile
import time

from app import config as cfg


# ---------------------------------------------------------------------------
# Ensure ltx-2-mlx sub-packages are importable (vendored submodule at vendor/ltx-2-mlx/)
# ---------------------------------------------------------------------------

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_VENDOR_BASE = os.path.join(_APP_DIR, "vendor", "ltx-2-mlx")
for _pkg in ("packages/ltx-core-mlx", "packages/ltx-pipelines-mlx"):
    _src = os.path.join(_VENDOR_BASE, _pkg, "src")
    if os.path.isdir(_src) and _src not in sys.path:
        sys.path.insert(0, _src)

# mflux vendor package (needed by vendor_patches + pipeline.py)
_mflux_src = os.path.join(_APP_DIR, "vendor", "mflux", "src")
if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
    sys.path.insert(0, _mflux_src)

# Apply vendor monkey-patches before any vendor classes are instantiated.
import app.vendor_patches  # noqa: F401

from app.ltx_variants import COMMON_COMPONENTS, LTX_VARIANTS, get_variant

# ---------------------------------------------------------------------------
# MultiModalGuiderParams defaults (shared by generate() and generate_flf2v())
# ---------------------------------------------------------------------------
_GUIDER_RESCALE_SCALE = 0.7
_GUIDER_MODALITY_SCALE = 3.0
_GUIDER_STG_BLOCKS = [28]
_FLF2V_AUDIO_CFG_SCALE = 7.0


# ---------------------------------------------------------------------------
# Component → file mapping for on-the-fly temp-dir assembly (fallback when a
# pre-built flat dir isn't ready). Derived from the variant registry so it stays
# in sync with app/ltx_variants.py. Per-variant required-file checks and
# pre-built-dir resolution live on the LTXVariant itself (see get_variant()).
# ---------------------------------------------------------------------------
_dev = LTX_VARIANTS["dev"]
_dis = LTX_VARIANTS["distilled"]
_LTX_COMPONENT_FILES: dict[str, list[str]] = {
    **COMMON_COMPONENTS,
    _dev.transformer_dir: [_dev.transformer_file, "split_model.json", "quantize_config.json"],
    _dis.transformer_dir: [_dis.transformer_file, "split_model.json", "quantize_config.json"],
}


def _local_components_ready(transformer: str = "dev") -> bool:
    files = get_variant(transformer).required_files
    return all(
        os.path.exists(os.path.join(d, f))
        for d, f in files
    )


def _check_flat_dir(target_dir: str, required_files: list[tuple[str, str]]) -> bool:
    """Check if a pre-built flat dir exists and has all required symlinks."""
    if not os.path.isdir(target_dir):
        return False
    for _src_dir, fname in required_files:
        link = os.path.join(target_dir, fname)
        if not os.path.islink(link) or not os.path.exists(link):
            return False
    return True


def _ensure_flat_dir(transformer: str = "dev") -> str:
    """Return a flat model dir, preferring pre-built symlinks over temp assembly.

    Pre-built dirs live at models/ltx-mlx/{dev,distilled,dasiwa}/ and are
    created by scripts/setup_ltx_symlinks.py.  If not found or invalid,
    falls back to on-the-fly temp assembly.
    """
    variant = get_variant(transformer)
    prebuilt = variant.flat_dir
    required = variant.required_files
    if _check_flat_dir(prebuilt, required):
        print(f"[LTXVideoPipeline] Using pre-built flat dir: {prebuilt}")
        return prebuilt
    print(f"[LTXVideoPipeline] Pre-built dir not ready ({prebuilt}), assembling on-the-fly…")
    return _assemble_flat_dir()


# ---------------------------------------------------------------------------
# Temporal upscale mixin
# ---------------------------------------------------------------------------

class _TemporalUpscaleMixin:
    """Mixin: apply temporal x2 upsampling after Stage 2, before VAE decode.

    Override generate_two_stage() via MRO so it works for both
    TI2VidTwoStagesPipeline and KeyframeInterpolationPipeline (which inherits
    from it). Result: F frames → 2F-1 frames in latent space.
    """

    _temporal_upsampler = None  # lazy-loaded per instance

    def _load_temporal_upsampler(self):
        from ltx_core_mlx.model.upsampler.model import LatentUpsampler
        from ltx_core_mlx.loader.sft_loader import load_split_safetensors
        import json

        model_dir = str(self.model_dir)
        name = "temporal_upscaler_x2_v1_0"
        config_path = os.path.join(model_dir, f"{name}_config.json")
        weights_path = os.path.join(model_dir, f"{name}.safetensors")

        if os.path.exists(config_path):
            with open(config_path) as f:
                config = json.load(f).get("config", {})
            upsampler = LatentUpsampler.from_config(config)
        else:
            upsampler = LatentUpsampler(temporal_upsample=True, spatial_upsample=False)

        if not os.path.exists(weights_path):
            raise FileNotFoundError(
                f"[TemporalUpscale] {name}.safetensors not found in {model_dir}. "
                "Run: python app/ltx_downloader.py"
            )
        raw = load_split_safetensors(weights_path)
        upsampler.load_weights(list(raw.items()))
        return upsampler

    def generate_two_stage(self, *args, **kwargs):
        import mlx.core as mx

        video_latent, audio_latent = super().generate_two_stage(*args, **kwargs)

        if self._temporal_upsampler is None:
            self._temporal_upsampler = self._load_temporal_upsampler()

        # denorm (BCFHW → BFHWC) → temporal x2 → renorm (→ BCFHW)
        video_mlx = video_latent.transpose(0, 2, 3, 4, 1)
        video_denorm = self.vae_encoder.denormalize_latent(video_mlx)
        video_denorm = video_denorm.transpose(0, 4, 1, 2, 3)

        video_temporal = self._temporal_upsampler(video_denorm)  # F → 2F-1
        mx.eval(video_temporal)

        video_mlx2 = video_temporal.transpose(0, 2, 3, 4, 1)
        video_renorm = self.vae_encoder.normalize_latent(video_mlx2)
        return video_renorm.transpose(0, 4, 1, 2, 3), audio_latent


def _assemble_flat_dir() -> str:
    """Create a temporary flat directory with symlinks to all component files.

    ltx-2-mlx expects all weights in a single directory (flat HF-repo layout).
    We assemble this from our decomposed models/{type}/{name}/ directories.
    Non-existent optional files (e.g. spatial_upscaler, quantize_config) are skipped.
    """
    tmp = tempfile.mkdtemp(prefix="ltx2_")
    for src_dir, filenames in _LTX_COMPONENT_FILES.items():
        for fname in filenames:
            src = os.path.join(src_dir, fname)
            dst = os.path.join(tmp, fname)
            if os.path.exists(src) and not os.path.exists(dst):
                os.symlink(src, dst)
    return tmp


class LTXVideoPipeline:
    """Thin wrapper around ltx-pipelines-mlx for LTX-2.3 22B video generation.

    Model: ltx-2.3-dev-q8 (MLX INT8 — not FP8; see models/transformer/ltx-2.3-dev-q8/quantize_config.json).
    All modes share transformer-dev.safetensors via _assemble_flat_dir() symlink assembly.

    Supports:
      T2V       — text-to-video (TI2VidTwoStagesPipeline)
      I2V       — image-to-video (same pipeline, pass image=path)
      A2V       — audio-to-video (A2VidPipelineTwoStage, pass audio_path=path)
      HQ        — higher-quality T2V/I2V (TI2VidTwoStagesHQPipeline, res_2s sampler; init with hq=True)
      Distilled — fast T2V/I2V (DistilledPipeline, 8 steps CFG=1 no STG; init with distilled=True)
      FLF2V     — first-last-frame interpolation (KeyframeInterpolationPipeline, call generate_flf2v();
                  dev transformer required — distilled model hallucinates during interpolation)
    """

    def __init__(
        self,
        model_dir: str | None = None,
        low_ram: bool = False,
        hq: bool = False,
        distilled: bool = False,
        transformer: str | None = None,
        temporal_upscale: bool = False,
        lora_path: str | None = None,
        lora_scale: float = 1.0,
    ):
        """
        Args:
            model_dir:       Local flat directory or HuggingFace repo ID.
                             None → auto-detect local components; fallback to HF auto-download.
            low_ram:         Block-streaming mode — ~75% lower peak Metal RAM, slower per step.
            hq:              Use HQ pipeline (res_2s second-order sampler) for higher quality.
            distilled:       Use distilled transformer (8 steps, CFG=1) for faster generation.
            temporal_upscale: After Stage 2, apply temporal x2 upsampling (F → 2F-1 frames).
                             Requires temporal_upscaler_x2_v1_0.safetensors to be downloaded.
            lora_path:       Optional user LoRA (.safetensors) for style/quality enhancement.
                             Fused into the dev transformer at load time via vendor _pending_loras.
            lora_scale:      LoRA fusion strength (default: 1.0).
        """
        # Resolve transformer variant via the registry (app/ltx_variants.py):
        # --transformer wins, else fall back to the --distilled flag. The variant
        # carries the pipeline branch (is_distilled) and the distilled-LoRA
        # fusion strength (bind-time 0.999 for dev/dasiwa, which ship no
        # pre-fused distilled file; 1.0 for distilled's separate DistilledPipeline).
        variant = get_variant(transformer, distilled)
        self.transformer = variant.key
        distilled = variant.is_distilled
        self._variant = variant
        self._distilled_lora_strength = variant.distilled_lora_strength

        self.low_ram = low_ram
        self.hq = hq
        self.distilled = distilled
        self.temporal_upscale = temporal_upscale
        self.lora_path = lora_path
        self.lora_scale = lora_scale
        self._assembly_dir: str | None = None
        self._pipeline = None
        self._pipeline_mode: str | None = None  # "t2v_i2v", "a2v", "flf2v", "distilled"
        self._pipeline_events: list[dict] = []  # runtime trace: model loads + LoRA apply (video)

        if model_dir:
            self._model_dir = model_dir
            print(f"[LTXVideoPipeline] Using explicit model_dir: {model_dir}")
        elif _local_components_ready(transformer=transformer):
            self._assembly_dir = _ensure_flat_dir(transformer=transformer)
            self._model_dir = self._assembly_dir
            mode_tag = " (distilled)" if distilled else (
                f" ({transformer})" if transformer != "dev" else ""
            )
            print(f"[LTXVideoPipeline] Using local pre-downloaded components{mode_tag}")
        else:
            if transformer == "dasiwa":
                # Don't silently fall back to the HF dev repo — that would
                # generate with the wrong (non-DaSiWa) weights.
                raise FileNotFoundError(
                    f"[LTXVideoPipeline] DaSiWa transformer not found at "
                    f"{cfg.LTX_DASIWA_TRANSFORMER_DIR}.\n"
                    f"  Convert it first:\n"
                    f"    python/venv/bin/python convert.py --ltx-checkpoint <dasiwa.safetensors>\n"
                    f"    python/venv/bin/python scripts/setup_ltx_symlinks.py --force"
                )
            self._model_dir = "dgrauet/ltx-2.3-mlx-q8"
            print(
                f"[LTXVideoPipeline] Local components not found — "
                f"HF auto-download: {self._model_dir}"
            )

    def _is_temp_dir(self) -> bool:
        """True if _assembly_dir is a temp dir (should be cleaned up on close)."""
        return bool(self._assembly_dir) and self._assembly_dir.startswith(tempfile.gettempdir())

    def __del__(self) -> None:
        if self._is_temp_dir() and os.path.isdir(self._assembly_dir):
            shutil.rmtree(self._assembly_dir, ignore_errors=True)

    def close(self) -> None:
        """Explicit cleanup — call before creating a new pipeline to free memory."""
        self._pipeline = None
        if self._is_temp_dir() and os.path.isdir(self._assembly_dir):
            shutil.rmtree(self._assembly_dir, ignore_errors=True)
            self._assembly_dir = None

    def generate(
        self,
        prompt: str,
        output_path: str,
        height: int = 480,
        width: int = 704,
        num_frames: int = 97,
        frame_rate: float = 24.0,
        seed: int = 42,
        stage1_steps: int | None = None,
        stage2_steps: int | None = None,
        cfg_scale: float = 5.0,
        stg_scale: float = 1.0,
        image: str | None = None,
        audio_path: str | None = None,
        audio_stage1_only: bool = False,
        audio_cfg_scale: float | None = None,
        enable_teacache: bool = False,
        teacache_thresh: float | None = None,
    ) -> dict:
        """Generate a video and write to output_path.

        cfg_scale controls TEXT guidance only (scales cond - uncond prediction).
        It does not affect image conditioning (I2V) or keyframe enforcement (FLF2V).
        Use 5.0 for T2V/I2V, 3.0 for FLF2V, 1.0 for distilled mode.

        Returns:
            dict with timing measurements (phase → seconds).
        """
        # Distilled mode: auto-adjust defaults (8 steps, CFG=1, no STG)
        if self.distilled:
            if stage1_steps is None:
                stage1_steps = 8
            if stage2_steps is None:
                stage2_steps = 3
            cfg_scale = 1.0
            stg_scale = 0.0

        mode = "distilled" if self.distilled else ("a2v" if audio_path else "t2v_i2v")
        if self._pipeline is None or self._pipeline_mode != mode:
            if self._pipeline is not None:
                self._pipeline = None
                import mlx.core as mx
                mx.clear_cache()
            self._pipeline = self._build_pipeline(mode)
            self._pipeline_mode = mode

        t0 = time.time()
        kwargs: dict = dict(
            prompt=prompt,
            output_path=output_path,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            seed=seed,
            cfg_scale=cfg_scale,
            stg_scale=stg_scale,
            image=image,
        )
        kwargs["stage1_steps"] = stage1_steps
        kwargs["stage2_steps"] = stage2_steps
        if audio_path is not None:
            kwargs["audio_path"] = audio_path
        if audio_stage1_only:
            kwargs["audio_stage1_only"] = True
        if audio_cfg_scale is not None:
            from ltx_core_mlx.components.guiders import MultiModalGuiderParams
            kwargs["audio_guider_params"] = MultiModalGuiderParams(
                cfg_scale=audio_cfg_scale,
                stg_scale=stg_scale,
                rescale_scale=_GUIDER_RESCALE_SCALE,
                modality_scale=_GUIDER_MODALITY_SCALE,
                stg_blocks=_GUIDER_STG_BLOCKS,
            )
        if enable_teacache:
            kwargs["enable_teacache"] = True
        if teacache_thresh is not None:
            kwargs["teacache_thresh"] = teacache_thresh

        self._pipeline.generate_and_save(**kwargs)
        return {"generate_seconds": time.time() - t0}

    def generate_flf2v(
        self,
        prompt: str,
        output_path: str,
        begin_image: str,
        end_image: str,
        height: int = 480,
        width: int = 704,
        num_frames: int = 97,
        frame_rate: float = 24.0,
        seed: int = 42,
        stage1_steps: int | None = None,
        stage2_steps: int | None = None,
        cfg_scale: float = 3.0,
        stg_scale: float = 1.0,
        begin_strength: float = 1.0,
        end_strength: float = 1.0,
    ) -> dict:
        """Generate FLF2V video (First-Last Frame to Video / 首尾帧视频生成).

        Uses the KeyframeInterpolationPipeline from the vendor with
        both frames as appended keyframe tokens. Requires the dev
        (non-distilled) transformer — the distilled model hallucinates
        during interpolation.

        CFG vs Keyframe Enforcement:
            These are ORTHOGONAL mechanisms that do not interact:
            - Keyframe enforcement: via denoise_mask=0.0 — keyframe latents are
              deterministically preserved every step. The model ALWAYS reaches
              the end frame regardless of cfg_scale.
            - Text guidance (cfg_scale): scales (cond - uncond) text prediction.
              Controls HOW the model interpolates, not WHETHER it arrives.
            - cfg_scale=5.0 → aggressive text guidance → jump cuts (still reaches end)
            - cfg_scale=3.0 → soft guidance → smooth transition (FLF2V sweet spot)
            - cfg_scale=1.0 → no text guidance → model-driven (may be incoherent)

        Keyframe generation best practice:
            1. Generate begin frame: same seed, free generation
            2. Generate end frame: same seed, DIFFERENT prompt (pose/expression),
               --input <begin_frame> (pixel-level background consistency)
            3. Run FLF2V with cfg_scale=3.0 (auto-set by CLI)

        Args:
            prompt: Text prompt describing the motion/transition.
            output_path: Path to output .mp4 file.
            begin_image: Path to the first frame image.
            end_image: Path to the last frame image.
            height: Video height (must be divisible by 32).
            width: Video width (must be divisible by 32).
            num_frames: Total frame count (must satisfy 8k+1).
            frame_rate: Output frame rate.
            seed: Random seed.
            stage1_steps: Stage 1 denoising steps. Pass None to let the vendor default apply
                (vendor uses ~20 for the dev model). The CLI auto-sets to 20 when not specified.
            stage2_steps: Stage 2 refinement steps (default 3).
            cfg_scale: Text guidance scale (default 3.0 for FLF2V). Only affects text prompt
                influence on interpolation — does NOT affect keyframe enforcement.
            stg_scale: STG (spatio-temporal guidance) scale.
            begin_strength: Conditioning strength for begin frame (1.0=exact).
                Controls denoise_mask: output = x0 * (1-strength) + clean * strength.
            end_strength: Conditioning strength for end frame (1.0=exact,
                lower for more motion freedom).

        Returns:
            dict with timing measurements.
        """
        mode = "flf2v"
        if self._pipeline is None or self._pipeline_mode != mode:
            if self._pipeline is not None:
                self._pipeline = None
                import mlx.core as mx
                mx.clear_cache()
            self._pipeline = self._build_flf2v_pipeline()
            self._pipeline_mode = mode

        from ltx_core_mlx.components.guiders import MultiModalGuiderParams

        last_pixel_frame = num_frames - 1

        video_gp = MultiModalGuiderParams(
            cfg_scale=cfg_scale,
            stg_scale=stg_scale,
            rescale_scale=_GUIDER_RESCALE_SCALE,
            modality_scale=_GUIDER_MODALITY_SCALE,
            stg_blocks=_GUIDER_STG_BLOCKS,
        )
        audio_gp = MultiModalGuiderParams(
            cfg_scale=_FLF2V_AUDIO_CFG_SCALE,
            stg_scale=stg_scale,
            rescale_scale=_GUIDER_RESCALE_SCALE,
            modality_scale=_GUIDER_MODALITY_SCALE,
            stg_blocks=_GUIDER_STG_BLOCKS,
        )

        t0 = time.time()
        self._pipeline.generate_and_save(
            prompt=prompt,
            output_path=output_path,
            keyframe_images=[begin_image, end_image],
            keyframe_indices=[0, last_pixel_frame],
            keyframe_strengths=[begin_strength, end_strength],
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            seed=seed,
            stage1_steps=stage1_steps,
            stage2_steps=stage2_steps,
            cfg_scale=cfg_scale,
            video_guider_params=video_gp,
            audio_guider_params=audio_gp,
        )
        return {"generate_seconds": time.time() - t0}

    def generate_ic_lora(
        self,
        prompt: str,
        output_path: str,
        video_conditioning: list[tuple[str, float]],
        ic_lora_paths: list[tuple[str, float]],
        height: int = 480,
        width: int = 704,
        num_frames: int = 97,
        frame_rate: float = 24.0,
        seed: int = 42,
        stage1_steps: int | None = None,
        stage2_steps: int | None = None,
        images: list | None = None,
        conditioning_attention_strength: float = 1.0,
    ) -> dict:
        """Run IC-LoRA conditioned video generation (control conditioning or restoration).

        Uses ICLoraPipeline from vendor: Stage 1 at half resolution with LoRA fused,
        Stage 2 upscaled and refined without LoRA.

        Args:
            prompt: Text prompt describing the desired output.
            output_path: Path to write the generated .mp4 file.
            video_conditioning: List of (video_path, strength) for IC-LoRA reference frames.
                For video restoration, pass the degraded input video as the conditioning.
            ic_lora_paths: List of (lora_path, scale) tuples. Accepts local paths or
                HuggingFace repo IDs (downloaded on first use).
            height: Output height (must be multiple of 64 — Stage 1 runs at height//2).
            width: Output width (must be multiple of 64 — Stage 1 runs at width//2).
            num_frames: Frame count (must satisfy 8k+1: 9, 17, 25, …).
            frame_rate: Output frame rate.
            seed: Random seed.
            stage1_steps: Stage 1 steps (default: vendor DISTILLED_SIGMAS length).
            stage2_steps: Stage 2 steps (default: vendor STAGE_2_SIGMAS length).
            images: Optional I2V conditioning list of (image_path, frame_index, strength).
            conditioning_attention_strength: IC-LoRA attention weight in [0, 1].

        Returns:
            dict with {'generate_seconds': float}.
        """
        from ltx_pipelines_mlx.ic_lora import ICLoraPipeline

        print(
            f"[LTXVideoPipeline] Loading ICLoraPipeline "
            f"(model_dir={self._model_dir!r}, low_ram={self.low_ram}, "
            f"loras={[os.path.basename(p) for p, _ in ic_lora_paths]})…"
        )

        # ICLoraPipeline takes lora_paths at init — always create fresh (no mode caching)
        if self._pipeline is not None:
            self._pipeline = None
            import mlx.core as mx
            mx.clear_cache()

        pipeline = ICLoraPipeline(
            model_dir=self._model_dir,
            lora_paths=ic_lora_paths,
            low_memory=True,
            low_ram_streaming=self.low_ram,
        )

        t0 = time.time()
        pipeline.generate_and_save(
            prompt=prompt,
            output_path=output_path,
            video_conditioning=video_conditioning,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            seed=seed,
            stage1_steps=stage1_steps,
            stage2_steps=stage2_steps,
            images=images,
            conditioning_attention_strength=conditioning_attention_strength,
        )
        return {"generate_seconds": time.time() - t0}

    def _build_flf2v_pipeline(self):
        """Build a KeyframeInterpolationPipeline for FLF2V mode."""
        from ltx_pipelines_mlx.keyframe_interpolation import KeyframeInterpolationPipeline

        tu_tag = " +temporal-upscale" if self.temporal_upscale else ""
        print(
            f"[LTXVideoPipeline] Loading KeyframeInterpolationPipeline{tu_tag} "
            f"(model_dir={self._model_dir!r}, low_ram={self.low_ram})…"
        )
        t0 = time.time()
        PipelineBase = KeyframeInterpolationPipeline
        if self.temporal_upscale:
            PipelineBase = type(
                "TemporalKeyframeInterpolationPipeline",
                (_TemporalUpscaleMixin, KeyframeInterpolationPipeline),
                {},
            )
        pipeline = PipelineBase(
            model_dir=self._model_dir,
            low_memory=True,
            low_ram_streaming=self.low_ram,
            dev_transformer=self._variant.transformer_file,
            distilled_lora="ltx-2.3-22b-distilled-lora-384.int8.safetensors",
            distilled_lora_strength=self._distilled_lora_strength,
        )
        self._apply_lora(pipeline)

        print(f"[LTXVideoPipeline] Pipeline ready ({time.time() - t0:.1f}s)")
        return pipeline

    def _apply_lora(self, pipeline) -> None:
        """Fuse user LoRA into pipeline via vendor _pending_loras mechanism."""
        if not self.lora_path:
            return
        from app.commands._shared import resolve_lora_path
        resolved = resolve_lora_path(self.lora_path)
        print(f"[LTXVideoPipeline] User LoRA: {resolved} (scale={self.lora_scale})")
        pipeline._pending_loras = [(resolved, self.lora_scale)]
        self._pipeline_events.append({
            "event": "lora_applied", "target": os.path.basename(resolved),
            "detail": {"type": "ltx_pending_lora", "user_scale": self.lora_scale,
                       "fusion": "vendor_pending_loras"},
            "seconds": None,
        })

    def _build_pipeline(self, mode: str):
        t0 = time.time()
        if mode == "distilled":
            from ltx_pipelines_mlx import DistilledPipeline as Pipeline
            print(
                f"[LTXVideoPipeline] Loading {Pipeline.__name__} "
                f"(model_dir={self._model_dir!r}, low_ram={self.low_ram})…"
            )
            pipeline = Pipeline(
                model_dir=self._model_dir,
                low_memory=True,
                low_ram_streaming=self.low_ram,
            )
        elif mode == "a2v":
            from ltx_pipelines_mlx import A2VidPipelineTwoStage as Pipeline
            print(
                f"[LTXVideoPipeline] Loading {Pipeline.__name__} "
                f"(model_dir={self._model_dir!r}, low_ram={self.low_ram})…"
            )
            pipeline = Pipeline(
                model_dir=self._model_dir,
                low_memory=True,
                low_ram_streaming=self.low_ram,
                distilled_lora_strength=self._distilled_lora_strength,
            )
        elif self.hq:
            from ltx_pipelines_mlx import TI2VidTwoStagesHQPipeline as Pipeline
            tu_tag = " +temporal-upscale" if self.temporal_upscale else ""
            hq_tag = f" (HQ res_2s){tu_tag}"
            print(
                f"[LTXVideoPipeline] Loading {Pipeline.__name__}{hq_tag} "
                f"(model_dir={self._model_dir!r}, low_ram={self.low_ram})…"
            )
            PipelineClass = (
                type("TemporalHQPipeline", (_TemporalUpscaleMixin, Pipeline), {})
                if self.temporal_upscale else Pipeline
            )
            pipeline = PipelineClass(
                model_dir=self._model_dir,
                low_memory=True,
                low_ram_streaming=self.low_ram,
                distilled_lora_strength=self._distilled_lora_strength,
            )
        else:
            from ltx_pipelines_mlx import TI2VidTwoStagesPipeline as Pipeline
            tu_tag = " +temporal-upscale" if self.temporal_upscale else ""
            print(
                f"[LTXVideoPipeline] Loading {Pipeline.__name__}{tu_tag} "
                f"(model_dir={self._model_dir!r}, low_ram={self.low_ram})…"
            )
            PipelineClass = (
                type("TemporalTI2VPipeline", (_TemporalUpscaleMixin, Pipeline), {})
                if self.temporal_upscale else Pipeline
            )
            pipeline = PipelineClass(
                model_dir=self._model_dir,
                low_memory=True,
                low_ram_streaming=self.low_ram,
                distilled_lora_strength=self._distilled_lora_strength,
            )
        self._apply_lora(pipeline)

        print(f"[LTXVideoPipeline] Pipeline ready ({time.time() - t0:.1f}s)")
        return pipeline
