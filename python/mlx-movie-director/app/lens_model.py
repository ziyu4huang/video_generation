"""MLX implementation of Microsoft Lens 3.8B dual-stream MMDiT.

Architecture matches ComfyUI/comfy/ldm/lens/model.py (LensTransformer2DModel).
Key names are kept identical to the PyTorch reference, so conversion from
lens_bf16.safetensors requires no key remapping beyond dtype conversion.

Spec:
    48 transformer blocks, inner_dim = 24 heads × 64 = 1536
    enc_hidden_dim = 2880  (GPT-OSS-20B features, 4 selected layers stacked)
    in_channels = 128 latents (Flux2 VAE), patch_size = 2
"""

from __future__ import annotations

import math
import re
from typing import Optional

import mlx.core as mx
import mlx.nn as mnn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sinusoidal_embed(t: mx.array, dim: int = 256) -> mx.array:
    """Timestep → sinusoidal embedding (matches comfy ldm.flux.layers.timestep_embedding)."""
    assert dim % 2 == 0
    half = dim // 2
    freqs = mx.exp(-math.log(10000) * mx.arange(half, dtype=mx.float32) / half)
    args = t[:, None].astype(mx.float32) * freqs[None]
    return mx.concatenate([mx.cos(args), mx.sin(args)], axis=-1)


def _lens_position_ids(
    frame: int, height: int, width: int, text_seq_len: int,
    scale_rope: bool = True,
) -> mx.array:
    """Axial (frame, h, w) position IDs for joint image+text sequence.

    Returns shape [seq, 3]; caller adds batch dim for EmbedND.
    """
    if scale_rope:
        h_half = height // 2
        w_half = width // 2
        h_pos = mx.concatenate([mx.arange(-(height - h_half), 0), mx.arange(0, h_half)])
        w_pos = mx.concatenate([mx.arange(-(width - w_half), 0), mx.arange(0, w_half)])
        text_start = max(h_half, w_half)
    else:
        h_pos = mx.arange(height)
        w_pos = mx.arange(width)
        text_start = max(height, width)

    f_pos = mx.arange(frame)

    # img_ids: [frame, height, width, 3]
    img_ids = mx.zeros((frame, height, width, 3), dtype=mx.float32)
    img_ids = img_ids.at[:, :, :, 0].add(f_pos[:, None, None])
    img_ids = img_ids.at[:, :, :, 1].add(h_pos[None, :, None])
    img_ids = img_ids.at[:, :, :, 2].add(w_pos[None, None, :])
    img_ids = img_ids.reshape(-1, 3)

    txt_pos = mx.arange(text_start, text_start + text_seq_len, dtype=mx.float32)
    txt_ids = mx.broadcast_to(txt_pos[:, None], (text_seq_len, 3))

    return mx.concatenate([img_ids, txt_ids], axis=0)


