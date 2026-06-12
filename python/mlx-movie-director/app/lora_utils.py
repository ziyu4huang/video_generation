import mlx.core as mx
import mlx.nn as nn
import os
import re
import math
from safetensors import safe_open


def _mx_kron(a, b):
    """Kronecker product of two 2D MLX arrays: [m,n] x [p,q] -> [m*p, n*q]."""
    m, n = a.shape
    p, q = b.shape
    return (a.reshape(m, 1, n, 1) * b.reshape(1, p, 1, q)).reshape(m * p, n * q)


def _convert_lokr_key(key):
    """Map LoKR source module path to MLX model module path."""
    key = key.replace("diffusion_model.", "")
    # to_out in source is nn.ModuleList([Linear, Dropout]), .0 = Linear
    key = key.replace("attention.to_out.0", "attention.to_out")
    # adaLN_modulation in source has trailing .N group index
    key = re.sub(r"adaLN_modulation\.\d+$", "adaLN_modulation", key)
    return key


def _apply_lokr_delta(module, delta_w):
    """Add delta_w to a QuantizedLinear or Linear weight in-place."""
    if isinstance(module, nn.QuantizedLinear):
        W = mx.dequantize(module.weight, module.scales, module.biases,
                          module.group_size, module.bits)
        if W.shape != delta_w.shape:
            delta_w = delta_w.T
        W_new = (W + delta_w.astype(mx.float32)).astype(mx.float32)
        wq, scales, biases = mx.quantize(W_new, module.group_size, module.bits)
        mx.eval(wq, scales, biases)
        module.weight = wq
        module.scales = scales
        module.biases = biases
    elif isinstance(module, nn.Linear):
        W = module.weight
        if W.shape != delta_w.shape:
            delta_w = delta_w.T
        module.weight = (W + delta_w.astype(W.dtype))
        mx.eval(module.weight)
    else:
        return False
    return True


def _apply_lokr(model, tensors, user_scale):
    """Apply LoKR (Kronecker LoRA) weights to model in-place."""
    # Group keys by base module path (strip .lokr_w1/.lokr_w2/.alpha)
    groups = {}
    suffix_types = {".lokr_w1": "w1", ".lokr_w2": "w2", ".alpha": "alpha"}
    for key in tensors:
        for suffix, kind in suffix_types.items():
            if key.endswith(suffix):
                base = key[: -len(suffix)]
                groups.setdefault(base, {})[kind] = tensors[key]
                break

    applied = 0
    for base_key, g in groups.items():
        if "w1" not in g or "w2" not in g:
            continue
        mlx_key = _convert_lokr_key(base_key)
        target = get_module_by_name(model, mlx_key)
        if target is None:
            continue

        w1 = g["w1"].astype(mx.float32)
        w2 = g["w2"].astype(mx.float32)
        # alpha in this LoKR format is ~1e10 (stored as training ref, not a divisor).
        # The w1/w2 weights are pre-scaled; effective delta = kron(w1, w2) * user_scale.
        delta_w = _mx_kron(w1, w2) * user_scale
        mx.eval(delta_w)

        if _apply_lokr_delta(target, delta_w):
            applied += 1

    if applied == 0:
        print("    [LoKR] Failed to apply any layers. Key mismatch suspected.")
    else:
        print(f"   [LoKR] Applied {applied} layers.")
    return model


class LoRALinearWrapper(nn.Module):
    def __init__(self, base_layer, lora_a, lora_b, scale=1.0):
        super().__init__()
        self.base_layer = base_layer
        self.lora_a = lora_a
        self.lora_b = lora_b
        self.scale = scale

    def __call__(self, x):
        base_out = self.base_layer(x)

        dtype = x.dtype
        x = x.astype(self.lora_a.dtype)

        a = self.lora_a
        b = self.lora_b

        if a.shape[0] != x.shape[-1]:
            a = a.T

        if b.shape[0] != a.shape[-1]:
            b = b.T

        lora_out = (x @ a @ b) * self.scale
        return base_out + lora_out.astype(dtype)


def get_module_by_name(model, module_name):
    parts = module_name.split('.')
    obj = model
    for part in parts:
        try:
            if part.isdigit():
                idx = int(part)
                if isinstance(obj, list):
                    obj = obj[idx]
                elif isinstance(obj, dict):
                    obj = obj[idx] if idx in obj else obj[part]
                else:
                    obj = getattr(obj, part) if hasattr(obj, part) else None
            else:
                obj = getattr(obj, part) if hasattr(obj, part) else None

            if obj is None: return None
        except (AttributeError, IndexError, KeyError, TypeError):
            return None
    return obj


