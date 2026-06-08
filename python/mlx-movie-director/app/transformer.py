import mlx.core as mx
import mlx.nn as nn
import math


class RMSNorm(nn.Module):
    def __init__(self, dims: int, eps: float = 1e-6):
        super().__init__()
        self.weight = mx.ones(dims)
        self.eps = eps

    def __call__(self, x):
        return mx.fast.rms_norm(x, self.weight, self.eps)


class TimestepEmbedder(nn.Module):
    def __init__(self, out_size, mid_size=None, frequency_embedding_size=256):
        super().__init__()
        if mid_size is None: mid_size = out_size
        self.linear1 = nn.Linear(frequency_embedding_size, mid_size)
        self.linear2 = nn.Linear(mid_size, out_size)
        self.frequency_embedding_size = frequency_embedding_size

    def __call__(self, t):
        t = t.astype(mx.float32)
        half = self.frequency_embedding_size // 2
        freqs = mx.exp(-math.log(10000) * mx.arange(0, half, dtype=mx.float32) / half)
        args = (t[:, None] * freqs[None, :])
        embedding = mx.concatenate([mx.cos(args), mx.sin(args)], axis=-1)
        if self.frequency_embedding_size % 2:
            embedding = mx.concatenate([embedding, mx.zeros_like(embedding[:, :1])], axis=1)
        return self.linear2(nn.silu(self.linear1(embedding)))


class FeedForward(nn.Module):
    def __init__(self, dim: int, hidden_dim: int):
        super().__init__()
        self.w1 = nn.Linear(dim, hidden_dim, bias=False)
        self.w2 = nn.Linear(hidden_dim, dim, bias=False)
        self.w3 = nn.Linear(dim, hidden_dim, bias=False)

    def __call__(self, x):
        return self.w2(nn.silu(self.w1(x)) * self.w3(x))


class Attention(nn.Module):

    def __init__(self, dim: int, nheads: int, rope_theta: float = 256.0, eps: float = 1e-5):
        super().__init__()
        self.nheads = nheads
        self.head_dim = dim // nheads
        self.scale = self.head_dim ** -0.5

        self.to_q = nn.Linear(dim, dim, bias=False)
        self.to_k = nn.Linear(dim, dim, bias=False)
        self.to_v = nn.Linear(dim, dim, bias=False)
        self.to_qkv = None  # Fused Linear (Optional)
        self.to_out = nn.Linear(dim, dim, bias=False)

        self.norm_q = RMSNorm(self.head_dim, eps=eps)
        self.norm_k = RMSNorm(self.head_dim, eps=eps)

        self.dims = [32, 48, 48]
        self.splits = [0, 32, 80]
        self.freqs_cache = {}

    def fuse_qkv(self):
        if self.to_qkv is not None:
            return

        if isinstance(self.to_q, nn.QuantizedLinear):
            bits = self.to_q.bits
            group_size = self.to_q.group_size
            num_groups = self.to_q.scales.shape[1]
            input_dims = num_groups * group_size
            output_dims = self.to_q.weight.shape[0]

            has_bias = hasattr(self.to_q, "biases")

            fused_weight = mx.concatenate([self.to_q.weight, self.to_k.weight, self.to_v.weight], axis=0)
            fused_scales = mx.concatenate([self.to_q.scales, self.to_k.scales, self.to_v.scales], axis=0)
            fused_biases = mx.concatenate([self.to_q.biases, self.to_k.biases, self.to_v.biases], axis=0) if has_bias else None

            self.to_qkv = nn.QuantizedLinear(input_dims, output_dims * 3, bias=has_bias, bits=bits, group_size=group_size)
            self.to_qkv.weight = fused_weight
            self.to_qkv.scales = fused_scales
            if has_bias:
                self.to_qkv.biases = fused_biases
        else:
            w_q = self.to_q.weight
            w_k = self.to_k.weight
            w_v = self.to_v.weight

            fused_weight = mx.concatenate([w_q, w_k, w_v], axis=1).T

            out_dim, in_dim = fused_weight.shape
            self.to_qkv = nn.Linear(in_dim, out_dim, bias=False)
            self.to_qkv.weight = fused_weight

        del self.to_q, self.to_k, self.to_v

    def _get_fused_args_cached(self, positions):
        B, L, _ = positions.shape
        if L in self.freqs_cache:
            freqs_tuple = self.freqs_cache[L]
        else:
            freqs_list = []
            for d in self.dims:
                half = d // 2
                f = mx.exp(-mx.log(256.0) * mx.arange(0, half, dtype=mx.float32) / half)
                freqs_list.append(f)
            self.freqs_cache[L] = freqs_list
            freqs_tuple = freqs_list

        pos_h = positions[..., 0].astype(mx.float32)
        args_h = pos_h[..., None, None] * freqs_tuple[0][None, None, None, :]
        pos_w = positions[..., 1].astype(mx.float32)
        args_w = pos_w[..., None, None] * freqs_tuple[1][None, None, None, :]
        pos_t = positions[..., 2].astype(mx.float32)
        args_t = pos_t[..., None, None] * freqs_tuple[2][None, None, None, :]

        return mx.concatenate([args_h, args_w, args_t], axis=-1)

    def __call__(self, x, mask=None, positions=None, cos=None, sin=None):
        B, L, D = x.shape
        if self.to_qkv is not None:
            qkv = self.to_qkv(x).reshape(B, L, 3, self.nheads, self.head_dim)
            q, k, v = mx.split(qkv, 3, axis=2)
            q, k, v = q.squeeze(2), k.squeeze(2), v.squeeze(2)
        else:
            q = self.to_q(x).reshape(B, L, self.nheads, self.head_dim)
            k = self.to_k(x).reshape(B, L, self.nheads, self.head_dim)
            v = self.to_v(x).reshape(B, L, self.nheads, self.head_dim)

        q = self.norm_q(q)
        k = self.norm_k(k)

        if positions is not None:
            q1, q2 = q[..., 0::2], q[..., 1::2]
            q = mx.stack([q1 * cos - q2 * sin, q1 * sin + q2 * cos], axis=-1).reshape(B, L, self.nheads, self.head_dim)
            k1, k2 = k[..., 0::2], k[..., 1::2]
            k = mx.stack([k1 * cos - k2 * sin, k1 * sin + k2 * cos], axis=-1).reshape(B, L, self.nheads, self.head_dim)

        q, k, v = q.transpose(0, 2, 1, 3), k.transpose(0, 2, 1, 3), v.transpose(0, 2, 1, 3)
        output = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.scale, mask=mask)
        return self.to_out(output.transpose(0, 2, 1, 3).reshape(B, L, D))


