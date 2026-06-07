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

_VENDOR_BASE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "vendor", "ltx-2-mlx",
)
for _pkg in ("packages/ltx-core-mlx", "packages/ltx-pipelines-mlx"):
    _src = os.path.join(_VENDOR_BASE, _pkg, "src")
    if os.path.isdir(_src) and _src not in sys.path:
        sys.path.insert(0, _src)

# Apply vendor monkey-patches before any vendor classes are instantiated.
import app.vendor_patches  # noqa: F401


# ---------------------------------------------------------------------------
# Component → file mapping  (all files live in a flat root for ltx-2-mlx)
# ---------------------------------------------------------------------------

_LTX_COMPONENT_FILES: dict[str, list[str]] = {
    cfg.LTX_TRANSFORMER_DIR: [
        "transformer-dev.safetensors",
        "split_model.json",
        "quantize_config.json",
    ],
    cfg.LTX_LORA_DIR: [
        "ltx-2.3-22b-distilled-lora-384.safetensors",
    ],
    cfg.LTX_TEXT_ENCODER_DIR: [
        "connector.safetensors",
        "config.json",
        "embedded_config.json",  # Transformer architecture config (av_ca_timestep_scale_multiplier)
    ],
    cfg.LTX_VAE_DIR: [
        "vae_encoder.safetensors",
        "vae_decoder.safetensors",
        "spatial_upscaler_x2_v1_1.safetensors",
        "spatial_upscaler_x2_v1_1_config.json",
    ],
    cfg.LTX_AUDIO_DIR: [
        "audio_vae.safetensors",
        "vocoder.safetensors",
    ],
}

# Required files whose absence means local components aren't ready
_LTX_REQUIRED_FILES = [
    (cfg.LTX_TRANSFORMER_DIR, "transformer-dev.safetensors"),
    (cfg.LTX_LORA_DIR,        "ltx-2.3-22b-distilled-lora-384.safetensors"),
    (cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors"),
    (cfg.LTX_VAE_DIR,         "vae_encoder.safetensors"),
    (cfg.LTX_VAE_DIR,         "vae_decoder.safetensors"),
]


def _local_components_ready() -> bool:
    return all(
        os.path.exists(os.path.join(d, f))
        for d, f in _LTX_REQUIRED_FILES
    )


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
            if os.path.exists(src):
                os.symlink(src, dst)
    return tmp


class LTXVideoPipeline:
    """Thin wrapper around ltx-pipelines-mlx TI2VidTwoStagesPipeline / A2VidPipelineTwoStage.

    Supports:
      T2V  — text-to-video (default)
      I2V  — image-to-video (pass image=path)
      A2V  — audio-to-video (pass audio_path=path)
    """

    def __init__(
        self,
        model_dir: str | None = None,
        low_ram: bool = False,
    ):
        """
        Args:
            model_dir:  Local flat directory or HuggingFace repo ID.
                        None → auto-detect local components; fallback to HF auto-download.
            low_ram:    Block-streaming mode — ~75% lower peak Metal RAM, slower per step.
        """
        self.low_ram = low_ram
        self._assembly_dir: str | None = None
        self._pipeline = None
        self._pipeline_mode: str | None = None  # "t2v_i2v" or "a2v"

        if model_dir:
            self._model_dir = model_dir
            print(f"[LTXVideoPipeline] Using explicit model_dir: {model_dir}")
        elif _local_components_ready():
            self._assembly_dir = _assemble_flat_dir()
            self._model_dir = self._assembly_dir
            print("[LTXVideoPipeline] Using local pre-downloaded components (symlink assembly)")
        else:
            self._model_dir = "dgrauet/ltx-2.3-mlx-q8"
            print(
                f"[LTXVideoPipeline] Local components not found — "
                f"HF auto-download: {self._model_dir}"
            )

    def __del__(self) -> None:
        if self._assembly_dir and os.path.isdir(self._assembly_dir):
            shutil.rmtree(self._assembly_dir, ignore_errors=True)

    def close(self) -> None:
        """Explicit cleanup — call before creating a new pipeline to free memory."""
        self._pipeline = None
        if self._assembly_dir and os.path.isdir(self._assembly_dir):
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
    ) -> dict:
        """Generate a video and write to output_path.

        Returns:
            dict with timing measurements (phase → seconds).
        """
        mode = "a2v" if audio_path else "t2v_i2v"
        if self._pipeline is None or self._pipeline_mode != mode:
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
                rescale_scale=0.7,
                modality_scale=3.0,
                stg_blocks=[28],
            )

        self._pipeline.generate_and_save(**kwargs)
        return {"generate_seconds": time.time() - t0}

    def _build_pipeline(self, mode: str):
        t0 = time.time()
        if mode == "a2v":
            from ltx_pipelines_mlx import A2VidPipelineTwoStage as Pipeline
        else:
            from ltx_pipelines_mlx import TI2VidTwoStagesPipeline as Pipeline
        print(
            f"[LTXVideoPipeline] Loading {Pipeline.__name__} "
            f"(model_dir={self._model_dir!r}, low_ram={self.low_ram})…"
        )
        pipeline = Pipeline(
            model_dir=self._model_dir,
            low_memory=True,
            low_ram_streaming=self.low_ram,
        )
        print(f"[LTXVideoPipeline] Pipeline ready ({time.time() - t0:.1f}s)")
        return pipeline
