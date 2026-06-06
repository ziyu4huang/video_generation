"""Weight key remapping: ComfyUI safetensors → MLX model keys.

Adapted from mflux's SeedVR2WeightMapping (weights/seedvr2_weight_mapping.py).
Used by convert.py to remap keys during model conversion.
"""


def get_transformer_remapping(num_blocks: int = 32) -> dict[str, str]:
    """Return a dict mapping source (ComfyUI) keys → target (MLX model) keys.

    Keys with {block} placeholder are expanded for 0..num_blocks-1.
    """
    mapping = {}

    # Top-level
    mapping["vid_in.proj.weight"] = "vid_in.proj.weight"
    mapping["vid_in.proj.bias"] = "vid_in.proj.bias"
    mapping["txt_in.weight"] = "txt_in.weight"
    mapping["txt_in.bias"] = "txt_in.bias"

    # Time embedding
    mapping["emb_in.proj_in.weight"] = "emb_in.proj_in.weight"
    mapping["emb_in.proj_in.bias"] = "emb_in.proj_in.bias"
    mapping["emb_in.proj_hid.weight"] = "emb_in.proj_hid.weight"
    mapping["emb_in.proj_hid.bias"] = "emb_in.proj_hid.bias"
    mapping["emb_in.proj_out.weight"] = "emb_in.proj_out.weight"
    mapping["emb_in.proj_out.bias"] = "emb_in.proj_out.bias"

    # Output
    mapping["vid_out_norm.weight"] = "vid_out_norm.weight"
    mapping["vid_out_ada.out_shift"] = "out_shift"
    mapping["vid_out_ada.out_scale"] = "out_scale"
    mapping["vid_out.proj.weight"] = "vid_out.proj.weight"
    mapping["vid_out.proj.bias"] = "vid_out.proj.bias"

    # Per-block keys
    for i in range(num_blocks):
        b = str(i)
        block_prefix_src = f"blocks.{b}."
        block_prefix_dst = f"blocks.{b}."

        # Attention QKV — may be vid/txt specific or shared (all)
        for suffix in ["weight", "bias"]:
            # QKV vid
            mapping[f"{block_prefix_src}attn.proj_qkv.vid.{suffix}"] = f"{block_prefix_dst}attn.proj_qkv_vid.{suffix}"
            mapping[f"{block_prefix_src}attn.proj_qkv.all.{suffix}"] = f"{block_prefix_dst}attn.proj_qkv_vid.{suffix}"
            # QKV txt (no bias for qkv usually, but include for safety)
            if suffix == "weight":
                mapping[f"{block_prefix_src}attn.proj_qkv.txt.{suffix}"] = f"{block_prefix_dst}attn.proj_qkv_txt.{suffix}"

            # Output projection
            mapping[f"{block_prefix_src}attn.proj_out.vid.{suffix}"] = f"{block_prefix_dst}attn.proj_out_vid.{suffix}"
            mapping[f"{block_prefix_src}attn.proj_out.all.{suffix}"] = f"{block_prefix_dst}attn.proj_out_vid.{suffix}"
            mapping[f"{block_prefix_src}attn.proj_out.txt.{suffix}"] = f"{block_prefix_dst}attn.proj_out_txt.{suffix}"

        # Norms
        mapping[f"{block_prefix_src}attn.norm_q.vid.weight"] = f"{block_prefix_dst}attn.norm_q_vid.weight"
        mapping[f"{block_prefix_src}attn.norm_q.all.weight"] = f"{block_prefix_dst}attn.norm_q_vid.weight"
        mapping[f"{block_prefix_src}attn.norm_q.txt.weight"] = f"{block_prefix_dst}attn.norm_q_txt.weight"
        mapping[f"{block_prefix_src}attn.norm_k.vid.weight"] = f"{block_prefix_dst}attn.norm_k_vid.weight"
        mapping[f"{block_prefix_src}attn.norm_k.all.weight"] = f"{block_prefix_dst}attn.norm_k_vid.weight"
        mapping[f"{block_prefix_src}attn.norm_k.txt.weight"] = f"{block_prefix_dst}attn.norm_k_txt.weight"

        # RoPE freqs
        mapping[f"{block_prefix_src}attn.rope.rope.freqs"] = f"{block_prefix_dst}attn.rope.freqs"

        # MLP — vid, txt, all
        for part in ["vid", "txt", "all"]:
            for layer in ["proj_in", "proj_in_gate", "proj_out"]:
                for suffix in ["weight", "bias"]:
                    src_key = f"{block_prefix_src}mlp.{part}.{layer}.{suffix}"
                    dst_key = f"{block_prefix_dst}mlp.{part}.{layer}.{suffix}"
                    mapping[src_key] = dst_key

        # Ada modulation params
        for part in ["vid", "txt", "all"]:
            for param in ["attn_shift", "attn_scale", "attn_gate", "mlp_shift", "mlp_scale", "mlp_gate"]:
                src_key = f"{block_prefix_src}ada.{part}.{param}"
                if part == "vid":
                    dst_key = f"{block_prefix_dst}ada.params_vid.{param}"
                elif part == "txt":
                    dst_key = f"{block_prefix_dst}ada.params_txt.{param}"
                else:
                    dst_key = f"{block_prefix_dst}ada.params_all.{param}"
                mapping[src_key] = dst_key

    return mapping