def set_module_by_name(model, module_name, new_module):
    parts = module_name.split('.')
    parent = model
    for part in parts[:-1]:
        if part.isdigit():
            idx = int(part)
            if isinstance(parent, list):
                parent = parent[idx]
            elif isinstance(parent, dict):
                parent = parent[idx] if idx in parent else parent[part]
            else:
                parent = getattr(parent, part)
        else:
            parent = getattr(parent, part)

    last = parts[-1]
    if last.isdigit():
        idx = int(last)
        if isinstance(parent, list):
            parent[idx] = new_module
        elif isinstance(parent, dict):
            parent[idx] = new_module
    else:
        setattr(parent, last, new_module)


def convert_unet_key_to_mlx(key):
    new_key = key.replace("lora_unet_", "")
    new_key = new_key.replace("diffusion_model.", "")

    new_key = re.sub(r'layers_(\d+)_', r'layers.\1.', new_key)

    new_key = new_key.replace("attention_to_q", "attention.to_q")
    new_key = new_key.replace("attention_to_k", "attention.to_k")
    new_key = new_key.replace("attention_to_v", "attention.to_v")

    new_key = new_key.replace("attention_to_out_0", "attention.to_out")
    new_key = new_key.replace("attention_to_out", "attention.to_out")

    new_key = new_key.replace("feed_forward_w1", "feed_forward.w1")
    new_key = new_key.replace("feed_forward_w2", "feed_forward.w2")
    new_key = new_key.replace("feed_forward_w3", "feed_forward.w3")

    if "adaLN_modulation" in new_key:
        if "adaLN_modulation.1" in new_key:
            pass
        else:
            new_key = new_key.replace("adaLN_modulation_0", "adaLN_modulation")
            new_key = new_key.replace("adaLN_modulation_1", "adaLN_modulation")

    return new_key


def apply_lora(model, lora_path, scale=1.0):
    if not os.path.exists(lora_path):
        print(f"LoRA file not found: {lora_path}")
        return model

    print(f"   [LoRA] Loading weights from {lora_path} (User Scale: {scale})")

    tensors = {}
    try:
        with safe_open(lora_path, framework="pt", device="cpu") as f:
            for k in f.keys():
                tensors[k] = mx.array(f.get_tensor(k).float().numpy()).astype(mx.bfloat16)
    except Exception as e:
        print(f"Failed to load LoRA: {e}")
        return model

    # Dispatch to LoKR handler if the file uses Kronecker format
    if any("lokr_w1" in k for k in tensors):
        print(f"   [LoRA] Detected LoKR (Kronecker) format.")
        return _apply_lokr(model, tensors, scale)

    lora_groups = {}

    for key in tensors.keys():
        if "alpha" in key:
            base = key.replace(".alpha", "")
            if base not in lora_groups: lora_groups[base] = {}
            lora_groups[base]["alpha"] = tensors[key]
            continue

        if "lora" not in key: continue

        type_ = None
        base = None

        if "lora_down" in key:
            base = key.split(".lora_down")[0]
            type_ = "A"
        elif "lora_up" in key:
            base = key.split(".lora_up")[0]
            type_ = "B"
        elif "lora_A" in key:
            base = key.split(".lora_A")[0]
            type_ = "A"
        elif "lora_B" in key:
            base = key.split(".lora_B")[0]
            type_ = "B"

        if base and type_:
            if base not in lora_groups: lora_groups[base] = {}
            lora_groups[base][type_] = tensors[key]

    applied_count = 0
    print(f"   [LoRA] Applying adapters with Alpha scaling...")

    for lora_key, group in lora_groups.items():
        if "A" not in group or "B" not in group: continue

        final_key = convert_unet_key_to_mlx(lora_key)
        target = get_module_by_name(model, final_key)

        if target:
            lora_a = group["A"]
            lora_b = group["B"]

            rank = min(lora_a.shape)

            if "alpha" in group:
                alpha = group["alpha"].item()
                scale_factor = alpha / rank
            else:
                scale_factor = 1.0

            final_scale = scale * scale_factor

            if isinstance(target, LoRALinearWrapper):
                base = target.base_layer
            else:
                base = target

            wrapped = LoRALinearWrapper(base, lora_a, lora_b, final_scale)
            set_module_by_name(model, final_key, wrapped)
            applied_count += 1

    if applied_count == 0:
        print("    Failed to apply any layers. Naming mismatch suspected.")
    else:
        print(f"   [LoRA] Applied {applied_count} layers. (Logic: Auto-Alpha & Rename)")

    return model