def _apply_rope(q: mx.array, k: mx.array, freqs: mx.array) -> tuple[mx.array, mx.array]:
    """Rotary positional embedding. q/k: [B, H, S, D], freqs: [1, 1, S, D]."""
    cos, sin = freqs[..., : freqs.shape[-1] // 2], freqs[..., freqs.shape[-1] // 2 :]
    # Split head dim in half for rotation
    q1, q2 = q[..., : q.shape[-1] // 2], q[..., q.shape[-1] // 2 :]
    k1, k2 = k[..., : k.shape[-1] // 2], k[..., k.shape[-1] // 2 :]
    q_rot = mx.concatenate([q1 * cos - q2 * sin, q1 * sin + q2 * cos], axis=-1)
    k_rot = mx.concatenate([k1 * cos - k2 * sin, k1 * sin + k2 * cos], axis=-1)
    return q_rot, k_rot


# ---------------------------------------------------------------------------
# RoPE embedding (EmbedND equivalent for axial 3D positions)
# ---------------------------------------------------------------------------

class EmbedND(mnn.Module):
    """Multi-axis RoPE embedding (EmbedND from Flux).

    axes_dim: list of per-axis embedding dimensions (sum = head_dim).
    """

    def __init__(self, dim: int, theta: float, axes_dim: list[int]) -> None:
        super().__init__()
        self.dim = dim
        self.theta = theta
        self.axes_dim = axes_dim

    def __call__(self, ids: mx.array) -> mx.array:
        """ids: [B, S, N_axes] → freqs [B, 1, S, dim]."""
        embs = []
        for i, ax_dim in enumerate(self.axes_dim):
            embs.append(self._rope_1d(ids[..., i], ax_dim))
        # Concatenate along last axis → [B, 1, S, dim]
        return mx.concatenate(embs, axis=-1)

    def _rope_1d(self, pos: mx.array, dim: int) -> mx.array:
        """pos: [B, S] → freqs [B, 1, S, dim] with cos/sin interleaved."""
        half = dim // 2
        freqs = 1.0 / (self.theta ** (mx.arange(half, dtype=mx.float32) / half))
        # [B, S, half]
        angles = pos[..., None].astype(mx.float32) * freqs[None, None]
        cos = mx.cos(angles)
        sin = mx.sin(angles)
        # Interleave: [B, S, dim] where dim = [cos0, sin0, cos1, sin1, ...]
        rope = mx.concatenate([cos, sin], axis=-1)
        return rope[:, None]  # [B, 1, S, dim]


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------

class GateMLP(mnn.Module):
    """SwiGLU MLP (matches GateMLP in PyTorch reference)."""

    def __init__(self, dim: int, hidden_dim: int) -> None:
        super().__init__()
        self.w1 = mnn.Linear(dim, hidden_dim, bias=False)
        self.w2 = mnn.Linear(hidden_dim, dim, bias=False)
        self.w3 = mnn.Linear(dim, hidden_dim, bias=False)

    def __call__(self, x: mx.array) -> mx.array:
        return self.w2(mnn.silu(self.w1(x)) * self.w3(x))


class LensJointAttention(mnn.Module):
    """Joint image+text attention with fused QKV per stream."""

    def __init__(
        self,
        query_dim: int,
        added_kv_proj_dim: int,
        dim_head: int = 64,
        heads: int = 8,
        out_dim: Optional[int] = None,
        eps: float = 1e-5,
    ) -> None:
        super().__init__()
        self.inner_dim = (out_dim if out_dim is not None else dim_head * heads)
        self.heads = self.inner_dim // dim_head
        self.dim_head = dim_head
        out_dim = out_dim if out_dim is not None else query_dim

        self.norm_q = mnn.RMSNorm(dim_head, eps=eps)
        self.norm_k = mnn.RMSNorm(dim_head, eps=eps)
        self.norm_added_q = mnn.RMSNorm(dim_head, eps=eps)
        self.norm_added_k = mnn.RMSNorm(dim_head, eps=eps)

        self.img_qkv = mnn.Linear(query_dim, 3 * self.inner_dim, bias=True)
        self.txt_qkv = mnn.Linear(added_kv_proj_dim, 3 * self.inner_dim, bias=True)

        # In PyTorch: to_out = ModuleList([Linear, Identity]) → key to_out.0.*
        # We store as plain Linear; from_pretrained remaps to_out.0.* → to_out.*
        self.to_out = mnn.Linear(self.inner_dim, out_dim, bias=True)
        self.to_add_out = mnn.Linear(self.inner_dim, query_dim, bias=True)

    def __call__(
        self,
        hidden_states: mx.array,
        encoder_hidden_states: mx.array,
        freqs_cis: mx.array,
        attention_mask: Optional[mx.array] = None,
    ) -> tuple[mx.array, mx.array]:
        B, seq_img, _ = hidden_states.shape
        seq_txt = encoder_hidden_states.shape[1]
        H, D = self.heads, self.dim_head

        # Image stream QKV
        img_qkv = self.img_qkv(hidden_states).reshape(B, seq_img, 3, H, D)
        img_q, img_k, img_v = img_qkv[:, :, 0], img_qkv[:, :, 1], img_qkv[:, :, 2]
        img_q = self.norm_q(img_q)
        img_k = self.norm_k(img_k)

        # Text stream QKV
        txt_qkv = self.txt_qkv(encoder_hidden_states).reshape(B, seq_txt, 3, H, D)
        txt_q, txt_k, txt_v = txt_qkv[:, :, 0], txt_qkv[:, :, 1], txt_qkv[:, :, 2]
        txt_q = self.norm_added_q(txt_q)
        txt_k = self.norm_added_k(txt_k)

        # Concat and transpose → [B, H, S, D]
        q = mx.concatenate([img_q, txt_q], axis=1).transpose(0, 2, 1, 3)
        k = mx.concatenate([img_k, txt_k], axis=1).transpose(0, 2, 1, 3)
        v = mx.concatenate([img_v, txt_v], axis=1).transpose(0, 2, 1, 3)

        q, k = _apply_rope(q, k, freqs_cis)

        # SDPA
        scale = 1.0 / math.sqrt(D)
        attn = mx.einsum("bhsd,bhtd->bhst", q * scale, k)
        if attention_mask is not None:
            attn = attn + attention_mask
        attn = mx.softmax(attn.astype(mx.float32), axis=-1).astype(q.dtype)
        out = mx.einsum("bhst,bhtd->bhsd", attn, v)

        # [B, H, S, D] → [B, S, H*D]
        out = out.transpose(0, 2, 1, 3).reshape(B, seq_img + seq_txt, self.inner_dim)

        img_out = self.to_out(out[:, :seq_img])
        txt_out = self.to_add_out(out[:, seq_img:])
        return img_out, txt_out


class LensTransformerBlock(mnn.Module):
    """Dual-stream DiT block (one of 48 in the full Lens model).

    Key remapping vs PyTorch state-dict (done in LensTransformer.from_pretrained):
        img_mod.1.weight  →  img_mod.weight    (PyTorch: Sequential(SiLU, Linear))
        img_mod.1.bias    →  img_mod.bias
        txt_mod.1.weight  →  txt_mod.weight
        txt_mod.1.bias    →  txt_mod.bias
        attn.to_out.0.weight → attn.to_out.weight   (PyTorch: ModuleList([Linear]))
        attn.to_out.0.bias   → attn.to_out.bias
    """

    def __init__(self, dim: int, num_heads: int, head_dim: int, eps: float = 1e-6) -> None:
        super().__init__()
        mlp_hidden = int(dim / 3 * 8)

        self.attn = LensJointAttention(
            query_dim=dim, added_kv_proj_dim=dim,
            dim_head=head_dim, heads=num_heads, out_dim=dim, eps=1e-5,
        )

        # img_mod: PyTorch Sequential(SiLU, Linear) → stored as plain Linear here;
        # SiLU is applied in __call__ before passing to this linear.
        self.img_mod = mnn.Linear(dim, 6 * dim, bias=True)
        self.img_norm1 = mnn.RMSNorm(dim, eps=eps)
        self.img_norm2 = mnn.RMSNorm(dim, eps=eps)
        self.img_mlp = GateMLP(dim, mlp_hidden)

        self.txt_mod = mnn.Linear(dim, 6 * dim, bias=True)
        self.txt_norm1 = mnn.RMSNorm(dim, eps=eps)
        self.txt_norm2 = mnn.RMSNorm(dim, eps=eps)
        self.txt_mlp = GateMLP(dim, mlp_hidden)

    def __call__(
        self,
        hidden_states: mx.array,
        encoder_hidden_states: mx.array,
        temb: mx.array,
        freqs_cis: mx.array,
        attention_mask: Optional[mx.array] = None,
    ) -> tuple[mx.array, mx.array]:
        # SiLU before Linear (mirrors PyTorch Sequential(SiLU(), Linear()))
        img_mod = self.img_mod(mnn.silu(temb))
        txt_mod = self.txt_mod(mnn.silu(temb))

        img_mod1, img_mod2 = mx.split(img_mod, 2, axis=-1)
        txt_mod1, txt_mod2 = mx.split(txt_mod, 2, axis=-1)

        img_m, img_g1 = self._modulate(self.img_norm1(hidden_states), img_mod1)
        txt_m, txt_g1 = self._modulate(self.txt_norm1(encoder_hidden_states), txt_mod1)

        img_attn, txt_attn = self.attn(img_m, txt_m, freqs_cis, attention_mask)

        hidden_states = hidden_states + img_g1 * img_attn
        encoder_hidden_states = encoder_hidden_states + txt_g1 * txt_attn

        img_m2, img_g2 = self._modulate(self.img_norm2(hidden_states), img_mod2)
        hidden_states = hidden_states + img_g2 * self.img_mlp(img_m2)

        txt_m2, txt_g2 = self._modulate(self.txt_norm2(encoder_hidden_states), txt_mod2)
        encoder_hidden_states = encoder_hidden_states + txt_g2 * self.txt_mlp(txt_m2)

        return encoder_hidden_states, hidden_states

    @staticmethod
    def _modulate(x: mx.array, mod: mx.array) -> tuple[mx.array, mx.array]:
        shift, scale, gate = mx.split(mod, 3, axis=-1)
        return x * (1 + scale[:, None]) + shift[:, None], gate[:, None]


class AdaLayerNormContinuous(mnn.Module):
    """AdaLayerNormContinuous(elementwise_affine=False).

    scale, shift = chunk(2) [scale first — matches PyTorch reference].
    """

    def __init__(self, embedding_dim: int, conditioning_dim: int, eps: float = 1e-6) -> None:
        super().__init__()
        self.linear = mnn.Linear(conditioning_dim, embedding_dim * 2, bias=True)
        self.eps = eps
        self.embedding_dim = embedding_dim

    def __call__(self, x: mx.array, conditioning: mx.array) -> mx.array:
        emb = self.linear(mnn.silu(conditioning))
        scale, shift = mx.split(emb, 2, axis=-1)
        # layer_norm without affine
        mean = x.mean(axis=-1, keepdims=True)
        var = ((x - mean) ** 2).mean(axis=-1, keepdims=True)
        x = (x - mean) / mx.sqrt(var + self.eps)
        return x * (1 + scale[:, None]) + shift[:, None]


class TimestepEmbedder(mnn.Module):
    def __init__(self, in_channels: int, embed_dim: int) -> None:
        super().__init__()
        self.linear_1 = mnn.Linear(in_channels, embed_dim)
        self.linear_2 = mnn.Linear(embed_dim, embed_dim)

    def __call__(self, x: mx.array) -> mx.array:
        return self.linear_2(mnn.silu(self.linear_1(x)))


class LensTimestepProjEmbeddings(mnn.Module):
    """Matches LensTimestepProjEmbeddings in PyTorch: keys timestep_embedder.*."""

    def __init__(self, embedding_dim: int) -> None:
        super().__init__()
        self.timestep_embedder = TimestepEmbedder(256, embedding_dim)

    def __call__(self, timestep: mx.array, ref_dtype) -> mx.array:
        proj = _sinusoidal_embed(timestep, 256).astype(ref_dtype)
        return self.timestep_embedder(proj)


# ---------------------------------------------------------------------------
# Top-level model
# ---------------------------------------------------------------------------

class LensTransformer(mnn.Module):
    """Lens 3.8B dual-stream MMDiT.

    Default config (from ComfyUI supported_models.py / model_detection.py):
        num_layers = 48
        num_attention_heads = 24
        attention_head_dim = 64
        inner_dim = 24 * 64 = 1536
        enc_hidden_dim = 2880  (GPT-OSS features per selected layer)
        in_channels = 128  (Flux2 VAE latent channels)
        out_channels = 32  (matches Flux2 VAE latent)
        multi_layer_encoder_feature = True
        selected_layer_index = (5, 11, 17, 23)  → L=4 layers stacked → context dim = 4*2880
    """

    def __init__(
        self,
        patch_size: int = 2,
        in_channels: int = 128,
        out_channels: int = 32,
        num_layers: int = 48,
        attention_head_dim: int = 64,
        num_attention_heads: int = 24,
        enc_hidden_dim: int = 2880,
        axes_dims_rope: tuple[int, int, int] = (8, 28, 28),
        num_selected_layers: int = 4,
    ) -> None:
        super().__init__()
        self.inner_dim = num_attention_heads * attention_head_dim
        self.patch_size = patch_size
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.num_selected_layers = num_selected_layers

        self.pos_embed = EmbedND(dim=attention_head_dim, theta=10000, axes_dim=list(axes_dims_rope))
        self.time_text_embed = LensTimestepProjEmbeddings(self.inner_dim)

        # Multi-layer text norm: ModuleList of 4 RMSNorm
        self.txt_norm = [mnn.RMSNorm(enc_hidden_dim, eps=1e-5) for _ in range(num_selected_layers)]
        self.txt_in = mnn.Linear(enc_hidden_dim * num_selected_layers, self.inner_dim, bias=True)
        self.img_in = mnn.Linear(in_channels, self.inner_dim, bias=True)

        self.transformer_blocks = [
            LensTransformerBlock(
                dim=self.inner_dim,
                num_heads=num_attention_heads,
                head_dim=attention_head_dim,
                eps=1e-6,
            )
            for _ in range(num_layers)
        ]

        self.norm_out = AdaLayerNormContinuous(self.inner_dim, self.inner_dim, eps=1e-6)
        self.proj_out = mnn.Linear(
            self.inner_dim, patch_size * patch_size * out_channels, bias=True
        )

    def __call__(
        self,
        x: mx.array,
        timestep: mx.array,
        context: mx.array,
        attention_mask: Optional[mx.array] = None,
    ) -> mx.array:
        """
        Args:
            x: [B, in_channels, H, W] image latents
            timestep: [B] timesteps
            context: [B, seq, L*enc_hidden_dim] stacked text features
            attention_mask: [B, seq] boolean mask over text tokens
        Returns:
            [B, out_channels, H, W] denoised latents
        """
        B, C, H, W = x.shape

        # Patchify: [B, C, H, W] → [B, H*W, C]
        hidden = x.transpose(0, 2, 3, 1).reshape(B, H * W, C)

        # Unstack text features: context [B, S, L*H] → list of [B, S, H]
        L = self.num_selected_layers
        enc_dim = context.shape[-1] // L
        ctx_list = mx.split(context.reshape(B, -1, L, enc_dim), L, axis=2)
        ctx_list = [c.squeeze(2) for c in ctx_list]
        text_seq_len = ctx_list[0].shape[1]

        # Build attention mask for text
        if attention_mask is None:
            attention_mask = mx.ones((B, text_seq_len), dtype=mx.bool_)

        # Build joint additive mask [B, 1, 1, img_len + text_len]
        img_len = H * W
        img_ones = mx.ones((B, img_len), dtype=mx.bool_)
        joint = mx.concatenate([img_ones, attention_mask], axis=1)
        neg_inf = mx.full((1,), float("-inf"), dtype=mx.float32)
        additive = mx.where(joint[:, None, None, :], mx.zeros_like(neg_inf), neg_inf)

        # Image projection
        hidden = self.img_in(hidden)
        timestep = timestep.astype(hidden.dtype)

        # Text projection (multi-layer norm + concat)
        normed = [self.txt_norm[i](ctx_list[i]) for i in range(L)]
        enc_states = self.txt_in(mx.concatenate(normed, axis=-1))

        # Timestep embedding
        temb = self.time_text_embed(timestep, hidden.dtype)

        # RoPE positions
        ids = _lens_position_ids(1, H, W, text_seq_len)[None]  # [1, S, 3]
        freqs_cis = self.pos_embed(ids)  # [1, 1, S, head_dim]

        # Transformer blocks
        for block in self.transformer_blocks:
            enc_states, hidden = block(hidden, enc_states, temb, freqs_cis, additive)

        # Final norm + project
        hidden = self.norm_out(hidden, temb)
        out = self.proj_out(hidden)

        # Unpatchify: [B, H*W, patch²*C_out] → [B, C_out, H, W]
        p = self.patch_size
        out = out.reshape(B, H, W, p, p, self.out_channels)
        out = out.transpose(0, 5, 1, 3, 2, 4).reshape(B, self.out_channels, H * p, W * p)
        return out

    @classmethod
    def from_pretrained(cls, weights_path: str, **kwargs) -> "LensTransformer":
        """Load from a BF16 or INT4/INT8 safetensors file.

        Remaps PyTorch Sequential/ModuleList numeric-index keys:
            *.img_mod.1.{weight,bias}     →  *.img_mod.{weight,bias}
            *.txt_mod.1.{weight,bias}     →  *.txt_mod.{weight,bias}
            *.attn.to_out.0.{weight,bias} →  *.attn.to_out.{weight,bias}

        Auto-detects INT4/INT8 quantized format (*.scales keys) and pre-quantizes
        the model structure before loading so QuantizedLinear accepts scales/biases.
        """
        model = cls(**kwargs)

        # Detect quantized format: mx.load returns (arrays, metadata) with return_metadata=True
        arrays, _ = mx.load(weights_path, return_metadata=True)
        is_quantized = any(k.endswith(".scales") for k in arrays)

        if is_quantized:
            def _quant_pred(name, module):
                if not isinstance(module, mnn.Linear):
                    return False
                w = module.weight
                return w.ndim == 2 and w.shape[0] >= 64 and w.shape[1] >= 64
            mnn.quantize(model, bits=4, group_size=32, class_predicate=_quant_pred)

        # For BF16 weights saved from PyTorch, remap numeric-index keys.
        # INT4 weights saved by our convert script already have correct keys.
        remapped = {}
        for k, v in arrays.items():
            k = re.sub(r'\.(img_mod|txt_mod)\.1\.', r'.\1.', k)
            k = re.sub(r'\.attn\.to_out\.0\.', '.attn.to_out.', k)
            remapped[k] = v
        model.load_weights(list(remapped.items()))
        mx.eval(model.parameters())
        return model
