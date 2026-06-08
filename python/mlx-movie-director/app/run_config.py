"""Run configuration: schema, serialization, and migration for .run.json files."""

import json
import os
from dataclasses import asdict, dataclass

SCHEMA_VERSION = 11

# v2 action names → v3 command names
_ACTION_TO_COMMAND = {
    "text2img": "generate",
    "img2img": "refine",
}


@dataclass
class RunConfig:
    """Captures every parameter for a single pipeline run.

    Written to <base_name>.run.json before execution starts.
    Loaded back via the replay command to reproduce a run.
    """

    schema_version: int = SCHEMA_VERSION
    command: str = "generate"           # replaces v2 "action" field

    # Pipeline selection
    pipeline: str = "zimage"            # "zimage" or "flux2-klein"
    transformer: str = "klein-9b"       # Transformer instance dir under models/transformer/

    # Prompt
    prompt: str | None = None
    prompt_file: str | None = None

    # Generation
    width: int = 640
    height: int = 960
    steps: int = 9
    seed: int = 42
    lora_path: str | None = None
    lora_scale: float = 1.0
    vae_path: str | None = None

    # img2img / refine / FLF2V keyframe reference
    input_image: str | None = None   # Reference image for: I2V conditioning (video),
                                     # T2I visual anchor (image), FLF2V keyframe background
                                     # consistency (use same seed + different prompt)
    latent_upscale: float = 1.0
    denoise_strength: float = 1.0

    # Post-process
    upscale: bool = False
    upscale_model: str | None = None
    upscale_method: str = "esrgan"

    # Batch
    count: int = 1
    seed_start: int | None = None

    # Video (LTX)
    frames: int | None = None
    fps: float | None = None
    video_model: str | None = None
    cfg_scale: float = 5.0
    stg_scale: float = 1.0
    low_ram: bool = False
    audio: str | None = None
    stage1_steps: int | None = None
    stage2_steps: int | None = None
    hq: bool = False
    teacache: bool = False
    teacache_thresh: float | None = None
    enhance_prompt: bool = False

    # FLF2V (First-Last Frame to Video / 首尾帧视频生成)
    begin_image: str | None = None
    end_image: str | None = None
    begin_strength: float = 1.0
    end_strength: float = 1.0

    # Distilled mode (faster generation: 8 steps, CFG=1)
    distilled: bool = False

    # Temporal upscaling (F → 2F-1 frames after Stage 2, before VAE decode)
    temporal_upscale: bool = False

    # Future: ControlNet / animate
    control_image: str | None = None
    control_type: str | None = None
    control_strength: float | None = None

    # A/B variation tracking
    variation_index: int | None = None      # 1-based index within an A/B test
    ab_params: dict | None = None           # the full ab-params JSON (for reference)

    # Draft mode (quick preview: fewer steps, smaller resolution)
    draft: bool = False

    # Seed variance enhancer (perturb text embeddings in early denoising steps)
    seed_variance: bool = False
    seed_variance_percent: float = 50.0
    seed_variance_strength: float = 20.0
    seed_variance_switchover: float = 20.0

    # ------------------------------------------------------------------
    # Factories
    # ------------------------------------------------------------------

    @classmethod
    def from_args(cls, args, command: str = "generate") -> "RunConfig":
        """Build a RunConfig from a parsed argparse Namespace, filling defaults."""
        from app.commands._shared import resolve_lora_path, resolve_vae_path
        rc = cls(
            schema_version=SCHEMA_VERSION,
            command=command,
            pipeline=getattr(args, "pipeline", "zimage"),
            transformer=getattr(args, "transformer", "klein-9b"),
            prompt=getattr(args, "prompt", None),
            prompt_file=getattr(args, "prompt_file", None),
            width=getattr(args, "width", 640),
            height=getattr(args, "height", 960),
            steps=getattr(args, "steps", 9),
            seed=getattr(args, "seed", 42),
            lora_path=resolve_lora_path(getattr(args, "lora_path", None)),
            lora_scale=getattr(args, "lora_scale", 1.0),
            vae_path=resolve_vae_path(getattr(args, "vae_path", None)),
            input_image=getattr(args, "input_image", None) or getattr(args, "input", None),
            latent_upscale=getattr(args, "latent_upscale", 1.0),
            denoise_strength=getattr(args, "denoise_strength", 1.0),
            upscale=getattr(args, "upscale", False),
            upscale_model=getattr(args, "upscale_model", None),
            upscale_method=getattr(args, "upscale_method", "esrgan"),
            count=getattr(args, "count", 1),
            seed_start=getattr(args, "seed_start", None),
            frames=getattr(args, "frames", None),
            fps=getattr(args, "fps", None),
            video_model=getattr(args, "video_model", None),
            cfg_scale=getattr(args, "cfg_scale", 5.0),
            stg_scale=getattr(args, "stg_scale", 1.0),
            low_ram=getattr(args, "low_ram", False),
            audio=getattr(args, "audio", None),
            stage1_steps=getattr(args, "stage1_steps", None),
            stage2_steps=getattr(args, "stage2_steps", None),
            hq=getattr(args, "hq", False),
            teacache=getattr(args, "teacache", False),
            teacache_thresh=getattr(args, "teacache_thresh", None),
            enhance_prompt=getattr(args, "enhance_prompt", False),
            begin_image=getattr(args, "begin_image", None),
            end_image=getattr(args, "end_image", None),
            begin_strength=getattr(args, "begin_strength", 1.0),
            end_strength=getattr(args, "end_strength", 1.0),
            distilled=getattr(args, "distilled", False),
            temporal_upscale=getattr(args, "temporal_upscale", False),
            control_image=getattr(args, "control_image", None),
            control_type=getattr(args, "control_type", None),
            control_strength=getattr(args, "control_strength", None),
            variation_index=getattr(args, "variation_index", None),
            ab_params=getattr(args, "ab_params_json", None),
            draft=getattr(args, "draft", False),
            seed_variance=getattr(args, "seed_variance", False),
            seed_variance_percent=getattr(args, "seed_variance_percent", 50.0),
            seed_variance_strength=getattr(args, "seed_variance_strength", 20.0),
            seed_variance_switchover=getattr(args, "seed_variance_switchover", 20.0),
        )
        # Inline prompt-file content so run.json is self-contained
        if rc.prompt_file and not rc.prompt:
            with open(rc.prompt_file, "r") as f:
                rc.prompt = f.read().strip()
        return rc

    @classmethod
    def from_json(cls, path: str) -> "RunConfig":
        """Load a .run.json file, migrating from older schema versions if needed."""
        with open(path, "r") as f:
            raw = json.load(f)

        version = raw.get("schema_version", 0)
        if version > SCHEMA_VERSION:
            raise ValueError(
                f"Run config schema_version {version} is newer than supported "
                f"{SCHEMA_VERSION}. Update mlx-movie-director to replay this run."
            )

        raw = _migrate(raw)
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in raw.items() if k in known})

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_json(self, path: str) -> None:
        """Write run config to JSON atomically (write .tmp → rename)."""
        data = asdict(self)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, path)


