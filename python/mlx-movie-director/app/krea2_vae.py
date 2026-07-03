"""Krea 2 VAE decoder — MLX port of diffusers AutoencoderKLQwenImage (image path).

For single-image decode (T=1) the 3D causal convs collapse exactly to 2D:
each QwenImageCausalConv3d kernel (kT,kH,kW) left-pads time by (kT-1) zeros,
so for T=1 only the LAST temporal plane (kt=kT-1) of the weight contributes.
We slice each 5D torch weight (out, in, kT, kH, kW) to (out, in, kH, kW) and
run a plain 2D conv net — fast and numerically exact for T=1.

Confirmed (diffusers 0.37 oracle): decode (1,16,1,H/8,W/8) -> (1,3,1,H,W),
per-channel latents_mean/std rescale before decode, spatial compression 8x.
upsample3d == upsample2d for T=1; time_conv weights are not loaded (no-op).

Functional decoder (explicit weight slicing) to avoid nn.Module key-matching.
"""

import json
import os

import mlx.core as mx


def _w3d_to_2d(w5d):
    """torch (out,in,kT,kH,kW) -> last temporal plane -> MLX conv2d (out,kH,kW,in)."""
    return mx.transpose(w5d[:, :, -1, :, :], (0, 2, 3, 1))


def _conv2d(x, w5d, bias=None, stride=1, padding=1):
    """x: (N,H,W,C). Applies the causal-3D conv as a 2D conv (T=1 equivalence)."""
    y = mx.conv2d(x, _w3d_to_2d(w5d), stride=stride, padding=padding)
    if bias is not None:
        y = y + bias
    return y


def _rms_norm(x, gamma, eps=1e-12):
    """QwenImageRMS_norm over channels: F.normalize (L2) * sqrt(dim) * gamma. x:(N,H,W,C).
    gamma stored as (dim,1,1,1)/(dim,1) — squeeze to (dim,)."""
    g = gamma.reshape(-1)
    scale = x.shape[-1] ** 0.5
    norm = mx.sqrt((x * x).sum(axis=-1, keepdims=True) + eps)   # L2 over channel
    return (x / norm) * scale * g


def _silu(x):
    return x * mx.sigmoid(x)


def _resnet_block(x, w, prefix):
    """QwenImageResidualBlock. w is the full weight dict. x:(N,H,W,C)."""
    in_c = x.shape[-1]
    h = x
    # shortcut
    if f"{prefix}.conv_shortcut.weight" in w:
        shortcut = _conv2d(h, w[f"{prefix}.conv_shortcut.weight"], w.get(f"{prefix}.conv_shortcut.bias"), padding=0)
    else:
        shortcut = h
    h = _rms_norm(h, w[f"{prefix}.norm1.gamma"])
    h = _silu(h)
    h = _conv2d(h, w[f"{prefix}.conv1.weight"], w.get(f"{prefix}.conv1.bias"))
    h = _rms_norm(h, w[f"{prefix}.norm2.gamma"])
    h = _silu(h)
    h = _conv2d(h, w[f"{prefix}.conv2.weight"], w.get(f"{prefix}.conv2.bias"))
    return h + shortcut


def _attn_block(x, w, prefix):
    """QwenImageAttentionBlock — single-head self-attention over spatial tokens. x:(N,H,W,C)."""
    import mlx.core as mx
    N, H, Wd, C = x.shape
    identity = x
    h = _rms_norm(x, w[f"{prefix}.norm.gamma"])
    # to_qkv: 1x1 Conv2d, weight torch (3C, C, 1, 1) -> (3C, C)
    qkv_w = w[f"{prefix}.to_qkv.weight"][:, :, 0, 0]  # (3C, C)
    qkv = h @ qkv_w.T + w[f"{prefix}.to_qkv.bias"]   # (N,H,W,3C)
    qkv = qkv.reshape(N, H * Wd, 3 * C)
    q, k, v = mx.split(qkv, 3, axis=-1)              # each (N, HW, C)
    # single-head: (N, 1, HW, C)
    q = q.reshape(N, 1, H * Wd, C); k = k.reshape(N, 1, H * Wd, C); v = v.reshape(N, 1, H * Wd, C)
    scale = C ** -0.5
    attn = mx.fast.scaled_dot_product_attention(q, k, v, scale=scale)  # (N,1,HW,C)
    a = attn.reshape(N, H, Wd, C)
    # proj: 1x1 Conv2d, weight torch (C, C, 1, 1) -> (C, C)
    proj_w = w[f"{prefix}.proj.weight"][:, :, 0, 0]  # (C, C)
    a = a @ proj_w.T + w[f"{prefix}.proj.bias"]
    return a + identity


def _upsample(x, w, prefix):
    """QwenImageResample upsample (2d or 3d identical for T=1): nearest 2x spatial + conv2d(dim->dim//2)."""
    import mlx.core as mx
    N, H, Wd, C = x.shape
    # nearest-exact 2x: repeat each pixel
    x = mx.broadcast_to(x[:, :, None, :, None, :], (N, H, 2, Wd, 2, C))
    x = x.reshape(N, H * 2, Wd * 2, C)
    # resample conv2d: sequential index 1 -> weight (dim//2, dim, 3, 3) [it's a Conv2d, 4D already]
    cw = w[f"{prefix}.resample.1.weight"]            # (out, in, 3, 3)
    cb = w.get(f"{prefix}.resample.1.bias")
    mlx_w = mx.transpose(cw, (0, 2, 3, 1))           # (out,3,3,in)
    return mx.conv2d(x, mlx_w, stride=1, padding=1) + (cb if cb is not None else 0.0)


