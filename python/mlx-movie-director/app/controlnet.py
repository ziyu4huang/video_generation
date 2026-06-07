"""MLX ControlNet model for Z-Image Turbo Fun Union 2.0.

Source: https://civitai.com/models/2192289/zimageturbo-controlnet-6g-vram-can-run-it?modelVersionId=2509261

Architecture (295 keys in safetensors):
  control_all_x_embedder["2-1"]  [3840, 132]  — embeds 33-ch control image patches
  control_noise_refiner[0,1]                  — 2 refinement transformer blocks
  control_layers[0..14]                       — 15 blocks with before_proj + after_proj

The 15 control_layer outputs inject into the main ZImageTransformerMLX layers at stride-2:
  control_layers[i] residual → main transformer layer[2*i]

** IMPORTANT **: This model uses the "broken" variant where all noise refiner after_proj
weights are zero. The control blocks run interleaved with the main model's forward pass,
receiving the main model's hidden state at each injection point.

The input to control_all_x_embedder is a 33-channel patchified image:
  [control_latent(16), mask(1), inpaint_latent(16)]
For non-inpaint use: mask=zeros, inpaint_latent=VAE(gray_image).

Module attribute names mirror safetensors key paths exactly to enable direct weight loading.
"""

import os
import sys

import mlx.core as mx
import mlx.nn as nn


_DIM = 3840
_N_HEADS = 30
_HEAD_DIM = _DIM // _N_HEADS   # 128
_HIDDEN = int(_DIM / 3 * 8)    # 10240
_EMBED_DIM = 64                 # patch_size^2 * channels = 2^2 * 16
_ADDITIONAL_DIM = 17            # mask(1*4) + inpaint(16*4) = 4 + 64 = 68 → 17 channels
_CONTROL_IN_CH = 33             # 16 + 1 + 16 = 33 channels
_CONTROL_IN_DIM = _CONTROL_IN_CH * 4  # 132 = 33 * 4 (after patchification)
_T_EMB_DIM = 256               # min(dim, 256) from main transformer
_N_CONTROL_LAYERS = 15
_N_REFINERS = 2

# Flux latent format constants (ZImage inherits Lumina2 → Flux latent format)
# Matches ComfyUI latent_formats.Flux: process_in(latent) = (latent - shift) * scale
_FLUX_SHIFT_FACTOR = 0.1159
_FLUX_SCALE_FACTOR = 0.3611


# ---------------------------------------------------------------------------
# Sub-modules (attribute names match safetensors key structure)
# ---------------------------------------------------------------------------

class _ControlNetAttention(nn.Module):
    def __init__(self):
        super().__init__()
        self.to_q = nn.Linear(_DIM, _DIM, bias=False)
        self.to_k = nn.Linear(_DIM, _DIM, bias=False)
        self.to_v = nn.Linear(_DIM, _DIM, bias=False)
        # List → parameter name is attention.to_out.0.* matching safetensors keys
        self.to_out = [nn.Linear(_DIM, _DIM, bias=False)]
        self.norm_q = nn.RMSNorm(_HEAD_DIM, eps=1e-5)
        self.norm_k = nn.RMSNorm(_HEAD_DIM, eps=1e-5)
        self.scale = _HEAD_DIM ** -0.5

    def __call__(self, x, cos, sin):
        B, L, D = x.shape
        q = self.to_q(x).reshape(B, L, _N_HEADS, _HEAD_DIM)
        k = self.to_k(x).reshape(B, L, _N_HEADS, _HEAD_DIM)
        v = self.to_v(x).reshape(B, L, _N_HEADS, _HEAD_DIM)
        q = self.norm_q(q)
        k = self.norm_k(k)
        if cos is not None and sin is not None:
            q1, q2 = q[..., 0::2], q[..., 1::2]
            q = mx.stack([q1 * cos - q2 * sin, q1 * sin + q2 * cos], axis=-1).reshape(B, L, _N_HEADS, _HEAD_DIM)
            k1, k2 = k[..., 0::2], k[..., 1::2]
            k = mx.stack([k1 * cos - k2 * sin, k1 * sin + k2 * cos], axis=-1).reshape(B, L, _N_HEADS, _HEAD_DIM)
        q = q.transpose(0, 2, 1, 3)
        k = k.transpose(0, 2, 1, 3)
        v = v.transpose(0, 2, 1, 3)
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.scale, mask=None)
        out = out.transpose(0, 2, 1, 3).reshape(B, L, D)
        return self.to_out[0](out)


class _ControlNetFeedForward(nn.Module):
    def __init__(self):
        super().__init__()
        self.w1 = nn.Linear(_DIM, _HIDDEN, bias=False)
        self.w2 = nn.Linear(_HIDDEN, _DIM, bias=False)
        self.w3 = nn.Linear(_DIM, _HIDDEN, bias=False)

    def __call__(self, x):
        return self.w2(nn.silu(self.w1(x)) * self.w3(x))


