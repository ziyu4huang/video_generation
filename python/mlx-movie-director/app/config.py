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

COMFY_MODELS = os.path.join(REPO_DIR, "comfyui_data", "models")

SRC_TRANSFORMER = os.path.join(COMFY_MODELS, "diffusion_models", "moody-porn-v12.6_00001_.safetensors")
SRC_TEXT_ENCODER = os.path.join(COMFY_MODELS, "text_encoders", "qwen_3_4b.safetensors")

MODELS_DIR = os.path.join(PROJECT_DIR, "models")

# Default ZImage model instance paths (named subdirectories under each type)
TRANSFORMER_DIR  = os.path.join(MODELS_DIR, "transformer",   "zimage-moody-v126")
TEXT_ENCODER_DIR = os.path.join(MODELS_DIR, "text_encoder",  "qwen3-4b")
TOKENIZER_DIR    = os.path.join(MODELS_DIR, "tokenizer",     "qwen3")
VAE_DIR           = os.path.join(MODELS_DIR, "vae",           "flux-ae")
ULTRAFLUX_VAE_DIR = os.path.join(MODELS_DIR, "vae",           "ultraflux-ae")

OUTPUT_DIR = os.path.join(PROJECT_DIR, "output")
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

# Z-Image ControlNet (Union 2.1 Lite — supports pose/depth/canny/hed/scribble/gray, 8-step distilled)
CONTROLNET_DIR = os.path.join(MODELS_DIR, "controlnet", "zimage-turbo-fun-union-2.1")

# SeedVR2 text embeddings (loaded at inference, not converted)
SEEDVR2_CUSTOM_NODES = os.path.join(REPO_DIR, "comfyui_data", "custom_nodes", "ComfyUI-SeedVR2_VideoUpscaler")
SEEDVR2_POS_EMB = os.path.join(SEEDVR2_CUSTOM_NODES, "pos_emb.pt")
SEEDVR2_NEG_EMB = os.path.join(SEEDVR2_CUSTOM_NODES, "neg_emb.pt")

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
