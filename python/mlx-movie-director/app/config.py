import os
import json


def check_model_available(model_dir: str) -> bool:
    """Check if a model directory exists and is not marked as REMOVED.

    If a REMOVED marker file is found, prints the reason and re-conversion
    command, then returns False.  Used by pipeline init to fail gracefully
    when model files have been deleted to reclaim disk space.
    """
    removed_marker = os.path.join(model_dir, "REMOVED")
    if os.path.exists(removed_marker):
        try:
            with open(removed_marker) as f:
                info = json.load(f)
        except (json.JSONDecodeError, OSError):
            info = {}
        print(f"ERROR: Model at {model_dir} has been removed.", flush=True)
        print(f"  Reason: {info.get('reason', 'unknown')}")
        print(f"  To restore: {info.get('reconvert_command', 'run convert.py')}")
        return False
    return os.path.isdir(model_dir)

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(APP_DIR)
REPO_DIR = os.path.dirname(os.path.dirname(PROJECT_DIR))

# ComfyUI model store — BUILD-TIME ONLY. Consumed solely by the SRC_* constants
# below as convert.py re-conversion sources (moody/zimage/seedvr2). Runtime
# pipelines must NEVER read from here — they use MODELS_DIR (the MLX-owned tree).
# This keeps the bun/MLX app self-contained: comfyui_data/ is a gitignored ComfyUI
# install artifact that can vanish on branch switch / git clean.
COMFY_MODELS = os.path.join(REPO_DIR, "comfyui_data", "models")

SRC_TRANSFORMER = os.path.join(COMFY_MODELS, "diffusion_models", "moody-porn-v12.6_00001_.safetensors")
SRC_TEXT_ENCODER = os.path.join(COMFY_MODELS, "text_encoders", "qwen_3_4b.safetensors")

def _resolve_models_dir(raw: str | None) -> str:
    """Resolve the MLX models root — runtime-PWD-relative by default.

    Preference order:
    1. Explicit override (``raw`` from MLX_MODELS_DIR env or run.py --models-dir).
    2. ``<cwd>/mlx-models`` if it exists (the common case: run.py invoked from
       the repo root → ``<repo>/mlx-models``).
    3. Walk up from cwd looking for a ``mlx-models`` dir (so subprocesses / pytest
       invoked from a subdirectory still resolve the repo root's tree).
    4. Fall back to ``REPO_DIR/mlx-models`` (file-derived, cwd-independent).
    """
    if raw:
        p = os.path.expanduser(raw.strip())
        return os.path.normpath(p if os.path.isabs(p) else os.path.join(os.getcwd(), p))
    cwd = os.getcwd()
    cand = os.path.join(cwd, "mlx-models")
    if os.path.isdir(cand):
        return os.path.normpath(cand)
    # Walk up for a mlx-models dir (handles subdirectory invocations).
    parent = cwd
    for _ in range(8):
        parent = os.path.dirname(parent)
        if not parent or parent == os.path.dirname(parent):
            break
        cand = os.path.join(parent, "mlx-models")
        if os.path.isdir(cand):
            return os.path.normpath(cand)
    return os.path.normpath(os.path.join(REPO_DIR, "mlx-models"))


# All constants below that derive from the models root are (re)computed by
# ``_apply_models_dir`` so a runtime override (``set_models_dir``) propagates to
# every call-time ``cfg.X`` reader. Non-derived constants (COMFY_MODELS, SRC_*,
# OUTPUT_DIR) are unaffected by the models-root location.
_MODELS_DIR_GLOBALS = [
    "MODELS_DIR", "TRANSFORMER_DIR", "TEXT_ENCODER_DIR", "TOKENIZER_DIR",
    "VAE_DIR", "ZIMAGE_AE_VAE_DIR", "ULTRAFLUX_VAE_DIR", "LUT_DIR",
    "SEEDVR2_DIT_DIR", "SEEDVR2_VAE_DIR",
    "KLEIN_9B_TRANSFORMER_DIR", "KLEIN_9B_TEXT_ENCODER_DIR", "KLEIN_9B_VAE_DIR",
    "KLEIN_9B_TOKENIZER_DIR",
    "LTX_TRANSFORMER_DIR", "LTX_DISTILLED_TRANSFORMER_DIR", "LTX_LORA_DIR",
    "LTX_TEXT_ENCODER_DIR", "LTX_VAE_DIR", "LTX_AUDIO_DIR",
    "LTX_MLX_DIR", "LTX_MLX_DEV_DIR", "LTX_MLX_DISTILLED_DIR",
    "LTX_DASIWA_TRANSFORMER_DIR", "LTX_MLX_DASIWA_DIR",
    "LTX_RESTORE_LORA", "LTX_UPSCALE_LORA",
    "DEFAULT_UPSCALE_MODEL", "CONTROLNET_DIR",
]


