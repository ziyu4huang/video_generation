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

MODELS_DIR = os.path.join(PROJECT_DIR, "models")

# Default ZImage model instance paths (named subdirectories under each type)
TRANSFORMER_DIR  = os.path.join(MODELS_DIR, "transformer",   "zimage-moody-v126")
TEXT_ENCODER_DIR = os.path.join(MODELS_DIR, "text_encoder",  "qwen3-4b")
TOKENIZER_DIR    = os.path.join(MODELS_DIR, "tokenizer",     "qwen3")
VAE_DIR              = os.path.join(MODELS_DIR, "vae", "ultraflux-zimage-ae")
ZIMAGE_AE_VAE_DIR    = os.path.join(MODELS_DIR, "vae", "zimage-ae")
ULTRAFLUX_VAE_DIR    = VAE_DIR

def _resolve_output_dir(raw: str) -> str:
    """Normalize an output dir value — CWD-independent.

    Absolute paths (and ``~``) are used as-is; repo-relative values are joined to
    REPO_DIR (derived from ``__file__``, never ``os.getcwd()``). ``normpath`` matches
    bun's ``path.resolve`` lexical normalization, so both sides produce the identical
    clean absolute path (e.g. /…/video_generation__output, no dangling /../).
    """
    p = os.path.expanduser(raw.strip())
    return os.path.normpath(p if os.path.isabs(p) else os.path.join(REPO_DIR, p))


# Externalized output store — sibling of the repo (mirrors ../video_generation__models).
# Repo-relative by default; override via the MLX_OUTPUT_DIR env var or run.py --output-dir.
DEFAULT_OUTPUT_DIR = "../video_generation__output"
OUTPUT_DIR = _resolve_output_dir(os.environ.get("MLX_OUTPUT_DIR") or DEFAULT_OUTPUT_DIR)
LUT_DIR = os.path.join(MODELS_DIR, "lut")

# SeedVR2 source models (for convert.py)
SRC_SEEDVR2_DIT_7B = os.path.join(COMFY_MODELS, "SEEDVR2", "seedvr2_ema_7b_fp16.safetensors")
SRC_SEEDVR2_VAE = os.path.join(COMFY_MODELS, "SEEDVR2", "ema_vae_fp16.safetensors")

# SeedVR2 upscaler models (converted from ComfyUI via convert.py --seedvr2-dit / --seedvr2-vae)
SEEDVR2_DIT_DIR = os.path.join(MODELS_DIR, "transformer", "seedvr2-7b")
SEEDVR2_VAE_DIR = os.path.join(MODELS_DIR, "vae", "seedvr2-vae")

# Flux2 Klein 9B components (pre-quantized INT8, scattered across categories)
KLEIN_9B_TRANSFORMER_DIR  = os.path.join(MODELS_DIR, "transformer", "klein-9b")
KLEIN_9B_TEXT_ENCODER_DIR = os.path.join(MODELS_DIR, "text_encoder", "qwen3-8b")
KLEIN_9B_VAE_DIR          = os.path.join(MODELS_DIR, "vae", "flux2-klein")
KLEIN_9B_TOKENIZER_DIR    = os.path.join(MODELS_DIR, "tokenizer", "qwen3-klein")

# LTX-2.3 22B video generation components (decomposed into standard model dirs)
LTX_TRANSFORMER_DIR          = os.path.join(MODELS_DIR, "transformer",   "ltx-2.3-dev-q8")
LTX_DISTILLED_TRANSFORMER_DIR = os.path.join(MODELS_DIR, "transformer",  "ltx-2.3-distilled-q8")
LTX_LORA_DIR                 = os.path.join(MODELS_DIR, "lora",          "ltx-2.3-distilled")
LTX_TEXT_ENCODER_DIR         = os.path.join(MODELS_DIR, "text_encoder",  "ltx-2.3-connector")
LTX_VAE_DIR                  = os.path.join(MODELS_DIR, "vae",           "ltx-2.3-vae")
LTX_AUDIO_DIR                = os.path.join(MODELS_DIR, "audio",         "ltx-2.3-audio")

# Pre-built flat symlink dirs (ltx-2-mlx expects all files in one flat directory)
# Created by scripts/setup_ltx_symlinks.py — avoids on-the-fly temp assembly.
LTX_MLX_DIR         = os.path.join(MODELS_DIR, "ltx-mlx")
LTX_MLX_DEV_DIR     = os.path.join(LTX_MLX_DIR, "dev")
LTX_MLX_DISTILLED_DIR = os.path.join(LTX_MLX_DIR, "distilled")

# DaSiWa LTX-2.3 finetune (e.g. Golden Lace v3) — dev-architecture, converted to
# MLX int8 by convert.py --ltx-checkpoint. Shares the base text encoder / VAE /
# audio / distilled-LoRA; only the transformer differs. Presented as
# transformer-dev.safetensors in its flat dir (same slot as dev).
LTX_DASIWA_TRANSFORMER_DIR = os.path.join(MODELS_DIR, "transformer", "ltx-2.3-dasiwa-golden-lace-v3-q8")
LTX_MLX_DASIWA_DIR         = os.path.join(LTX_MLX_DIR, "dasiwa")

# LTX-2.3 IC-LoRA restoration weights (download from Lightricks/CivitAI). They live
# in the MLX-owned model tree (NOT comfyui_data) so the restore pipeline is
# self-contained — the bun app only ever spawns run.py, never ComfyUI.
LTX_RESTORE_LORA = os.path.join(MODELS_DIR, "lora", "ltx-2.3-restore", "ltx2.3-video-restoration-general.safetensors")
LTX_UPSCALE_LORA = os.path.join(MODELS_DIR, "lora", "ltx-2.3-restore", "ltx2.3-ic-video-upscale-general.safetensors")

# Default ESRGAN upscale model (download 4xNomosWebPhoto_RealPLKSR). Single source
# of truth — re-exported by commands._shared and commands._output (both previously
# held divergent comfyui_data copies).
DEFAULT_UPSCALE_MODEL = os.path.join(
    MODELS_DIR, "upscale", "4x-nomos-webphoto-realplksr", "4xNomosWebPhoto_RealPLKSR.pth"
)

# Z-Image ControlNet (Union 2.1 Lite — supports pose/depth/canny/hed/scribble/gray, 8-step distilled)
# MLX 4-bit GS32 quantized version; 69% smaller than BF16 original (SSIM 97.9%).
CONTROLNET_DIR = os.path.join(MODELS_DIR, "controlnet", "zimage-turbo-fun-union-2.1-mlx")

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