class ZImageTransformerBlock(nn.Module):
    def __init__(self, config, layer_id, modulation=True):
        super().__init__()
        dim = config['dim']
        nheads = config['nheads']
        self.modulation = modulation
        self.attention = Attention(dim, nheads, rope_theta=config.get('rope_theta', 256.0), eps=1e-5)
        self.feed_forward = FeedForward(dim, int(dim / 3 * 8))
        self.attention_norm1 = RMSNorm(dim)
        self.ffn_norm1 = RMSNorm(dim)
        self.attention_norm2 = RMSNorm(dim)
        self.ffn_norm2 = RMSNorm(dim)
        if modulation: self.adaLN_modulation = nn.Linear(256, 4 * dim, bias=True)

    def __call__(self, x, mask, positions, adaln_input=None, cos=None, sin=None):
        if self.modulation:
            chunks = self.adaLN_modulation(adaln_input)
            scale_msa, gate_msa, scale_mlp, gate_mlp = mx.split(chunks, 4, axis=-1)
            scale_msa, gate_msa = scale_msa[..., None, :], gate_msa[..., None, :]
            scale_mlp, gate_mlp = scale_mlp[..., None, :], gate_mlp[..., None, :]

            norm_x = self.attention_norm1(x) * (1 + scale_msa)
            attn_out = self.attention(norm_x, mask, positions, cos=cos, sin=sin)
            x = x + mx.tanh(gate_msa) * self.attention_norm2(attn_out)

            norm_ffn = self.ffn_norm1(x) * (1 + scale_mlp)
            x = x + mx.tanh(gate_mlp) * self.ffn_norm2(self.feed_forward(norm_ffn))
        else:
            x = x + self.attention_norm2(self.attention(self.attention_norm1(x), mask, positions, cos, sin))
            x = x + self.ffn_norm2(self.feed_forward(self.ffn_norm1(x)))
        return x


class FinalLayer(nn.Module):
    def __init__(self, dim, out_channels):
        super().__init__()
        self.norm_final = nn.LayerNorm(dim, eps=1e-6, affine=False)
        self.linear = nn.Linear(dim, out_channels, bias=True)
        self.adaLN_modulation = nn.Sequential(nn.SiLU(), nn.Linear(256, dim, bias=True))

    def __call__(self, x, c):
        scale = self.adaLN_modulation.layers[1](self.adaLN_modulation.layers[0](c))
        return self.linear(self.norm_final(x) * (1 + scale[:, None, :]))