def _apply_models_dir(d: str) -> None:
    """(Re)compute every models-root-derived constant in this module.

    The set of names computed MUST exactly match ``_MODELS_DIR_GLOBALS`` —
    enforced by a post-build assertion so adding a new ``*_DIR`` without
    registering it (or removing one from the list) fails loudly instead of
    silently leaving a stale path when ``set_models_dir`` is called.
    """
    v: dict[str, str] = {}  # local; cross-references resolve from here
    v["MODELS_DIR"] = d
    # Default ZImage model instance paths (named subdirectories under each type)
    v["TRANSFORMER_DIR"] = os.path.join(d, "transformer", "moody-pro-mix")
    v["TEXT_ENCODER_DIR"] = os.path.join(d, "text_encoder", "qwen3-4b")
    v["TOKENIZER_DIR"] = os.path.join(d, "tokenizer", "qwen3")
    v["VAE_DIR"] = os.path.join(d, "vae", "ultraflux-zimage-ae")
    v["ZIMAGE_AE_VAE_DIR"] = os.path.join(d, "vae", "zimage-ae")
    v["ULTRAFLUX_VAE_DIR"] = v["VAE_DIR"]
    v["LUT_DIR"] = os.path.join(d, "lut")
    # SeedVR2 upscaler models (converted from ComfyUI via convert.py)
    v["SEEDVR2_DIT_DIR"] = os.path.join(d, "transformer", "seedvr2-7b")
    v["SEEDVR2_VAE_DIR"] = os.path.join(d, "vae", "seedvr2-vae")
    # Flux2 Klein 9B components (pre-quantized INT8, scattered across categories)
    v["KLEIN_9B_TRANSFORMER_DIR"] = os.path.join(d, "transformer", "klein-9b")
    v["KLEIN_9B_TEXT_ENCODER_DIR"] = os.path.join(d, "text_encoder", "qwen3-8b")
    v["KLEIN_9B_VAE_DIR"] = os.path.join(d, "vae", "flux2-klein")
    v["KLEIN_9B_TOKENIZER_DIR"] = os.path.join(d, "tokenizer", "qwen3-klein")
    # LTX-2.3 22B video generation components (decomposed into standard model dirs)
    v["LTX_TRANSFORMER_DIR"] = os.path.join(d, "transformer", "ltx-2.3-dev-q8")
    v["LTX_DISTILLED_TRANSFORMER_DIR"] = os.path.join(d, "transformer", "ltx-2.3-distilled-q8")
    v["LTX_LORA_DIR"] = os.path.join(d, "lora", "ltx-2.3-distilled")
    v["LTX_TEXT_ENCODER_DIR"] = os.path.join(d, "text_encoder", "ltx-2.3-connector")
    v["LTX_VAE_DIR"] = os.path.join(d, "vae", "ltx-2.3-vae")
    v["LTX_AUDIO_DIR"] = os.path.join(d, "audio", "ltx-2.3-audio")
    # Pre-built flat symlink dirs (ltx-2-mlx expects all files in one flat directory)
    v["LTX_MLX_DIR"] = os.path.join(d, "ltx-mlx")
    v["LTX_MLX_DEV_DIR"] = os.path.join(v["LTX_MLX_DIR"], "dev")
    v["LTX_MLX_DISTILLED_DIR"] = os.path.join(v["LTX_MLX_DIR"], "distilled")
    # DaSiWa LTX-2.3 finetune (e.g. Golden Lace v3) — dev-architecture.
    v["LTX_DASIWA_TRANSFORMER_DIR"] = os.path.join(d, "transformer", "ltx-2.3-dasiwa-golden-lace-v3-q8")
    v["LTX_MLX_DASIWA_DIR"] = os.path.join(v["LTX_MLX_DIR"], "dasiwa")
    # LTX-2.3 IC-LoRA restoration weights (Lightricks/CivitAI).
    v["LTX_RESTORE_LORA"] = os.path.join(d, "lora", "ltx-2.3-restore", "ltx2.3-video-restoration-general.safetensors")
    v["LTX_UPSCALE_LORA"] = os.path.join(d, "lora", "ltx-2.3-restore", "ltx2.3-ic-video-upscale-general.safetensors")
    # Default ESRGAN upscale model (4xNomosWebPhoto_RealPLKSR) — single source of truth.
    v["DEFAULT_UPSCALE_MODEL"] = os.path.join(d, "upscale", "4x-nomos-webphoto-realplksr", "4xNomosWebPhoto_RealPLKSR.pth")
    # Z-Image ControlNet (Union 2.1 Lite, MLX 4-bit GS32).
    v["CONTROLNET_DIR"] = os.path.join(d, "controlnet", "zimage-turbo-fun-union-2.1-mlx")
    # Drift guard: the names computed above must match the declared registry.
    assert set(v) == set(_MODELS_DIR_GLOBALS), (
        "_apply_models_dir / _MODELS_DIR_GLOBALS drift (symmetric difference): "
        f"{sorted(set(v) ^ set(_MODELS_DIR_GLOBALS))}"
    )
    globals().update(v)


