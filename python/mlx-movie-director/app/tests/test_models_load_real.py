"""Real-model GPU tests — Tier 1: model loading + single forward pass.

These tests load actual MLX weight files from ``models/`` and run one forward
pass to verify the model builds, weights load correctly, and outputs have the
expected shape / are free of NaN/Inf.

All tests in this file require:
  - ``--run-gpu`` CLI flag (otherwise skipped by conftest.py)
  - Real model weight files on disk (otherwise individually skipped)
  - Apple Silicon with Metal GPU
"""

import json
import os
import gc
import sys

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Module-level guards
# ---------------------------------------------------------------------------

pytestmark = [pytest.mark.gpu]

try:
    import mlx.core as mx
    import mlx.nn as nn
    HAS_MLX = True
except ImportError:
    HAS_MLX = False
    mx = None
    nn = None

# ---------------------------------------------------------------------------
# Model path helpers
# ---------------------------------------------------------------------------

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.normpath(os.path.join(_APP_DIR, "..", ".."))
_MODELS_DIR = os.path.join(_PROJECT_DIR, "models")

TRANSFORMER_DIR = os.path.join(_MODELS_DIR, "transformer", "zimage-moody-v126")
TEXT_ENCODER_DIR = os.path.join(_MODELS_DIR, "text_encoder", "qwen3-4b")
TOKENIZER_DIR = os.path.join(_MODELS_DIR, "tokenizer", "qwen3")
VAE_DIR = os.path.join(_MODELS_DIR, "vae", "flux-ae")


def _weight_file_exists(model_dir: str) -> bool:
    """Check if model.safetensors (or .index.json) exists under model_dir."""
    if not os.path.isdir(model_dir):
        return False
    if os.path.isfile(os.path.join(model_dir, "model.safetensors")):
        return True
    if os.path.isfile(os.path.join(model_dir, "model.safetensors.index.json")):
        return True
    # fallback: any .safetensors file
    import glob
    return len(glob.glob(os.path.join(model_dir, "*.safetensors"))) > 0


def _load_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _model_path_skip(model_dir: str, label: str) -> pytest.MarkDecorator | None:
    """Return a skip marker if model weights are missing, else None."""
    if not _weight_file_exists(model_dir):
        return pytest.mark.skip(reason=f"{label} weights not found at {model_dir}")
    return None


# ---------------------------------------------------------------------------
# Helpers: weight loading (mirrors pipeline.py)
# ---------------------------------------------------------------------------

def _load_sharded_weights(model_path: str) -> dict[str, mx.array]:
    """Load weight files from a model directory."""
    import glob
    weights = {}
    index_path = os.path.join(model_path, "model.safetensors.index.json")
    if os.path.exists(index_path):
        with open(index_path) as f:
            index_data = json.load(f)
        shard_files = sorted(set(index_data["weight_map"].values()))
        for shard_file in shard_files:
            sp = os.path.join(model_path, shard_file)
            weights.update(mx.load(sp))
            if hasattr(mx, "clear_cache"):
                mx.clear_cache()
    else:
        single = os.path.join(model_path, "model.safetensors")
        if os.path.exists(single):
            weights = mx.load(single)
        else:
            for f in sorted(glob.glob(os.path.join(model_path, "*.safetensors"))):
                weights.update(mx.load(f))
    return weights


def _cleanup(*objs) -> None:
    """Delete objects, clear MLX cache, and run GC."""
    for o in objs:
        del o
    for _ in range(2):
        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        gc.collect()


# ==========================================================================
# Transformer: ZImageTransformerMLX
# ==========================================================================

TRANSFORMER_SKIP = _model_path_skip(TRANSFORMER_DIR, "Transformer")


