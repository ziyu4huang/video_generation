"""MLX implementation of GPT-OSS-20B text encoder for Microsoft Lens.

Architecture matches ComfyUI/comfy/text_encoders/gpt_oss.py (GptOssModel).
Key names are kept identical to the PyTorch reference for zero-remap conversion.

Spec (GptOss20BConfig defaults):
    24 decoder layers
    hidden_size = 2880
    64 attention heads, 8 KV heads (GQA, ratio 8:1)
    head_dim = 64  →  q dim = 64*64=4096, kv dim = 8*64=512
    MoE FFN: 32 experts, top-4 routing, intermediate_size = 2880
    Sliding window = 128 (alternate layers), YARN RoPE
    vocab_size = 201088

Forward returns multi-layer hidden states at selected_layers = (5, 11, 17, 23),
stacked as [B, S, L*hidden_size] (after trimming LENS_TXT_OFFSET=97 prefix tokens).

This is used in LensPipeline.encode_prompt() to produce the 4×2880 conditioning
passed to LensTransformer as context.
"""

from __future__ import annotations

import math
from typing import Optional

import mlx.core as mx
import mlx.nn as mnn


# ---------------------------------------------------------------------------
# Config (mirrors GptOss20BConfig)
# ---------------------------------------------------------------------------

VOCAB_SIZE = 201088
HIDDEN_SIZE = 2880
INTERMEDIATE_SIZE = 2880
NUM_LAYERS = 24
NUM_HEADS = 64
NUM_KV_HEADS = 8
HEAD_DIM = 64
NUM_EXPERTS = 32
NUM_EXPERTS_PER_TOK = 4
SLIDING_WINDOW = 128
ROPE_THETA = 150000.0
ROPE_FACTOR = 32.0
ROPE_BETA_FAST = 32.0
ROPE_BETA_SLOW = 1.0
ORIGINAL_MAX_POS = 4096
RMS_NORM_EPS = 1e-5
MOE_ALPHA = 1.702
MOE_LIMIT = 7.0

LENS_TXT_OFFSET = 97
LENS_SELECTED_LAYERS = (5, 11, 17, 23)
LENS_MAX_TOKENS = 512
PAD_TOKEN_ID = 199999


def _layer_types() -> list[str]:
    return ["sliding_attention" if (i + 1) % 2 else "full_attention" for i in range(NUM_LAYERS)]


# ---------------------------------------------------------------------------
# YARN RoPE helpers (mirrors gpt_oss.py _yarn_inv_freq)
# ---------------------------------------------------------------------------

def _yarn_inv_freq(device=None):
    """Compute YARN inv_freq and attention scaling."""
    dim = HEAD_DIM
    base = ROPE_THETA
    factor = ROPE_FACTOR
    beta_fast = ROPE_BETA_FAST
    beta_slow = ROPE_BETA_SLOW
    orig_max = ORIGINAL_MAX_POS

    def find_correction_dim(num_rotations: float) -> float:
        return (dim * math.log(orig_max / (num_rotations * 2 * math.pi))) / (2 * math.log(base))

    low = max(find_correction_dim(beta_fast), 0)
    high = min(find_correction_dim(beta_slow), dim - 1)

    def linear_ramp(n: int) -> mx.array:
        if low == high:
            return mx.full((n,), 0.5)
        return mx.clip((mx.arange(n, dtype=mx.float32) - low) / (high - low), 0.0, 1.0)

    mscale = 0.1 * math.log(factor) + 1.0 if factor > 1 else 1.0

    half = dim // 2
    pos_freqs = base ** (mx.arange(0, dim, 2, dtype=mx.float32) / dim)
    inv_interp = 1.0 / (factor * pos_freqs)
    inv_extrap = 1.0 / pos_freqs
    extrap_factor = 1 - linear_ramp(half)
    inv_freq = inv_interp * (1 - extrap_factor) + inv_extrap * extrap_factor
    return inv_freq, mscale


def _build_freqs_cis(inv_freq: mx.array, attn_scaling: float, position_ids: mx.array, dtype):
    """Build (cos, sin) tensors for RoPE."""
    freqs = position_ids[:, :, None].astype(mx.float32) * inv_freq[None, None, :]  # [B, S, D/2]
    emb = mx.concatenate([freqs, freqs], axis=-1)  # [B, S, D]
    cos = (mx.cos(emb) * attn_scaling).astype(dtype)
    sin = (mx.sin(emb) * attn_scaling).astype(dtype)
    return cos, sin


def _rotate_half(x: mx.array) -> mx.array:
    half = x.shape[-1] // 2
    return mx.concatenate([-x[..., half:], x[..., :half]], axis=-1)