def _migrate(raw: dict) -> dict:
    """Migrate a raw run config dict through version chain to SCHEMA_VERSION."""
    version = raw.get("schema_version", 0)

    if version < 1:
        raise ValueError(
            f"Run config has unsupported schema_version {version}. "
            f"Minimum supported version is 1."
        )

    if version == 1:
        # v1 → v2: add img2img, upscale, batch fields
        raw.setdefault("input_image", None)
        raw.setdefault("latent_upscale", 1.0)
        raw.setdefault("denoise_strength", 1.0)
        raw.setdefault("upscale", False)
        raw.setdefault("upscale_model", None)
        raw.setdefault("count", 1)
        raw.setdefault("seed_start", None)
        raw["schema_version"] = 2
        version = 2

    if version == 2:
        # v2 → v3: rename action → command; add future fields
        old_action = raw.pop("action", "text2img")
        raw["command"] = _ACTION_TO_COMMAND.get(old_action, old_action)
        raw.setdefault("frames", None)
        raw.setdefault("fps", None)
        raw.setdefault("video_model", None)
        raw.setdefault("control_image", None)
        raw.setdefault("control_type", None)
        raw.setdefault("control_strength", None)
        raw["schema_version"] = 3
        version = 3

    if version == 3:
        # v3 → v4: add LTX video generation params
        raw.setdefault("cfg_scale", 3.0)
        raw.setdefault("stg_scale", 1.0)
        raw.setdefault("low_ram", False)
        raw.setdefault("audio", None)
        raw.setdefault("stage1_steps", None)
        raw.setdefault("stage2_steps", None)
        raw["schema_version"] = 4
        version = 4

    if version == 4:
        # v4 → v5: add pipeline selection field
        raw.setdefault("pipeline", "zimage")
        raw["schema_version"] = 5
        version = 5

    if version == 5:
        # v5 → v6: add A/B variation tracking fields
        raw.setdefault("variation_index", None)
        raw.setdefault("ab_params", None)
        raw["schema_version"] = 6
        version = 6

    if version == 6:
        # v6 → v7: add HQ pipeline, TeaCache, prompt enhancement fields
        raw.setdefault("hq", False)
        raw.setdefault("teacache", False)
        raw.setdefault("teacache_thresh", None)
        raw.setdefault("enhance_prompt", False)
        raw["schema_version"] = 7
        version = 7

    if version == 7:
        # v7 → v8: add FLF2V (First-Last Frame to Video) fields
        raw.setdefault("begin_image", None)
        raw.setdefault("end_image", None)
        raw.setdefault("begin_strength", 1.0)
        raw.setdefault("end_strength", 1.0)
        raw["schema_version"] = 8
        version = 8

    if version == 8:
        # v8 → v9: add distilled mode flag
        raw.setdefault("distilled", False)
        raw["schema_version"] = 9
        version = 9

    if version == 9:
        # v9 → v10: add temporal upscaling flag
        raw.setdefault("temporal_upscale", False)
        raw["schema_version"] = 10
        version = 10

    if version == 10:
        # v10 → v11: add draft mode, vae_path, seed variance fields
        raw.setdefault("draft", False)
        raw.setdefault("vae_path", None)
        raw.setdefault("seed_variance", False)
        raw.setdefault("seed_variance_percent", 50.0)
        raw.setdefault("seed_variance_strength", 20.0)
        raw.setdefault("seed_variance_switchover", 20.0)
        raw["schema_version"] = 11
        version = 11

    return raw