class TestTransformerLoads:
    """Verify the ZImageTransformerMLX builds, loads weights, and runs a forward pass."""

    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_transformer_weights_exist(self):
        """Sanity: weight files exist on disk before attempting load."""
        assert _weight_file_exists(TRANSFORMER_DIR), (
            f"No weight files found at {TRANSFORMER_DIR}"
        )

    @pytest.mark.skipif(TRANSFORMER_SKIP is not None, reason="Transformer weights missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_transformer_load_and_fuse(self):
        """Load weights → quantize 4-bit GS32 → fuse QKV → verify fused state."""
        config = _load_json(os.path.join(TRANSFORMER_DIR, "config.json"))

        from app.transformer import ZImageTransformerMLX

        model = ZImageTransformerMLX(config)
        nn.quantize(model, bits=4, group_size=32)

        weights = _load_sharded_weights(TRANSFORMER_DIR)
        model.load_weights(list(weights.items()))
        del weights

        model.fuse_model()
        model.eval()

        # Verify at least one attention layer has fused QKV
        fused = model.layers[0].attention.to_qkv is not None
        msg = "QKV fusion failed: to_qkv is None after fuse_model()"
        assert fused, msg

        _cleanup(model)

    @pytest.mark.skipif(TRANSFORMER_SKIP is not None, reason="Transformer weights missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_transformer_forward_shape(self):
        """Single forward pass: verify output shape and no NaN/Inf."""
        config = _load_json(os.path.join(TRANSFORMER_DIR, "config.json"))
        dim = config["dim"]
        in_channels = config["in_channels"]

        from app.transformer import ZImageTransformerMLX

        model = ZImageTransformerMLX(config)
        nn.quantize(model, bits=4, group_size=32)

        weights = _load_sharded_weights(TRANSFORMER_DIR)
        model.load_weights(list(weights.items()))
        del weights

        model.fuse_model()
        model.eval()

        # Create minimal inputs: 256×256 → latent 32×32 → tokens 16×16
        H_lat, W_lat = 32, 32
        H_tok, W_tok = H_lat // 2, W_lat // 2
        total_len = 16  # short caption embedding

        # x: [1, C, H, W] → reshape to [1, 1, H_tok*W_tok, C*4]
        x = mx.random.normal((1, in_channels, H_lat, W_lat)).astype(mx.bfloat16)
        B, C, H, W = x.shape
        x_packed = x.reshape(C, 1, 1, H_tok, 2, W_tok, 2).transpose(
            1, 2, 3, 5, 4, 6, 0
        ).reshape(1, -1, C * 4)

        # t: timestep
        t = mx.array([0.5]).astype(mx.bfloat16)

        # cap_feats: [1, total_len, cap_feat_dim]
        cap_feat_dim = config.get("cap_feat_dim", 2560)
        cap_feats = mx.random.normal((1, total_len, cap_feat_dim)).astype(mx.bfloat16)

        # positions
        x_pos = mx.zeros((1, x_packed.shape[1], 3)).astype(mx.bfloat16)
        cap_pos = mx.zeros((1, total_len, 3)).astype(mx.bfloat16)

        # RoPE
        unified_pos = mx.concatenate([x_pos, cap_pos], axis=1)
        cos, sin = model.prepare_rope(unified_pos)
        cos = cos.astype(mx.bfloat16)
        sin = sin.astype(mx.bfloat16)

        # Forward
        out = model(x_packed, t, cap_feats, x_pos, cap_pos, cos, sin)
        mx.eval(out)

        # Shape: [1, seq_len, C*4]  (no batch=1 dim at pos 1)
        expected_seq = H_tok * W_tok
        assert out.shape == (1, expected_seq, C * 4), (
            f"Expected (1, {expected_seq}, {C * 4}), got {out.shape}"
        )

        # No NaN/Inf
        out_np = np.array(out.astype(mx.float32))
        assert not np.any(np.isnan(out_np)), "Output contains NaN"
        assert not np.any(np.isinf(out_np)), "Output contains Inf"

        _cleanup(model)


# ==========================================================================
# Text Encoder: TextEncoderMLX
# ==========================================================================

TEXT_ENCODER_SKIP = _model_path_skip(TEXT_ENCODER_DIR, "TextEncoder")


class TestTextEncoderLoads:
    """Verify TextEncoderMLX loads weights and produces correct output shape."""

    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_text_encoder_weights_exist(self):
        assert _weight_file_exists(TEXT_ENCODER_DIR)

    @pytest.mark.skipif(TEXT_ENCODER_SKIP is not None, reason="TextEncoder weights missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_text_encoder_forward_shape(self):
        """Load quantized weights → forward 512 tokens → verify (1, 512, 2560)."""
        config = _load_json(os.path.join(TEXT_ENCODER_DIR, "config.json"))
        hidden_size = config["hidden_size"]

        from app.text_encoder import TextEncoderMLX

        text_encoder = TextEncoderMLX(config)
        nn.quantize(text_encoder, bits=4, group_size=32)

        weight_path = os.path.join(TEXT_ENCODER_DIR, "model.safetensors")
        if os.path.exists(weight_path):
            text_encoder.load_weights(weight_path)
        else:
            weights = _load_sharded_weights(TEXT_ENCODER_DIR)
            text_encoder.load_weights(list(weights.items()))
            del weights

        mx.eval(text_encoder)

        # input_ids: [1, 512]
        input_ids = mx.zeros((1, 512), dtype=mx.int64)

        out = text_encoder(input_ids)
        mx.eval(out)

        assert out.shape == (1, 512, hidden_size), (
            f"Expected (1, 512, {hidden_size}), got {out.shape}"
        )

        out_np = np.array(out.astype(mx.float32))
        assert not np.any(np.isnan(out_np)), "Output contains NaN"
        assert not np.any(np.isinf(out_np)), "Output contains Inf"

        _cleanup(text_encoder)


# ==========================================================================
# Tokenizer
# ==========================================================================

class TestTokenizerLoads:
    """Verify the Qwen tokenizer loads and encodes a prompt."""

    def test_tokenizer_files_exist(self):
        """Check tokenizer config and vocab files."""
        assert os.path.isdir(TOKENIZER_DIR)
        for fname in ("tokenizer_config.json", "tokenizer.json"):
            path = os.path.join(TOKENIZER_DIR, fname)
            assert os.path.isfile(path), f"Missing tokenizer file: {path}"

    def test_tokenizer_encode(self):
        """Load tokenizer → encode a prompt → verify input_ids shape."""
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_DIR, trust_remote_code=True)

        messages = [{"role": "user", "content": "A cat sitting on a chair, oil painting style."}]
        prompt_fmt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = tokenizer(
            prompt_fmt, padding="max_length", max_length=512,
            truncation=True, return_tensors="np",
        )

        assert inputs["input_ids"].shape == (1, 512), (
            f"Expected (1, 512), got {inputs['input_ids'].shape}"
        )
        assert inputs["attention_mask"].shape == (1, 512), (
            f"Expected (1, 512), got {inputs['attention_mask'].shape}"
        )


# ==========================================================================
# VAE (MLX-native, from mflux vendor)
# ==========================================================================

VAE_SKIP = _model_path_skip(VAE_DIR, "VAE (flux-ae)")


class TestVAELoads:
    """Verify MLX-native VAE loads weights and runs encode → decode."""

    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_vae_weights_exist(self):
        assert _weight_file_exists(VAE_DIR)

    @pytest.mark.skipif(VAE_SKIP is not None, reason="VAE weights missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_vae_encode_decode_shapes(self):
        """Load VAE → encode random image → decode → check output shapes."""
        # Ensure vendor mflux is importable
        _mflux_src = os.path.join(
            _PROJECT_DIR, "vendor", "mflux", "src"
        )
        if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
            sys.path.insert(0, _mflux_src)

        from mflux.models.z_image.model.z_image_vae.vae import VAE as ZImageVAE

        vae = ZImageVAE()
        vae.load_weights(os.path.join(VAE_DIR, "model.safetensors"))
        mx.eval(vae.parameters())

        # Create random image: [1, 3, 256, 256] (batch=1, channels=3, H=256, W=256)
        img = mx.random.normal((1, 3, 256, 256)).astype(mx.bfloat16)

        # Encode → (1, 16, 1, 32, 32)
        encoded = vae.encode(img)
        assert encoded.ndim == 5, f"Expected 5D latent, got {encoded.ndim}"
        assert encoded.shape == (1, 16, 1, 32, 32), (
            f"Expected (1, 16, 1, 32, 32), got {encoded.shape}"
        )

        mx.eval(encoded)

        # Decode → (1, 3, 1, 256, 256)
        decoded = vae.decode(encoded)
        assert decoded.ndim == 5, f"Expected 5D output, got {decoded.ndim}"
        assert decoded.shape == (1, 3, 1, 256, 256), (
            f"Expected (1, 3, 1, 256, 256), got {decoded.shape}"
        )

        mx.eval(decoded)

        # Check decoded image pixel range
        decoded_np = np.array(decoded.astype(mx.float32))
        assert not np.any(np.isnan(decoded_np)), "Decoded output contains NaN"
        assert not np.any(np.isinf(decoded_np)), "Decoded output contains Inf"

        _cleanup(vae)


# ==========================================================================
# MLX Environment sanity
# ==========================================================================

class TestMLXEnvironment:
    """Quick checks that MLX sees a Metal GPU."""

    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_mlx_metal_available(self):
        """Verify MLX Metal backend is present and available."""
        assert hasattr(mx, "metal"), "mlx.core.metal not found"
        assert mx.metal.is_available(), "MLX Metal is_available() returned False"

    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_mlx_default_gpu(self):
        """Verify the default device is 'gpu'."""
        default = mx.default_device()
        assert default == mx.gpu, f"Default device is {default}, expected mx.gpu"