def _apply_rope(q: mx.array, k: mx.array, cos: mx.array, sin: mx.array):
    """Apply RoPE. q/k: [B, H, S, D], cos/sin: [B, S, D]."""
    cos = cos[:, None]  # [B, 1, S, D]
    sin = sin[:, None]
    return q * cos + _rotate_half(q) * sin, k * cos + _rotate_half(k) * sin


# ---------------------------------------------------------------------------
# Attention
# ---------------------------------------------------------------------------

class GptOssAttention(mnn.Module):
    def __init__(self, layer_idx: int) -> None:
        super().__init__()
        self.layer_idx = layer_idx
        self.layer_type = _layer_types()[layer_idx]
        self.num_heads = NUM_HEADS
        self.num_kv_heads = NUM_KV_HEADS
        self.num_kv_groups = NUM_HEADS // NUM_KV_HEADS
        self.head_dim = HEAD_DIM
        self.sliding_window = SLIDING_WINDOW if self.layer_type == "sliding_attention" else None

        self.q_proj = mnn.Linear(HIDDEN_SIZE, NUM_HEADS * HEAD_DIM, bias=True)
        self.k_proj = mnn.Linear(HIDDEN_SIZE, NUM_KV_HEADS * HEAD_DIM, bias=True)
        self.v_proj = mnn.Linear(HIDDEN_SIZE, NUM_KV_HEADS * HEAD_DIM, bias=True)
        self.o_proj = mnn.Linear(NUM_HEADS * HEAD_DIM, HIDDEN_SIZE, bias=True)
        self.sinks = mx.zeros((NUM_HEADS,))

    def __call__(
        self,
        hidden_states: mx.array,
        attention_mask: Optional[mx.array],
        cos: mx.array,
        sin: mx.array,
    ) -> mx.array:
        B, S, _ = hidden_states.shape
        H, Hkv, D = self.num_heads, self.num_kv_heads, self.head_dim

        q = self.q_proj(hidden_states).reshape(B, S, H, D).transpose(0, 2, 1, 3)
        k = self.k_proj(hidden_states).reshape(B, S, Hkv, D).transpose(0, 2, 1, 3)
        v = self.v_proj(hidden_states).reshape(B, S, Hkv, D).transpose(0, 2, 1, 3)

        q, k = _apply_rope(q, k, cos, sin)

        if self.num_kv_groups > 1:
            k = mx.repeat(k, self.num_kv_groups, axis=1)
            v = mx.repeat(v, self.num_kv_groups, axis=1)

        scale = 1.0 / math.sqrt(D)

        # Build causal (+ optional sliding window) mask
        i_idx = mx.arange(S)
        j_idx = mx.arange(S)
        causal = j_idx[None, :] <= i_idx[:, None]
        if self.sliding_window is not None:
            window = j_idx[None, :] > i_idx[:, None] - self.sliding_window
            causal = causal & window
        causal_mask = mx.where(causal, mx.zeros((S, S)), mx.full((S, S), float("-inf")))
        causal_mask = causal_mask[None, None]  # [1, 1, S, S]

        if attention_mask is not None:
            # 0.0 * -inf = NaN; use mx.where to produce -inf for masked positions
            kp = mx.where(
                attention_mask[:, None, None, :],
                mx.zeros((1,)),
                mx.full((1,), float("-inf")),
            )
            causal_mask = causal_mask + kp

        # Append sink column (per-head learned softmax bias)
        k_sink = mx.zeros((B, H, 1, D), dtype=k.dtype)
        v_sink = mx.zeros((B, H, 1, D), dtype=v.dtype)
        k_full = mx.concatenate([k, k_sink], axis=2)   # [B, H, S+1, D]
        v_full = mx.concatenate([v, v_sink], axis=2)

        sinks_col = self.sinks[None, :, None, None].astype(q.dtype)
        sink_mask = mx.broadcast_to(sinks_col, (B, H, S, 1))
        mask_full = mx.concatenate(
            [mx.broadcast_to(causal_mask, (B, H, S, S)), sink_mask], axis=-1
        )  # [B, H, S, S+1]

        attn = mx.matmul(q * scale, k_full.transpose(0, 1, 3, 2)) + mask_full
        attn_weights = mx.softmax(attn.astype(mx.float32), axis=-1).astype(q.dtype)
        out = mx.matmul(attn_weights, v_full)  # [B, H, S, D]

        out = out.transpose(0, 2, 1, 3).reshape(B, S, H * D)
        return self.o_proj(out)


# ---------------------------------------------------------------------------
# MoE FFN
# ---------------------------------------------------------------------------

