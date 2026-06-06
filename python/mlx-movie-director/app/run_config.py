"""Run configuration: schema, serialization, and migration for .run.json files."""

import json
import os
from dataclasses import asdict, dataclass, field

SCHEMA_VERSION = 2


@dataclass
class RunConfig:
    """Captures every parameter for a single pipeline run.

    Written to <base_name>.run.json before execution starts.
    Loaded back via --replay to reproduce a run.
    """

    schema_version: int = SCHEMA_VERSION
    action: str = "text2img"
    prompt: str | None = None
    prompt_file: str | None = None
    width: int = 1024
    height: int = 1024
    steps: int = 9
    seed: int = 42
    lora_path: str | None = None
    lora_scale: float = 1.0
    # img2img
    input_image: str | None = None
    latent_upscale: float = 1.0
    denoise_strength: float = 1.0
    # post-process
    upscale: bool = False
    upscale_model: str | None = None
    # batch
    count: int = 1
    seed_start: int | None = None

    # ------------------------------------------------------------------
    # Factories
    # ------------------------------------------------------------------

    @classmethod
    def from_args(cls, args, action: str = "text2img") -> "RunConfig":
        """Build a RunConfig from a parsed argparse Namespace, filling defaults."""
        return cls(
            schema_version=SCHEMA_VERSION,
            action=action,
            prompt=getattr(args, "prompt", None),
            prompt_file=getattr(args, "prompt_file", None),
            width=getattr(args, "width", 1024),
            height=getattr(args, "height", 1024),
            steps=getattr(args, "steps", 9),
            seed=getattr(args, "seed", 42),
            lora_path=getattr(args, "lora_path", None),
            lora_scale=getattr(args, "lora_scale", 1.0),
            input_image=getattr(args, "input_image", None),
            latent_upscale=getattr(args, "latent_upscale", 1.0),
            denoise_strength=getattr(args, "denoise_strength", 1.0),
            upscale=getattr(args, "upscale", False),
            upscale_model=getattr(args, "upscale_model", None),
            count=getattr(args, "count", 1),
            seed_start=getattr(args, "seed_start", None),
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
        return cls(**{k: raw[k] for k in raw if k in cls.__dataclass_fields__})

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
    """Migrate a raw run config dict from older schema versions."""
    version = raw.get("schema_version", 0)

    if version < 1:
        raise ValueError(
            f"Run config has unsupported schema_version {version}. "
            f"Minimum supported version is 1."
        )

    if version == 1:
        # v1 → v2: add img2img, upscale, batch fields with defaults
        raw.setdefault("input_image", None)
        raw.setdefault("latent_upscale", 1.0)
        raw.setdefault("denoise_strength", 1.0)
        raw.setdefault("upscale", False)
        raw.setdefault("upscale_model", None)
        raw.setdefault("count", 1)
        raw.setdefault("seed_start", None)
        raw["schema_version"] = 2

    return raw
