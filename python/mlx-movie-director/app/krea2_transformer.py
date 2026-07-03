"""Krea 2 single-stream MMDiT — MLX port of krea-ai/krea-2/mmdit.py.

Faithful 1:1 port. Module attribute names and parameter leaf names are kept
identical to the torch reference so that the raw `turbo.safetensors`
(the OSS_TURBO checkpoint, loaded with strict=True in inference.py) loads
directly via nn.load_weights with no key remapping.

Reference: https://github.com/krea-ai/krea-2/blob/main/mmdit.py
"""

from dataclasses import dataclass
from typing import Optional

import mlx.core as mx
import mlx.nn as nn


# ---------------------------------------------------------------------------
# RoPE — interleaved 2x2 matrix convention (theta=1e3 for Krea, NOT 1e4).
# Identical math to the Flux/Lens family this repo already implements.
# ---------------------------------------------------------------------------

def _rope(pos: mx.array, dim: int, theta: float = 1e3) -> mx.array:
    """pos: (B, L) for one axis, dim = axis head-dim budget (e.g. 32/48/48).

    Returns (B, L, dim//2, 2, 2) — per-pair 2x2 rotation matrices.
    """
    # Reference uses float64 then casts to float32; MLX/Metal has no float64, so compute in float32 directly.
    scale = mx.arange(0, dim, 2, dtype=mx.float32) / dim            # (dim//2,)
    omega = 1.0 / ((theta) ** scale)                                 # (dim//2,)
    # einsum("...n,d->...nd"): (B,L) x (dim//2,) -> (B,L,dim//2)
    out = pos[..., None].astype(mx.float32) * omega[None, None, :]
    c, sm = mx.cos(out), mx.sin(out)
    # stack([cos, -sin, sin, cos], dim=-1) -> (B,L,dim//2,4)
    stacked = mx.stack([c, -sm, sm, c], axis=-1)
    B, L, D2, _ = stacked.shape
    # rearrange "... (i j) -> ... i j", i=2, j=2  -> (B,L,dim//2,2,2)
    return stacked.reshape(B, L, D2, 2, 2)


class PositionalEncoding(nn.Module):
    """Build per-token 2x2 RoPE matrices by concatenating per-axis rope
    outputs along the head-dim axis (dim=-3)."""

    def __init__(self, axdims: list[int], theta: float = 1e3):
        super().__init__()
        self.axdims = axdims
        self.theta = theta

    def __call__(self, pos: mx.array) -> mx.array:
        # pos: (B, L, 3) — text tokens at origin (0,0,0), image at (0,h,w).
        per_axis = [_rope(pos[..., i], d, self.theta) for i, d in enumerate(self.axdims)]
        return mx.concatenate(per_axis, axis=-3)  # (B, L, head_dim//2, 2, 2)


def _rope_apply(xq: mx.array, xk: mx.array, freqs: mx.array):
    """Apply the 2x2 rotation. xq: (B,H_q,L,head_dim), xk: (B,H_kv,L,head_dim).
    freqs: (B,L,head_dim//2,2,2). GQA: H_q != H_kv, so reshape each with its own H."""
    def _rot(x):
        B, H, L, D = x.shape
        half = D // 2
        x_ = x.astype(mx.float32).reshape(B, H, L, half, 1, 2)
        f = freqs[:, None, :, :, :, :]  # (B,1,L,half,2,2) — broadcast over heads
        return (f[..., 0] * x_[..., 0] + f[..., 1] * x_[..., 1]).reshape(B, H, L, D)
    return _rot(xq), _rot(xk)


# ---------------------------------------------------------------------------
# Norms / modulation
# ---------------------------------------------------------------------------

class Krea2RMSNorm(nn.Module):
    """Reference stores `scale` param and applies weight = scale + 1.0
    (torch RMSNorm weight=(scale.float()+1.0)). We keep the leaf name `scale`
    so the checkpoint loads with the same key."""

    def __init__(self, features: int, eps: float = 1e-5):
        super().__init__()
        self.scale = mx.zeros((features,), dtype=mx.float32)
        self.eps = eps

    def __call__(self, x: mx.array) -> mx.array:
        weight = self.scale + 1.0
        return mx.fast.rms_norm(x, weight, self.eps)


class SimpleModulation(nn.Module):
    """vec: (B, dim) -> scale, shift each (B, 1, dim). lin param shape (2, dim)."""

    def __init__(self, dim: int):
        super().__init__()
        self.lin = mx.zeros((2, dim))
        self.multiplier = 2

    def __call__(self, vec: mx.array):
        # out[b,k,d] = vec[b,d] + lin[k,d]  -> (B, 2, dim)
        out = vec[:, None, :] + self.lin[None, :, :]
        scale, shift = mx.split(out, 2, axis=1)  # each (B,1,dim)
        return scale, shift