def _block_forward(block, x, temb, cos, sin):
    """Shared attention+FFN+modulation forward used by all control blocks."""
    chunks = block.adaLN_modulation[0](temb)
    scale_msa, gate_msa, scale_mlp, gate_mlp = mx.split(chunks, 4, axis=-1)
    scale_msa = (1.0 + scale_msa)[:, None, :]
    scale_mlp = (1.0 + scale_mlp)[:, None, :]
    gate_msa = mx.tanh(gate_msa)[:, None, :]
    gate_mlp = mx.tanh(gate_mlp)[:, None, :]
    attn_out = block.attention(block.attention_norm1(x) * scale_msa, cos, sin)
    x = x + gate_msa * block.attention_norm2(attn_out)
    ffn_out = block.feed_forward(block.ffn_norm1(x) * scale_mlp)
    x = x + gate_mlp * block.ffn_norm2(ffn_out)
    return x


class _ControlNetBlockFirst(nn.Module):
    """Index-0 block — has before_proj AND after_proj (matches safetensors key structure)."""
    def __init__(self):
        super().__init__()
        self.adaLN_modulation = [nn.Linear(_T_EMB_DIM, 4 * _DIM, bias=True)]
        self.attention = _ControlNetAttention()
        self.feed_forward = _ControlNetFeedForward()
        self.attention_norm1 = nn.RMSNorm(_DIM, eps=1e-5)
        self.attention_norm2 = nn.RMSNorm(_DIM, eps=1e-5)
        self.ffn_norm1 = nn.RMSNorm(_DIM, eps=1e-5)
        self.ffn_norm2 = nn.RMSNorm(_DIM, eps=1e-5)
        self.before_proj = nn.Linear(_DIM, _DIM, bias=True)
        self.after_proj = nn.Linear(_DIM, _DIM, bias=True)

    def __call__(self, control_context, main_hidden, temb, cos, sin):
        """Run control block with main model's hidden state.

        Args:
            control_context: [1, N, 3840] running control context
            main_hidden: [1, N, 3840] main model's hidden state at this layer
            temb: [1, 256] time embedding
            cos/sin: RoPE embeddings

        Returns:
            (residual, updated_control_context)
        """
        # At block 0: project control context and ADD main model's hidden state
        h = self.before_proj(control_context) + main_hidden
        h = _block_forward(self, h, temb, cos, sin)
        return self.after_proj(h), h


class _ControlNetBlockRest(nn.Module):
    """Index > 0 block — has only after_proj, NO before_proj (matches safetensors key structure)."""
    def __init__(self):
        super().__init__()
        self.adaLN_modulation = [nn.Linear(_T_EMB_DIM, 4 * _DIM, bias=True)]
        self.attention = _ControlNetAttention()
        self.feed_forward = _ControlNetFeedForward()
        self.attention_norm1 = nn.RMSNorm(_DIM, eps=1e-5)
        self.attention_norm2 = nn.RMSNorm(_DIM, eps=1e-5)
        self.ffn_norm1 = nn.RMSNorm(_DIM, eps=1e-5)
        self.ffn_norm2 = nn.RMSNorm(_DIM, eps=1e-5)
        self.after_proj = nn.Linear(_DIM, _DIM, bias=True)

    def __call__(self, control_context, main_hidden, temb, cos, sin):
        """Run control block. Main hidden state is NOT added (only at block 0)."""
        h = _block_forward(self, control_context, temb, cos, sin)
        return self.after_proj(h), h


# ---------------------------------------------------------------------------
# Full ControlNet model
# ---------------------------------------------------------------------------