def get_vae_remapping() -> dict[str, str]:
    """Return a dict mapping source VAE keys → target VAE keys.

    VAE Conv3d weights need transposition from PyTorch format to MLX format.
    """
    mapping = {}
    for part in ["encoder", "decoder"]:
        # conv_in / conv_out / conv_norm_out
        for name in ["conv_in", "conv_out"]:
            mapping[f"{part}.{name}.weight"] = f"{part}.{name}.weight"
            mapping[f"{part}.{name}.bias"] = f"{part}.{name}.bias"
        mapping[f"{part}.conv_norm_out.weight"] = f"{part}.conv_norm_out.weight"
        mapping[f"{part}.conv_norm_out.bias"] = f"{part}.conv_norm_out.bias"

        # Mid block
        for i in range(2):
            for name in ["conv1", "conv2"]:
                mapping[f"{part}.mid_block.resnets.{i}.{name}.weight"] = f"{part}.mid_block.resnets.{i}.{name}.weight"
                mapping[f"{part}.mid_block.resnets.{i}.{name}.bias"] = f"{part}.mid_block.resnets.{i}.{name}.bias"
            for name in ["norm1", "norm2"]:
                mapping[f"{part}.mid_block.resnets.{i}.{name}.weight"] = f"{part}.mid_block.resnets.{i}.{name}.weight"
                mapping[f"{part}.mid_block.resnets.{i}.{name}.bias"] = f"{part}.mid_block.resnets.{i}.{name}.bias"

        # Mid block attention
        for name in ["group_norm.weight", "group_norm.bias",
                      "to_q.weight", "to_q.bias",
                      "to_k.weight", "to_k.bias",
                      "to_v.weight", "to_v.bias",
                      "to_out.0.weight", "to_out.0.bias"]:
            mapping[f"{part}.mid_block.attentions.0.{name}"] = f"{part}.mid_block.attentions.0.{name}"

        # Encoder down blocks / Decoder up blocks
        if part == "encoder":
            block_type = "down_blocks"
            res_range = 2  # layers_per_block
            for block_idx in range(4):
                for res_idx in range(res_range):
                    for name in ["conv1", "conv2"]:
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"
                    for name in ["norm1", "norm2"]:
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"
                    # Shortcut (optional)
                    for suffix in ["weight", "bias"]:
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.conv_shortcut.{suffix}"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.conv_shortcut.{suffix}"
                # Downsampler (optional)
                for suffix in ["weight", "bias"]:
                    mapping[f"{part}.{block_type}.{block_idx}.downsamplers.0.conv.{suffix}"] = f"{part}.{block_type}.{block_idx}.downsamplers.0.conv.{suffix}"
        else:  # decoder
            block_type = "up_blocks"
            res_range = 3  # layers_per_block
            for block_idx in range(4):
                for res_idx in range(res_range):
                    for name in ["conv1", "conv2"]:
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"
                    for name in ["norm1", "norm2"]:
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.weight"
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.{name}.bias"
                    for suffix in ["weight", "bias"]:
                        mapping[f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.conv_shortcut.{suffix}"] = f"{part}.{block_type}.{block_idx}.resnets.{res_idx}.conv_shortcut.{suffix}"
                # Upsampler (optional)
                for suffix in ["weight", "bias"]:
                    mapping[f"{part}.{block_type}.{block_idx}.upsamplers.0.conv.{suffix}"] = f"{part}.{block_type}.{block_idx}.upsamplers.0.conv.{suffix}"
                    mapping[f"{part}.{block_type}.{block_idx}.upsamplers.0.upscale_conv.{suffix}"] = f"{part}.{block_type}.{block_idx}.upsamplers.0.upscale_conv.{suffix}"

    return mapping


def get_conv3d_weight_keys() -> set[str]:
    """Return the set of keys that are Conv3d weights and need transposition."""
    keys = set()
    for part in ["encoder", "decoder"]:
        for name in ["conv_in", "conv_out"]:
            keys.add(f"{part}.{name}.weight")
        for i in range(2):
            keys.add(f"{part}.mid_block.resnets.{i}.conv1.weight")
            keys.add(f"{part}.mid_block.resnets.{i}.conv2.weight")
        if part == "encoder":
            for block_idx in range(4):
                for res_idx in range(2):
                    keys.add(f"{part}.down_blocks.{block_idx}.resnets.{res_idx}.conv1.weight")
                    keys.add(f"{part}.down_blocks.{block_idx}.resnets.{res_idx}.conv2.weight")
                    keys.add(f"{part}.down_blocks.{block_idx}.resnets.{res_idx}.conv_shortcut.weight")
                keys.add(f"{part}.down_blocks.{block_idx}.downsamplers.0.conv.weight")
        else:
            for block_idx in range(4):
                for res_idx in range(3):
                    keys.add(f"{part}.up_blocks.{block_idx}.resnets.{res_idx}.conv1.weight")
                    keys.add(f"{part}.up_blocks.{block_idx}.resnets.{res_idx}.conv2.weight")
                    keys.add(f"{part}.up_blocks.{block_idx}.resnets.{res_idx}.conv_shortcut.weight")
                keys.add(f"{part}.up_blocks.{block_idx}.upsamplers.0.conv.weight")
                keys.add(f"{part}.up_blocks.{block_idx}.upsamplers.0.upscale_conv.weight")
    return keys