class DoubleSharedModulation(nn.Module):
    """vec: (B, 6*dim) -> 6 chunks each (B, dim). lin param shape (6*dim,)."""

    def __init__(self, dim: int):
        super().__init__()
        self.lin = mx.zeros((6 * dim,))

    def __call__(self, vec: mx.array):
        out = vec + self.lin  # (B, 6*dim)
        prescale, preshift, pregate, postscale, postshift, postgate = mx.split(out, 6, axis=-1)
        return prescale, preshift, pregate, postscale, postshift, postgate


# ---------------------------------------------------------------------------
# Attention / MLP
# ---------------------------------------------------------------------------

def _swiglu_dim(features: int, multiplier: int, multiple: int = 128) -> int:
    mlpdim = int(2 * features / 3) * multiplier
    return multiple * ((mlpdim + multiple - 1) // multiple)


class SwiGLU(nn.Module):
    def __init__(self, features: int, multiplier: int, bias: bool = False, multiple: int = 128):
        super().__init__()
        mlpdim = _swiglu_dim(features, multiplier, multiple)
        self.gate = nn.Linear(features, mlpdim, bias=bias)
        self.up = nn.Linear(features, mlpdim, bias=bias)
        self.down = nn.Linear(mlpdim, features, bias=bias)

    def __call__(self, x: mx.array) -> mx.array:
        return self.down(nn.silu(self.gate(x)) * self.up(x))


class QKNorm(nn.Module):
    def __init__(self, dim: int):
        super().__init__()
        self.qnorm = Krea2RMSNorm(dim)
        self.knorm = Krea2RMSNorm(dim)

    def __call__(self, q, k, v):
        return self.qnorm(q), self.knorm(k), v


class Attention(nn.Module):
    def __init__(self, dim: int, heads: int, kvheads: Optional[int] = None, bias: bool = False):
        super().__init__()
        self.heads = heads
        self.kvheads = kvheads if kvheads is not None else heads
        self.headdim = dim // heads
        self.wq = nn.Linear(dim, self.headdim * heads, bias=bias)
        self.wk = nn.Linear(dim, self.headdim * self.kvheads, bias=bias)
        self.wv = nn.Linear(dim, self.headdim * self.kvheads, bias=bias)
        self.gate = nn.Linear(dim, dim, bias=bias)
        self.qknorm = QKNorm(self.headdim)
        self.gqa = heads != self.kvheads
        self.wo = nn.Linear(dim, dim, bias=bias)

    def __call__(self, qkv: mx.array, freqs: Optional[mx.array] = None,
                 mask: Optional[mx.array] = None) -> mx.array:
        B, L, _ = qkv.shape
        q = self.wq(qkv).reshape(B, L, self.heads, self.headdim)
        k = self.wk(qkv).reshape(B, L, self.kvheads, self.headdim)
        v = self.wv(qkv).reshape(B, L, self.kvheads, self.headdim)
        gate = self.gate(qkv)  # (B, L, dim)

        q, k, v = self.qknorm(q, k, v)  # operate per-head-dim
        # to (B, H, L, D) — match reference order (rearrange, qknorm, ropeapply, attention)
        q = q.transpose(0, 2, 1, 3)
        k = k.transpose(0, 2, 1, 3)
        v = v.transpose(0, 2, 1, 3)
        if freqs is not None:
            q, k = _rope_apply(q, k, freqs)

        scale = 1.0 / (self.headdim ** 0.5)
        if self.gqa:
            # Manual GQA attention (MLX sdpa fusion can diverge in full graphs).
            rep = self.heads // self.kvheads
            k = mx.repeat(k, rep, axis=1)
            v = mx.repeat(v, rep, axis=1)
        scores = (q @ k.transpose(0, 1, 3, 2)) * scale      # (B,H,L,L)
        if mask is not None:
            scores = mx.where(mask, scores, -1e9)
        out = mx.softmax(scores, axis=-1) @ v                # (B,H,L,D)
        # back to (B, L, H*D)
        out = out.transpose(0, 2, 1, 3).reshape(B, L, self.heads * self.headdim)
        # gated sigmoid: gate is (B, L, dim); project wo after gating
        return self.wo(out * mx.sigmoid(gate))


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------

class TextFusionBlock(nn.Module):
    def __init__(self, features: int, heads: int, multiplier: int,
                 bias: bool = False, kvheads: Optional[int] = None):
        super().__init__()
        self.prenorm = Krea2RMSNorm(features)
        self.postnorm = Krea2RMSNorm(features)
        self.attn = Attention(features, heads, bias=bias, kvheads=kvheads)
        self.mlp = SwiGLU(features, multiplier, bias=bias)

    def __call__(self, x: mx.array, mask: Optional[mx.array] = None) -> mx.array:
        x = x + self.attn(self.prenorm(x), mask=mask)
        x = x + self.mlp(self.postnorm(x))
        return x


class TextFusionTransformer(nn.Module):
    """Fuses the stacked 12-layer Qwen3-VL hidden states into a single text
    token sequence. layerwise blocks act across the 12-layer axis (n), then a
    Linear(12->1) collapses it, then refiner blocks attend over the text
    sequence with the key-padding mask."""

    def __init__(self, num_txt_layers: int, txt_dim: int, heads: int,
                 multiplier: int, bias: bool = False, kvheads: Optional[int] = None):
        super().__init__()
        self.layerwise_blocks = [TextFusionBlock(txt_dim, heads, multiplier, bias, kvheads)
                                 for _ in range(2)]
        # Linear(num_txt_layers, 1, bias=False): acts on the last dim.
        self.projector = nn.Linear(num_txt_layers, 1, bias=False)
        self.refiner_blocks = [TextFusionBlock(txt_dim, heads, multiplier, bias, kvheads)
                               for _ in range(2)]

    def __call__(self, x: mx.array, mask: Optional[mx.array] = None) -> mx.array:
        # x: (B, L, n, d) where n = num_txt_layers
        b, l, n, d = x.shape
        x = x.reshape(b * l, n, d)
        for block in self.layerwise_blocks:
            x = block(x, mask=None)
        # collapse the layer axis: (b*l, d, n) -> projector -> (b*l, d, 1)
        x = x.transpose(0, 2, 1)  # (b*l, d, n)
        x = self.projector(x)     # (b*l, d, 1)
        x = x.squeeze(-1)         # (b*l, d)
        x = x.reshape(b, l, d)
        for block in self.refiner_blocks:
            x = block(x, mask=mask)
        return x


class SingleStreamBlock(nn.Module):
    def __init__(self, features: int, heads: int, multiplier: int,
                 bias: bool = False, kvheads: Optional[int] = None):
        super().__init__()
        self.mod = DoubleSharedModulation(features)
        self.prenorm = Krea2RMSNorm(features)
        self.postnorm = Krea2RMSNorm(features)
        self.attn = Attention(features, heads, bias=bias, kvheads=kvheads)
        self.mlp = SwiGLU(features, multiplier, bias=bias)

    def __call__(self, x: mx.array, vec: mx.array, freqs: mx.array,
                 mask: Optional[mx.array] = None) -> mx.array:
        prescale, preshift, pregate, postscale, postshift, postgate = self.mod(vec)
        # vec chunks are (B, 1, features); broadcast over token dim
        x = x + pregate * self.attn((1 + prescale) * self.prenorm(x) + preshift, freqs, mask)
        x = x + postgate * self.mlp((1 + postscale) * self.postnorm(x) + postshift)
        return x


class LastLayer(nn.Module):
    def __init__(self, features: int, patch: int, channels: int):
        super().__init__()
        self.norm = Krea2RMSNorm(features)
        self.linear = nn.Linear(features, patch * patch * channels, bias=True)
        self.modulation = SimpleModulation(features)

    def __call__(self, x: mx.array, tvec: mx.array) -> mx.array:
        scale, shift = self.modulation(tvec)  # (B,1,features)
        x = (1 + scale) * self.norm(x) + shift
        return self.linear(x)


# ---------------------------------------------------------------------------
# Timestep embedding (functional in reference)
# ---------------------------------------------------------------------------

def temb(t: mx.array, dim: int, period: float = 1e4, tfactor: float = 1e3) -> mx.array:
    """t: (B,) -> (B, dim). Sinusoidal, period 1e4, t scaled by tfactor=1e3."""
    half = dim // 2
    freqs = mx.exp(-mx.log(period) * mx.arange(half, dtype=mx.float32) / half)  # (half,)
    args = (t.astype(mx.float32) * tfactor)[:, None, None] * freqs[None, None, :]  # (B,1,half)
    sin, cos = mx.sin(args), mx.cos(args)
    return mx.concatenate([cos, sin], axis=-1)  # (B, 1, dim) — squeeze middle later


# ---------------------------------------------------------------------------
# DiT
# ---------------------------------------------------------------------------

@dataclass
class Krea2DiTConfig:
    features: int = 6144
    tdim: int = 256
    txtdim: int = 2560
    heads: int = 48
    multiplier: int = 4
    layers: int = 28
    patch: int = 2
    channels: int = 16
    bias: bool = False
    theta: float = 1e3
    kvheads: Optional[int] = 12
    txtlayers: int = 12
    txtheads: int = 20
    txtkvheads: int = 20


class Krea2DiT(nn.Module):
    """Single-stream MMDiT. forward(img, context, t, pos, mask).

    img:     (B, N_img, patch*patch*channels=64) patchified latent tokens
    context: (B, L_text, num_txt_layers=12, txtdim=2560) stacked Qwen3-VL hiddens
    t:       (B,) timestep
    pos:     (B, L_text+N_img(+pad), 3) position ids
    mask:    (B, L_text+N_img(+pad)) bool key-padding mask (True = real token)
    """

    def __init__(self, config: Krea2DiTConfig):
        super().__init__()
        self.config = config
        headdim = config.features // config.heads
        axes = [
            headdim - 12 * (headdim // 16),
            6 * (headdim // 16),
            6 * (headdim // 16),
        ]
        assert sum(axes) == headdim, f"sum(axes)={sum(axes)}, headdim={headdim}"
        assert all(a % 2 == 0 for a in axes), f"axes={axes}"
        self.posemb = PositionalEncoding(axes, theta=config.theta)

        self.first = nn.Linear(config.channels * config.patch ** 2, config.features, bias=True)
        self.blocks = [SingleStreamBlock(config.features, config.heads, config.multiplier,
                                         config.bias, config.kvheads)
                       for _ in range(config.layers)]

        self.tmlp = nn.Sequential(
            nn.Linear(config.tdim, config.features),
            nn.GELU(approx="tanh"),  # faithful to torch ref (approximate="tanh") + Swift geluApproximate
            nn.Linear(config.features, config.features),
        )
        self.txtfusion = TextFusionTransformer(config.txtlayers, config.txtdim, config.txtheads,
                                               config.multiplier, config.bias, config.txtkvheads)
        self.txtmlp = nn.Sequential(
            Krea2RMSNorm(config.txtdim),
            nn.Linear(config.txtdim, config.features),
            nn.GELU(approx="tanh"),  # faithful to torch ref (approximate="tanh") + Swift geluApproximate
            nn.Linear(config.features, config.features),
        )
        self.last = LastLayer(config.features, config.patch, config.channels)
        self.tproj = nn.Sequential(
            nn.GELU(approx="tanh"),  # faithful to torch ref (approximate="tanh") + Swift geluApproximate
            nn.Linear(config.features, config.features * 6),
        )

    def __call__(self, img: mx.array, context: mx.array, t: mx.array,
                 pos: mx.array, mask: Optional[mx.array] = None) -> mx.array:
        img = self.first(img)  # (B, N_img, features)

        t_h = self.tmlp(temb(t, self.config.tdim).reshape(t.shape[0], -1))  # (B, features)
        tvec = self.tproj(t_h)  # (B, 6*features)

        txtlen = context.shape[1]
        # text-fusion attention mask: BOOL (True = attend), matching torch's
        # _mask() + F.scaled_dot_product_attention(attn_mask=bool). The prior
        # 0.0/-1e4 additive form was INVERTED by Attention's `where(mask,...)`
        # (nonzero=True) -- attend pairs (0.0) got masked, padding kept.
        if mask is not None:
            tm = mask[:, :txtlen]
            txtmask = tm[:, None, :, None] & tm[:, None, None, :]   # (B,1,txtlen,txtlen) bool
        else:
            txtmask = None
        context = self.txtfusion(context, mask=txtmask)   # (B, L_text, txtdim)
        context = self.txtmlp(context)                     # (B, L_text, features)

        imglen = img.shape[1]
        combined = mx.concatenate([context, img], axis=1)  # (B, L_text+N_img, features)

        # Pad to a multiple of 256 for stable kernel shapes.
        fulllen = combined.shape[1]
        padlen = (-fulllen) % 256
        if padlen > 0:
            combined = mx.pad(combined, [(0, 0), (0, padlen), (0, 0)])
            mask = mx.pad(mask, [(0, 0), (0, padlen)]) if mask is not None else None
            pos = mx.pad(pos, [(0, 0), (0, padlen), (0, 0)])

        if mask is not None:
            # Bool attention mask (True = attend) — MLX sdpa handles bool masks correctly.
            attn_mask = mask[:, None, None, :] & mask[:, None, :, None]   # (B,1,L,L) bool
        else:
            attn_mask = None

        freqs = self.posemb(pos)  # (B, L, head_dim//2, 2, 2)

        for block in self.blocks:
            combined = block(combined, tvec, freqs, attn_mask)

        final = self.last(combined, t_h)  # (B, L, patch²*channels)
        return final[:, txtlen:txtlen + imglen, :]