class ZImageControlnet(nn.Module):
    """Z-Image Union ControlNet 2.0 native MLX implementation.

    Supports interleaved execution where control blocks receive the main
    model's hidden state at each injection point.
    """

    def __init__(self):
        super().__init__()
        # Dict key "2-1" → parameter path control_all_x_embedder.2-1.* (matches safetensors)
        self.control_all_x_embedder = {"2-1": nn.Linear(_CONTROL_IN_DIM, _DIM, bias=True)}
        # Noise refiners: block 0 has before_proj (matches safetensors structure)
        self.control_noise_refiner = [
            _ControlNetBlockFirst(),
            *[_ControlNetBlockRest() for _ in range(_N_REFINERS - 1)],
        ]
        self.control_layers = [
            _ControlNetBlockFirst(),
            *[_ControlNetBlockRest() for _ in range(_N_CONTROL_LAYERS - 1)],
        ]

    def embed_control(self, control_image_33ch: mx.array) -> mx.array:
        """Embed the 33-channel control image into the ControlNet's hidden space.

        Args:
            control_image_33ch: [1, 33, H, W] concatenated control+mask+inpaint latents

        Returns:
            [1, N_patches, 3840] embedded control context
        """
        B, C, H, W = control_image_33ch.shape
        patch_size = 2
        pH = pW = patch_size
        # Patchify: [1, 33, H, W] → [1, H//2 * W//2, 33*4=132]
        x = control_image_33ch.reshape(B, C, H // pH, pH, W // pW, pW)
        x = x.transpose(0, 2, 4, 3, 5, 1)  # [B, H_tok, W_tok, pH, pW, C]
        x = x.reshape(B, (H // pH) * (W // pW), C * pH * pW)  # [B, N, 132]
        return self.control_all_x_embedder["2-1"](x)  # [B, N, 3840]

    def forward_noise_refiner(self, layer_id, control_context, main_hidden,
                               temb, cos, sin):
        """Run one noise refiner control block.

        For the 'broken' variant (our model): noise refiner after_proj weights are zero,
        so we redirect to the control_layers instead.

        Args:
            layer_id: 0 or 1 (noise refiner index)
            control_context: running control context [1, N, 3840]
            main_hidden: main model's hidden state [1, N, 3840]
            temb: time embedding [1, 256]
            cos/sin: RoPE [1, N, 1, 64]

        Returns:
            (residual_or_None, updated_control_context)
        """
        # Our model is "broken" — noise refiner after_proj weights are all zeros.
        # ComfyUI redirects: layer_id=0 → control_layers[0], layer_id=1 → control_layers[1..14]
        if layer_id == 0:
            residual, ctx = self.control_layers[0](
                control_context, main_hidden, temb, cos, sin)
            return residual, ctx
        else:
            # Run all remaining control layers (1..14)
            # Only keep the FIRST residual (from layer 1)
            first_residual = None
            ctx = control_context
            for i in range(1, len(self.control_layers)):
                residual, ctx = self.control_layers[i](
                    ctx, main_hidden, temb, cos, sin)
                if first_residual is None:
                    first_residual = residual
            return first_residual, ctx


# ---------------------------------------------------------------------------
# Weight loader
# ---------------------------------------------------------------------------

def load_controlnet(model_dir: str) -> ZImageControlnet:
    """Load ZImageControlnet weights from model_dir/model.safetensors."""
    model_path = os.path.join(model_dir, "model.safetensors")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"ControlNet weights not found: {model_path}")

    print(f"[ControlNet] Loading {os.path.getsize(model_path) // 1_000_000} MB from {model_path}...", end=" ", flush=True)
    weights = mx.load(model_path)
    print(f"({len(weights)} tensors)", flush=True)

    model = ZImageControlnet()
    model.load_weights(list(weights.items()))
    mx.eval(model.parameters())
    print("[ControlNet] Ready.")
    return model


# ---------------------------------------------------------------------------
# Patchification helpers
# ---------------------------------------------------------------------------

def patchify_latent(latent: mx.array) -> mx.array:
    """Patchify latent [1, C, H, W] → patches [1, H_tok*W_tok, C*4].

    Matches the reshape in pipeline.py step_fn so that N_patches is the same
    for noise and control latents (both must have the same H, W before calling).
    """
    B, C, H, W = latent.shape
    x = latent[0]                       # [C, H, W]
    H_tok, W_tok = H // 2, W // 2
    x = x.reshape(C, 1, 1, H_tok, 2, W_tok, 2)
    x = x.transpose(1, 2, 3, 5, 4, 6, 0)   # [1, 1, H_tok, W_tok, 2, 2, C]
    x = x.reshape(1, H_tok * W_tok, C * 4)  # [1, N, 64]
    return x


def build_control_input_33ch(ctrl_latent: mx.array, vae_encode_fn) -> mx.array:
    """Build the 33-channel control input for the ControlNet embedder.

    Channels: [control_latent(16), mask(1), inpaint_latent(16)]
    For non-inpaint use: mask = zeros, inpaint = VAE(gray image).

    Args:
        ctrl_latent: [1, 16, H, W] VAE-encoded control image
        vae_encode_fn: callable that takes a PIL Image and returns [1, 16, H, W] latent

    Returns:
        [1, 33, H, W] concatenated control input
    """
    import numpy as np
    from PIL import Image

    _, _, H, W = ctrl_latent.shape

    # Create gray image and encode it for the inpaint channel
    gray_img = Image.fromarray(
        (np.ones((H * 8, W * 8, 3), dtype=np.uint8) * 127).astype("uint8")
    )
    inpaint_latent = vae_encode_fn(gray_img)  # [1, 16, H, W]
    inpaint_latent = (inpaint_latent - _FLUX_SHIFT_FACTOR) * _FLUX_SCALE_FACTOR

    # Zero mask for non-inpaint mode
    mask = mx.zeros((1, 1, H, W)).astype(ctrl_latent.dtype)

    return mx.concatenate([ctrl_latent, mask, inpaint_latent], axis=1)  # [1, 33, H, W]