class ZImageTransformerMLX(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.config = config
        dim = config['dim']
        self.t_scale = config.get('t_scale', 1000.0)
        self.t_embedder = TimestepEmbedder(256, mid_size=1024)
        self.x_embedder = nn.Linear(config['in_channels'] * 4, dim, bias=True)
        self.cap_embedder = nn.Sequential(RMSNorm(config['cap_feat_dim']),
                                          nn.Linear(config['cap_feat_dim'], dim, bias=True))
        self.final_layer = FinalLayer(dim, config['in_channels'] * 4)

        self.x_pad_token = mx.zeros((1, dim))
        self.cap_pad_token = mx.zeros((1, dim))

        self.noise_refiner = [ZImageTransformerBlock(config, i, True) for i in range(config['n_refiner_layers'])]
        self.context_refiner = [ZImageTransformerBlock(config, i, False) for i in range(config['n_refiner_layers'])]
        self.layers = [ZImageTransformerBlock(config, i, True) for i in range(config['n_layers'])]

    def prepare_rope(self, positions):
        dummy_attn = self.layers[0].attention
        args = dummy_attn._get_fused_args_cached(positions)
        return mx.cos(args), mx.sin(args)

    def fuse_model(self):
        for layer in self.noise_refiner: layer.attention.fuse_qkv()
        for layer in self.context_refiner: layer.attention.fuse_qkv()
        for layer in self.layers: layer.attention.fuse_qkv()

    def __call__(self, x, t, cap_feats, x_pos, cap_pos, cos, sin, x_mask=None, cap_mask=None,
                 controlnet_samples=None, controlnet_model=None, controlnet_context=None,
                 controlnet_strength=1.0):
        """Forward pass with optional interleaved ControlNet injection.

        Args:
            controlnet_samples: (deprecated) pre-computed residuals, ignored if controlnet_model is set
            controlnet_model: ZImageControlnet instance for interleaved execution
            controlnet_context: [1, N, 3840] initial control context from controlnet.embed_control()
            controlnet_strength: float, strength for residual injection
        """
        use_cnet = controlnet_model is not None and controlnet_context is not None
        temb = self.t_embedder(t * self.t_scale)
        x = self.x_embedder(x)
        if x_mask is not None: x = mx.where(x_mask[..., None], self.x_pad_token, x)

        # Save original embedded x for ControlNet (ComfyUI passes original, not current)
        x_original = x if use_cnet else None

        cap_feats = self.cap_embedder.layers[1](self.cap_embedder.layers[0](cap_feats))
        if cap_mask is not None: cap_feats = mx.where(cap_mask[..., None], self.cap_pad_token, cap_feats)

        # Noise refiners — interleaved with ControlNet noise refiner blocks
        cnet_ctx = controlnet_context
        cos_img = cos[:, :x.shape[1]]
        sin_img = sin[:, :x.shape[1]]

        for ref_i, l in enumerate(self.noise_refiner):
            x = l(x, None, x_pos, temb, cos=cos_img, sin=sin_img)
            cos_img = cos[:, :x.shape[1]]  # update if shape changed
            sin_img = sin[:, :x.shape[1]]

            if use_cnet:
                # Run ControlNet noise refiner block with original embedded x (not current)
                residual, cnet_ctx = controlnet_model.forward_noise_refiner(
                    ref_i, cnet_ctx, x_original, temb, cos_img, sin_img)
                if residual is not None:
                    x = x + residual * controlnet_strength

        for l in self.context_refiner:
            cap_feats = l(cap_feats, None, cap_pos, None, cos=cos[:, x.shape[1]:], sin=sin[:, x.shape[1]:])

        x_len = x.shape[1]
        unified = mx.concatenate([x, cap_feats], axis=1)
        unified_pos = mx.concatenate([x_pos, cap_pos], axis=1)
        unified_mask = None

        # Save original image tokens for ControlNet (ComfyUI uses img_input, captured once)
        unified_original_img = unified[:, :x_len] if use_cnet else None

        # Track ControlNet layer index for stride-2 injection
        # In ComfyUI, ALL 15 control layers run again during main layers (even for broken mode),
        # injecting residuals at stride-2 positions: main_layer[2*k] gets control_layer[k]
        cnet_layer_idx = 0
        n_control_layers = len(controlnet_model.control_layers) if use_cnet else 0
        div = max(1, round(len(self.layers) / n_control_layers)) if n_control_layers > 0 else 2

        for i, l in enumerate(self.layers):
            if use_cnet:
                cnet_idx = i // div
                # Advance control context and inject residuals at stride-2 positions
                if cnet_idx < n_control_layers and cnet_layer_idx <= cnet_idx:
                    while cnet_layer_idx <= cnet_idx and cnet_layer_idx < n_control_layers:
                        main_img = unified_original_img
                        cos_c = cos[:, :cnet_ctx.shape[1]]
                        sin_c = sin[:, :cnet_ctx.shape[1]]
                        residual, cnet_ctx = controlnet_model.control_layers[cnet_layer_idx](
                            cnet_ctx, main_img, temb, cos_c, sin_c)
                        cnet_layer_idx += 1
                        # Inject residual into main model's image tokens
                        unified = mx.concatenate(
                            [unified[:, :x_len] + residual * controlnet_strength,
                             unified[:, x_len:]], axis=1)

            # Legacy support: pre-computed samples
            if controlnet_samples is not None and not use_cnet and i % 2 == 0:
                ctrl_idx = i // 2
                if ctrl_idx < len(controlnet_samples):
                    ctrl = controlnet_samples[ctrl_idx]
                    unified = mx.concatenate(
                        [unified[:, :x_len] + ctrl, unified[:, x_len:]],
                        axis=1,
                    )

            unified = l(unified, unified_mask, unified_pos, temb, cos=cos, sin=sin)

        return self.final_layer(unified[:, :x_len, :], temb)
