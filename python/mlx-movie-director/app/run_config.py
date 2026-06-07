"""Run configuration: schema, serialization, and migration for .run.json files."""

import json
import os
from dataclasses import asdict, dataclass

SCHEMA_VERSION = 6

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

    # img2img / refine
    input_image: str | None = None
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

    # Future: ControlNet / animate
    control_image: str | None = None
    control_type: str | None = None
    control_strength: float | None = None

    # A/B variation tracking
    variation_index: int | None = None      # 1-based index within an A/B test
    ab_params: dict | None = None           # the full ab-params JSON (for reference)

    # ------------------------------------------------------------------
    # Factories
    # ------------------------------------------------------------------

    @classmethod
    def from_args(cls, args, command: str = "generate") -> "RunConfig":
        """Build a RunConfig from a parsed argparse Namespace, filling defaults."""
        from app.commands._shared import resolve_lora_path
        return cls(
            schema_version=SCHEMA_VERSION,
            command=command,
            pipeline=getattr(args, "pipeline", "zimage"),
            prompt=getattr(args, "prompt", None),
            prompt_file=getattr(args, "prompt_file", None),
            width=getattr(args, "width", 640),
            height=getattr(args, "height", 960),
            steps=getattr(args, "steps", 9),
            seed=getattr(args, "seed", 42),
            lora_path=resolve_lora_path(getattr(args, "lora_path", None)),
            lora_scale=getattr(args, "lora_scale", 1.0),
            input_image=getattr(args, "input_image", None),
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
            control_image=getattr(args, "control_image", None),
            control_type=getattr(args, "control_type", None),
            control_strength=getattr(args, "control_strength", None),
            variation_index=getattr(args, "variation_index", None),
            ab_params=getattr(args, "ab_params_json", None),
        )

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

    return raw
