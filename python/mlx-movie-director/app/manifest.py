"""Manifest: post-run metrics and result metadata written to .manifest.json."""

import hashlib
import json
import os
import resource
import sys
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Memory measurement
# ---------------------------------------------------------------------------

def measure_peak_rss_mb() -> float:
    """Return peak RSS in MB. macOS returns bytes from getrusage; Linux returns KB.

    On Apple Silicon with unified memory, ru_maxrss includes Metal/GPU buffers
    since they are mapped into the process's virtual address space.
    """
    try:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform == "darwin":
            return rss / (1024 * 1024)
        else:
            return rss / 1024
    except Exception:
        return 0.0


def file_fingerprint(path: str, chunk_mb: int = 1) -> dict:
    """Fast fingerprint for large files: MD5 of first+last chunks + file size.

    This avoids reading multi-GB files in full while still detecting
    corruption, wrong versions, or truncated downloads.
    """
    if not os.path.exists(path):
        return {"path": path, "error": "file not found"}

    size = os.path.getsize(path)
    chunk = chunk_mb * 1024 * 1024
    md5 = hashlib.md5()

    with open(path, "rb") as f:
        # First chunk
        md5.update(f.read(chunk))
        # Last chunk (if file is larger than one chunk)
        if size > chunk:
            f.seek(max(0, size - chunk))
            md5.update(f.read(chunk))

    return {
        "path": path,
        "realpath": os.path.realpath(path),
        "size_bytes": size,
        "md5_partial": md5.hexdigest(),
    }


def collect_model_fingerprint(lora_path: str | None = None,
                              upscale_model: str | None = None) -> dict:
    """Collect fingerprints for all model files used by the pipeline."""
    from app import config as cfg

    models = {}

    # Transformer
    tf_path = os.path.join(cfg.TRANSFORMER_DIR, "model.safetensors")
    models["transformer"] = file_fingerprint(tf_path)

    # Text encoder
    te_path = os.path.join(cfg.TEXT_ENCODER_DIR, "model.safetensors")
    models["text_encoder"] = file_fingerprint(te_path)

    # VAE
    vae_path = os.path.join(cfg.VAE_DIR, "diffusion_pytorch_model.safetensors")
    models["vae"] = file_fingerprint(vae_path)

    # Tokenizer
    tok_path = os.path.join(cfg.TOKENIZER_DIR, "tokenizer.json")
    models["tokenizer"] = file_fingerprint(tok_path)

    # LoRA (optional)
    if lora_path and os.path.exists(lora_path):
        models["lora"] = file_fingerprint(lora_path)

    # Upscale model (optional)
    if upscale_model and os.path.exists(upscale_model):
        models["upscale"] = file_fingerprint(upscale_model)

    return models


def collect_model_fingerprint_controlnet(lora_path: str | None = None) -> dict:
    """Collect fingerprints for the ControlNet pipeline (ZImage + ControlNet weights)."""
    from app import config as cfg

    models = collect_model_fingerprint(lora_path=lora_path)
    ctrl_path = os.path.join(cfg.CONTROLNET_DIR, "model.safetensors")
    models["controlnet"] = file_fingerprint(ctrl_path)
    return models


def collect_model_fingerprint_flux2(upscale_model: str | None = None) -> dict:
    """Collect fingerprints for Flux2 Klein 9B model files."""
    from app import config as cfg

    models = {}

    # Transformer (Klein 9B INT8)
    tf_path = os.path.join(cfg.KLEIN_9B_TRANSFORMER_DIR, "model.safetensors")
    models["transformer"] = file_fingerprint(tf_path)

    # Text encoder (Qwen3 8B)
    te_path = os.path.join(cfg.KLEIN_9B_TEXT_ENCODER_DIR, "model.safetensors")
    models["text_encoder"] = file_fingerprint(te_path)

    # VAE (Flux2 Klein)
    vae_path = os.path.join(cfg.KLEIN_9B_VAE_DIR, "model.safetensors")
    models["vae"] = file_fingerprint(vae_path)

    # Tokenizer (Qwen3 Klein)
    tok_path = os.path.join(cfg.KLEIN_9B_TOKENIZER_DIR, "tokenizer.json")
    models["tokenizer"] = file_fingerprint(tok_path)

    # Upscale model (optional)
    if upscale_model and os.path.exists(upscale_model):
        models["upscale"] = file_fingerprint(upscale_model)

    return models


@dataclass
class Manifest:
    """Post-run audit record: timing, memory, models, output files, or error details."""

    run_file: str
    status: str             # "success" | "error"
    start_time: str         # ISO 8601
    end_time: str           # ISO 8601
    elapsed_seconds: float
    memory_peak_mb: float
    timings: dict           # phase-level breakdown from GenerationResult
    models: dict            # model fingerprints: {name: {path, size_bytes, md5_partial}}
    output_files: list | None   # [{path, seed, size_bytes, width, height}] or None
    error: dict | None          # {type, message, traceback} or None

    # ------------------------------------------------------------------
    # Factories
    # ------------------------------------------------------------------

    @classmethod
    def from_success(cls, run_file, start_time, end_time, timings,
                     output_files, models):
        elapsed = _parse_iso(end_time) - _parse_iso(start_time)
        return cls(
            run_file=run_file,
            status="success",
            start_time=start_time,
            end_time=end_time,
            elapsed_seconds=elapsed.total_seconds(),
            memory_peak_mb=measure_peak_rss_mb(),
            timings=timings,
            models=models,
            output_files=output_files,
            error=None,
        )

    @classmethod
    def from_error(cls, run_file, start_time, end_time, timings,
                   exception, models):
        elapsed = _parse_iso(end_time) - _parse_iso(start_time)
        return cls(
            run_file=run_file,
            status="error",
            start_time=start_time,
            end_time=end_time,
            elapsed_seconds=elapsed.total_seconds(),
            memory_peak_mb=measure_peak_rss_mb(),
            timings=timings,
            models=models,
            output_files=None,
            error={
                "type": type(exception).__name__,
                "message": str(exception),
                "traceback": traceback.format_exc(),
            },
        )

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_json(self, path: str) -> None:
        """Write manifest to JSON atomically (write .tmp → rename)."""
        data = asdict(self)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, path)


def _parse_iso(s: str) -> datetime:
    """Parse an ISO 8601 string to datetime."""
    return datetime.fromisoformat(s)
