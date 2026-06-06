import os

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(APP_DIR)
REPO_DIR = os.path.dirname(os.path.dirname(PROJECT_DIR))

COMFY_MODELS = os.path.join(REPO_DIR, "comfyui_data", "models")

SRC_TRANSFORMER = os.path.join(COMFY_MODELS, "diffusion_models", "moody-porn-v12.6_00001_.safetensors")
SRC_TEXT_ENCODER = os.path.join(COMFY_MODELS, "text_encoders", "qwen_3_4b.safetensors")

MODELS_DIR = os.path.join(PROJECT_DIR, "models")
TRANSFORMER_DIR = os.path.join(MODELS_DIR, "transformer")
TEXT_ENCODER_DIR = os.path.join(MODELS_DIR, "text_encoder")
TOKENIZER_DIR = os.path.join(MODELS_DIR, "tokenizer")
VAE_DIR = os.path.join(MODELS_DIR, "vae")

OUTPUT_DIR = os.path.join(PROJECT_DIR, "output")

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