def decode(latent_nhwc, weights):
    """Decode a single-image latent. latent_nhwc: (1, H/8, W/8, 16). weights: dict from safetensors."""
    w = weights
    x = latent_nhwc
    # post_quant_conv (1x1 causal -> 2d 1x1)
    x = _conv2d(x, w["post_quant_conv.weight"], w.get("post_quant_conv.bias"), padding=0)
    # decoder
    d = "decoder"
    x = _conv2d(x, w[f"{d}.conv_in.weight"], w.get(f"{d}.conv_in.bias"))
    # mid_block: resnet0, attn0, resnet1
    x = _resnet_block(x, w, f"{d}.mid_block.resnets.0")
    x = _attn_block(x, w, f"{d}.mid_block.attentions.0")
    x = _resnet_block(x, w, f"{d}.mid_block.resnets.1")
    # up blocks
    for ui, has_resample in [(0, True), (1, True), (2, True), (3, False)]:
        for ri in range(3):
            x = _resnet_block(x, w, f"{d}.up_blocks.{ui}.resnets.{ri}")
        if has_resample:
            x = _upsample(x, w, f"{d}.up_blocks.{ui}.upsamplers.0")
    # head
    x = _rms_norm(x, w[f"{d}.norm_out.gamma"])
    x = _silu(x)
    x = _conv2d(x, w[f"{d}.conv_out.weight"], w.get(f"{d}.conv_out.bias"))
    return mx.clip(x, -1.0, 1.0)  # (1, H, W, 3)


def _downsample(x, w, prefix):
    """torch downsample2d: Sequential(ZeroPad2d((0,1,0,1)), Conv2d(dim,dim,3,stride=(2,2))).
    resample.0 = ZeroPad (no params), resample.1 = Conv2d (4D weight). x:(N,H,W,C)."""
    import mlx.core as mx
    x = mx.pad(x, [(0, 0), (0, 1), (0, 1), (0, 0)])
    cw = w[f"{prefix}.resample.1.weight"]            # (out, in, 3, 3) Conv2d 4D
    mlx_w = mx.transpose(cw, (0, 2, 3, 1))           # (out,3,3,in)
    y = mx.conv2d(x, mlx_w, stride=2, padding=0)
    cb = w.get(f"{prefix}.resample.1.bias")
    return y + (cb if cb is not None else 0.0)


def encode(image_nhwc, weights):
    """Encode a single image. image_nhwc: (1, H, W, 3) in [-1,1] -> latent (1, H/8, W/8, 16).

    Returns the DiagonalGaussian MODE (mean, first half) -- no sampling. quant_conv
    applied; NO latents_mean/std rescale (caller rescales to diffusion space).

    Mirrors diffusers AutoencoderKLQwenImage.encoder (T=1 -> 3D causal convs collapse
    to 2D, same as decode). Functional, explicit weight slicing.
    """
    w = weights
    x = image_nhwc
    x = _conv2d(x, w["encoder.conv_in.weight"], w.get("encoder.conv_in.bias"))
    # Flat down_blocks: R,R,D, R,R,D, R,R,D, R,R  (R=resnet, D=downsample)
    # stages: 96,96,ds | 96,192,ds | 192,384,ds | 384,384  (dim_mult [1,2,4,4])
    flat = [(0, False), (1, False), (2, True), (3, False), (4, False), (5, True),
            (6, False), (7, False), (8, True), (9, False), (10, False)]
    for idx, is_down in flat:
        if is_down:
            x = _downsample(x, w, f"encoder.down_blocks.{idx}")
        else:
            x = _resnet_block(x, w, f"encoder.down_blocks.{idx}")
    x = _resnet_block(x, w, "encoder.mid_block.resnets.0")
    x = _attn_block(x, w, "encoder.mid_block.attentions.0")
    x = _resnet_block(x, w, "encoder.mid_block.resnets.1")
    x = _rms_norm(x, w["encoder.norm_out.gamma"])
    x = _silu(x)
    x = _conv2d(x, w["encoder.conv_out.weight"], w.get("encoder.conv_out.bias"))  # (1,H/8,W/8,32)
    x = _conv2d(x, w["quant_conv.weight"], w.get("quant_conv.bias"), padding=0)    # 32 -> 32
    mean, _logvar = mx.split(x, 2, axis=-1)        # each (1,H/8,W/8,16)
    return mean


def load_vae_weights(vae_dir):
    """Load the qwen_image_vae safetensors (3D torch weights) + mean/std."""
    import struct
    path = os.path.join(vae_dir, "diffusion_pytorch_model.safetensors")
    raw = mx.load(path)
    with open(os.path.join(vae_dir, "config.json")) as f:
        vcfg = json.load(f)
    return raw, vcfg