MODELS_DIR = _resolve_models_dir(os.environ.get("MLX_MODELS_DIR"))
_apply_models_dir(MODELS_DIR)


def set_models_dir(path: str) -> None:
    """Runtime override of the models root (run.py ``--models-dir``).

    Recomputes every derived ``*_DIR`` constant so callers reading ``cfg.X`` at
    call time see the new root. Mirrors the OUTPUT_DIR override pattern.
    """
    _apply_models_dir(_resolve_models_dir(path))

def _resolve_output_dir(raw: str) -> str:
    """Resolve the generation output dir — runtime-PWD-relative by default.

    Preference order: explicit override (absolute/``~`` used as-is, relative joined
    to cwd); else the PWD-relative default walked up until it exists (so a
    subdirectory invocation still finds the repo-sibling store); else the
    file-derived ``REPO_DIR/<default>`` (created on demand).
    """
    p = os.path.expanduser(raw.strip())
    if os.path.isabs(p):
        return os.path.normpath(p)
    if raw == DEFAULT_OUTPUT_DIR:
        # No explicit override — walk up from cwd for the canonical store.
        d = os.getcwd()
        for _ in range(8):
            cand = os.path.normpath(os.path.join(d, p))
            if os.path.isdir(cand):
                return cand
            nd = os.path.dirname(d)
            if nd == d:
                break
            d = nd
        return os.path.normpath(os.path.join(REPO_DIR, p))
    # Explicit relative override — anchor to REPO_DIR (cwd-independent, stable).
    return os.path.normpath(os.path.join(REPO_DIR, p))


# Externalized output store — sibling of the repo (mirrors ../video_generation__models).
# Repo-relative by default; override via the MLX_OUTPUT_DIR env var or run.py --output-dir.
DEFAULT_OUTPUT_DIR = "../video_generation__output"
OUTPUT_DIR = _resolve_output_dir(os.environ.get("MLX_OUTPUT_DIR") or DEFAULT_OUTPUT_DIR)
# SeedVR2 source models (for convert.py)
SRC_SEEDVR2_DIT_7B = os.path.join(COMFY_MODELS, "SEEDVR2", "seedvr2_ema_7b_fp16.safetensors")
SRC_SEEDVR2_VAE = os.path.join(COMFY_MODELS, "SEEDVR2", "ema_vae_fp16.safetensors")

# SeedVR2 text embeddings — pre-computed positive/negative prompt embeddings,
# loaded at inference (NOT converted). Co-located in the MLX tree
# (app/seedvr2/embeddings/) so the SeedVR2 upscaler is SELF-CONTAINED: the MLX
# pipeline must NOT depend on a ComfyUI custom node being installed. The previous
# path pointed into comfyui_data/custom_nodes/ComfyUI-SeedVR2_VideoUpscaler/,
# which is a ComfyUI install artifact that vanishes on branch switch / git clean
# and broke purify with "Text embedding not found". The bun app only ever calls
# run.py (MLX) — it never invokes ComfyUI — so this asset belongs in the MLX tree.
SEEDVR2_EMB_DIR = os.path.join(APP_DIR, "seedvr2", "embeddings")
SEEDVR2_POS_EMB = os.path.join(SEEDVR2_EMB_DIR, "pos_emb.pt")
SEEDVR2_NEG_EMB = os.path.join(SEEDVR2_EMB_DIR, "neg_emb.pt")

TRANSFORMER_CONFIG = {
    "_class_name": "ZImageTransformer2DModel",
    "_diffusers_version": "0.36.0.dev0",
    "all_f_patch_size": [1],
    "all_patch_size": [2],
    "axes_dims": [32, 48, 48],
    "axes_lens": [1536, 512, 512],
    "cap_feat_dim": 2560,
    "dim": 3840,
    "in_channels": 16,
    "n_heads": 30,
    "n_kv_heads": 30,
    "n_layers": 30,
    "n_refiner_layers": 2,
    "norm_eps": 1e-05,
    "qk_norm": True,
    "rope_theta": 256.0,
    "t_scale": 1000.0,
    "nheads": 30,
}

TEXT_ENCODER_CONFIG = {
    "hidden_size": 2560,
    "intermediate_size": 9728,
    "num_attention_heads": 32,
    "num_hidden_layers": 36,
    "num_key_value_heads": 8,
    "rms_norm_eps": 1e-06,
    "rope_theta": 1000000.0,
    "vocab_size": 151936,
    "head_dim": 128,
}
