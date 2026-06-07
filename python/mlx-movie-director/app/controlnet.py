"""MLX ControlNet model for Z-Image Turbo (Union 2.0).

Source: https://civitai.com/models/2192289/zimageturbo-controlnet-6g-vram-can-run-it?modelVersionId=2509261

Architecture (295 keys in safetensors):
  control_all_x_embedder["2-1"]  [3840, 132]  — embeds concat(noise[64], ctrl[64], type[4])
  control_noise_refiner[0,1]                  — 2 refinement transformer blocks
  control_layers[0..14]                       — 15 blocks with before_proj + after_proj

The 15 control_layer outputs inject into the main ZImageTransformerMLX layers at stride-2:
  control_layers[i] residual → main transformer layer[2*i]

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
_UNION_DIM = 4
_CONTROL_IN = _EMBED_DIM + _EMBED_DIM + _UNION_DIM  # 132
_T_EMB_DIM = 256               # min(dim, 256) from main transformer
_N_CONTROL_LAYERS = 15
_N_REFINERS = 2


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

    def __call__(self, x, temb, cos, sin):
        """Return (hidden_state, residual)."""
        h = self.before_proj(x)
        h = _block_forward(self, h, temb, cos, sin)
        return h, self.after_proj(h)


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

    def __call__(self, x, temb, cos, sin):
        """Return (hidden_state, residual)."""
        h = _block_forward(self, x, temb, cos, sin)
        return h, self.after_proj(h)


# ---------------------------------------------------------------------------
# Full ControlNet model
# ---------------------------------------------------------------------------

class ZImageControlnet(nn.Module):
    """Z-Image Union ControlNet 2.0 native MLX implementation."""

    def __init__(self):
        super().__init__()
        # Dict key "2-1" → parameter path control_all_x_embedder.2-1.* (matches safetensors)
        # Dict key "2-1" → path control_all_x_embedder.2-1.* (matches safetensors)
        self.control_all_x_embedder = {"2-1": nn.Linear(_CONTROL_IN, _DIM, bias=True)}
        # Index-0 blocks have before_proj; subsequent blocks do not (matches safetensors)
        self.control_noise_refiner = [
            _ControlNetBlockFirst(),
            *[_ControlNetBlockRest() for _ in range(_N_REFINERS - 1)],
        ]
        self.control_layers = [
            _ControlNetBlockFirst(),
            *[_ControlNetBlockRest() for _ in range(_N_CONTROL_LAYERS - 1)],
        ]

    def __call__(
        self,
        x_raw: mx.array,       # [1, N_padded, 64]  patchified noise latent
        ctrl_raw: mx.array,    # [1, N_padded, 64]  patchified control latent
        union_type: int,        # 0=pose 1=depth 2=canny 3=hed 4=scribble
        temb: mx.array,         # [1, 256]  time embedding from main transformer
        cos: mx.array,          # [1, N_padded, 1, 64]  rope cos (image token slice)
        sin: mx.array,          # [1, N_padded, 1, 64]  rope sin (image token slice)
        strength: float = 1.0,
    ) -> list:
        """Return list of 15 residual tensors [1, N_padded, 3840] scaled by strength."""
        B, N, _ = x_raw.shape

        # One-hot union type vector, broadcast to [B, N, 4]
        idx = union_type % _UNION_DIM
        type_onehot = mx.array(
            [1.0 if i == idx else 0.0 for i in range(_UNION_DIM)],
            dtype=x_raw.dtype,
        )
        type_vec = mx.broadcast_to(type_onehot[None, None, :], (B, N, _UNION_DIM))

        # Embed: [B, N, 64+64+4] → [B, N, 3840]
        combined = mx.concatenate([x_raw, ctrl_raw, type_vec], axis=-1)
        x = self.control_all_x_embedder["2-1"](combined)

        # Noise refiners: advance hidden state, discard residuals
        for block in self.control_noise_refiner:
            x, _ = block(x, temb, cos, sin)

        # Control layers: collect residuals for injection into main transformer
        residuals = []
        for block in self.control_layers:
            x, residual = block(x, temb, cos, sin)
            residuals.append(residual * strength)

        return residuals   # 15 × [1, N_padded, 3840]


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
# Patchification helper (mirrors ZImagePipeline.generate() step_fn logic)
# ---------------------------------------------------------------------------

def patchify_latent(latent: mx.array) -> mx.array:
    """Patchify latent [1, C, H, W] → patches [1, H_tok*W_tok, C*4].

    Matches the reshape in pipeline.py step_fn so that N_patches is the same
    for noise and control latents (both must have the same H, W before calling).
    """
    B, C, H, W = latent.shape
    # Delegate to single-batch version for consistency with step_fn
    x = latent[0]                       # [C, H, W]
    H_tok, W_tok = H // 2, W // 2
    x = x.reshape(C, 1, 1, H_tok, 2, W_tok, 2)
    x = x.transpose(1, 2, 3, 5, 4, 6, 0)   # [1, 1, H_tok, W_tok, 2, 2, C]
    x = x.reshape(1, H_tok * W_tok, C * 4)  # [1, N, 64]
    return x