class GptOssTopKRouter(mnn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.weight = mx.zeros((NUM_EXPERTS, HIDDEN_SIZE))
        self.bias = mx.zeros((NUM_EXPERTS,))

    def __call__(self, x: mx.array) -> tuple[mx.array, mx.array]:
        logits = x @ self.weight.T + self.bias
        # top-k via argsort descending
        order = mx.argsort(-logits, axis=-1)
        top_idx = order[..., :NUM_EXPERTS_PER_TOK]   # [N, k]
        top_vals = mx.take_along_axis(logits, top_idx, axis=-1)
        scores = mx.softmax(top_vals, axis=-1)
        return scores, top_idx


class GptOssExperts(mnn.Module):
    """MoE expert bank: NUM_EXPERTS experts, each is a gated SwiGLU FFN.

    Weights stored as lists of mnn.Linear (one per expert) so mnn.quantize
    can compress them to INT4/INT8. Keys in the MLX safetensors format:
        gate_up_proj.{0..31}.weight  [2*I, H]
        gate_up_proj.{0..31}.bias    [2*I]
        down_proj.{0..31}.weight     [H, I]
        down_proj.{0..31}.bias       [H]

    Conversion from the original 3D bank [E, O, I] splits per-expert.
    """

    def __init__(self) -> None:
        super().__init__()
        H, I = HIDDEN_SIZE, INTERMEDIATE_SIZE
        self.gate_up_proj = [mnn.Linear(H, 2 * I, bias=True) for _ in range(NUM_EXPERTS)]
        self.down_proj = [mnn.Linear(I, H, bias=True) for _ in range(NUM_EXPERTS)]

    @staticmethod
    def _apply_gate(gate_up: mx.array) -> mx.array:
        # Interleaved gate/up: gate at even positions, up at odd positions
        gate = gate_up[..., ::2]
        up = gate_up[..., 1::2]
        gate = mx.minimum(gate, MOE_LIMIT)
        up = mx.clip(up, -MOE_LIMIT, MOE_LIMIT)
        glu = gate * mx.sigmoid(gate * MOE_ALPHA)
        return glu + glu * up  # addcmul(glu, glu, up)

    def __call__(
        self,
        hidden_states: mx.array,  # [N, H]
        router_indices: mx.array,  # [N, k]
        routing_weights: mx.array, # [N, k]
    ) -> mx.array:
        N, H = hidden_states.shape
        output = mx.zeros((N, H), dtype=hidden_states.dtype)

        for ei in range(NUM_EXPERTS):
            # Mask: which (token, slot) pairs use expert ei → [N, k]
            is_ei = (router_indices == ei)
            # Per-token combined weight for this expert: sum over k slots → [N]
            w = mx.where(is_ei, routing_weights, mx.zeros_like(routing_weights))
            w_sum = w.sum(axis=-1)  # [N]

            # Expert output for all tokens
            gate_up = self.gate_up_proj[ei](hidden_states)  # [N, 2I]
            gated = self._apply_gate(gate_up)               # [N, I]
            expert_out = self.down_proj[ei](gated)          # [N, H]

            output = output + expert_out * w_sum[:, None]

        return output


class GptOssMLP(mnn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.router = GptOssTopKRouter()
        self.experts = GptOssExperts()

    def __call__(self, hidden_states: mx.array) -> mx.array:
        B, S, H = hidden_states.shape
        flat = hidden_states.reshape(-1, H)
        scores, idx = self.router(flat)
        out = self.experts(flat, idx, scores)
        return out.reshape(B, S, H)


# ---------------------------------------------------------------------------
# Decoder layer + model
# ---------------------------------------------------------------------------

class RMSNorm(mnn.Module):
    def __init__(self, dim: int, eps: float = RMS_NORM_EPS) -> None:
        super().__init__()
        self.weight = mx.ones((dim,))
        self.eps = eps

    def __call__(self, x: mx.array) -> mx.array:
        x_fp = x.astype(mx.float32)
        rms = mx.sqrt(mx.mean(x_fp ** 2, axis=-1, keepdims=True) + self.eps)
        return (x_fp / rms * self.weight).astype(x.dtype)


class GptOssDecoderLayer(mnn.Module):
    def __init__(self, layer_idx: int) -> None:
        super().__init__()
        self.self_attn = GptOssAttention(layer_idx)
        self.mlp = GptOssMLP()
        self.input_layernorm = RMSNorm(HIDDEN_SIZE)
        self.post_attention_layernorm = RMSNorm(HIDDEN_SIZE)

    def __call__(
        self,
        x: mx.array,
        attention_mask: Optional[mx.array],
        cos: mx.array,
        sin: mx.array,
    ) -> mx.array:
        residual = x
        x = self.input_layernorm(x)
        x = self.self_attn(x, attention_mask, cos, sin)
        x = residual + x

        residual = x
        x = self.post_attention_layernorm(x)
        x = self.mlp(x)
        return residual + x


class GptOssModel(mnn.Module):
    """GPT-OSS-20B decoder with multi-layer hidden-state capture.

    Key layout matches the safetensors file (top-level, no wrapper prefix):
        embed_tokens.weight
        layers.N.{input_layernorm,self_attn,post_attention_layernorm,mlp}.*
        norm.weight
    """

    def __init__(self) -> None:
        super().__init__()
        self.embed_tokens = mnn.Embedding(VOCAB_SIZE, HIDDEN_SIZE)
        self.layers = [GptOssDecoderLayer(i) for i in range(NUM_LAYERS)]
        self.norm = RMSNorm(HIDDEN_SIZE)

        inv_freq, attn_scaling = _yarn_inv_freq()
        self._inv_freq = inv_freq
        self._attn_scaling = float(attn_scaling)

    def __call__(
        self,
        input_ids: mx.array,
        attention_mask: Optional[mx.array] = None,
        capture_layers: Optional[tuple[int, ...]] = None,
    ) -> dict:
        B, S = input_ids.shape
        hidden = self.embed_tokens(input_ids)

        pos_ids = mx.broadcast_to(mx.arange(S)[None], (B, S))
        cos, sin = _build_freqs_cis(self._inv_freq, self._attn_scaling, pos_ids, hidden.dtype)

        capture_set = set(capture_layers) if capture_layers else set()
        max_layer = max(capture_layers) if capture_layers else NUM_LAYERS - 1
        captured: dict[int, mx.array] = {}

        for i, layer in enumerate(self.layers):
            hidden = layer(hidden, attention_mask, cos, sin)
            if i in capture_set:
                captured[i] = hidden
            if i >= max_layer:
                break

        if capture_layers:
            return {"hidden_states": [captured[l] for l in capture_layers]}
        return {"last_hidden_state": self.norm(hidden)}


class LensGptOssEncoder(mnn.Module):
    """Top-level Lens text encoder: GPT-OSS-20B → multi-layer features.

    The safetensors file stores weights at the top level (no "transformer." prefix),
    matching GptOssModel attribute paths directly. When loading from file, prefix
    all keys with "transformer." to align with this module's attribute hierarchy.

    encode() returns ([B, S-offset, L*H], trimmed_mask) where L=4 selected layers.
    """

    def __init__(
        self,
        selected_layers: tuple[int, ...] = LENS_SELECTED_LAYERS,
        txt_offset: int = LENS_TXT_OFFSET,
    ) -> None:
        super().__init__()
        self.transformer = GptOssModel()
        self.selected_layers = selected_layers
        self.txt_offset = txt_offset

    def encode(
        self,
        input_ids: mx.array,
        attention_mask: Optional[mx.array] = None,
    ) -> tuple[mx.array, Optional[mx.array]]:
        """Return (features [B, S, L*H], trimmed_mask [B, S])."""
        out = self.transformer(input_ids, attention_mask, capture_layers=self.selected_layers)
        layers = out["hidden_states"]  # list of L tensors [B, S, H]
        stacked = mx.stack(layers, axis=2)  # [B, S, L, H]

        offset = self.txt_offset
        if stacked.shape[1] > offset:
            stacked = stacked[:, offset:]
            mask_out = attention_mask[:, offset:] if attention_mask is not None else None
        else:
            stacked = stacked[:, :0]
            mask_out = attention_mask[:, :0] if attention_mask is not None else None

        B, S, L, Hd = stacked.shape
        flat = stacked.reshape(B, S, L * Hd)
        return flat, mask_out

    @classmethod
    def from_pretrained(cls, weights_path: str, **kwargs) -> "LensGptOssEncoder":
        """Load from MLX safetensors (INT4/INT8 or BF16).

        Weights must be stored with "transformer." prefix (as produced by
        convert_lens_te_mlx.py). Auto-detects quantized format (INT4/INT8)
        by checking for .scales keys and pre-quantizes the model structure.
        """
        # Peek at keys to detect quantized format
        # mx.load(return_metadata=True) → (arrays_dict, metadata_dict)
        arrays, _ = mx.load(weights_path, return_metadata=True)
        is_quantized = any(k.endswith(".scales") for k in arrays)

        model = cls(**kwargs)

        if is_quantized:
            # Pre-quantize model structure so QuantizedLinear accepts scales/biases
            def _quant_pred(name, module):
                if not isinstance(module, mnn.Linear):
                    return False
                w = module.weight
                return w.ndim == 2 and w.shape[0] >= 64 and w.shape[1] >= 64
            # Infer bits from weight dtype (uint32 → INT4, uint8 or similar → INT8)
            # Default to INT4 (bits=4, group_size=32) which is what convert_lens_te_mlx uses
            mnn.quantize(model, bits=4, group_size=32, class_predicate=_quant_pred)

        model.load_weights(weights_path)
        mx.eval(model.parameters())
        return model
