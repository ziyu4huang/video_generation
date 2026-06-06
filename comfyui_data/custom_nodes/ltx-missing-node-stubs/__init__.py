"""
Stub nodes for LTX-2.3 workflow compatibility.

Provides placeholder implementations for nodes that require external API services
(LLM chat, LLM API) or are frontend-only (Fast Groups Muter).
These stubs let the workflow load and validate — they pass through text or
return defaults so the workflow can execute with manual prompts.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


# --- Dapao_LlamaChat stub ---
# Original: sends images + system/user prompts to an LLM API and returns generated text.
# Stub: returns a default video prompt. Users should edit CLIPTextEncode directly.
class Dapao_LlamaChat:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"default": "Cinematic style, dynamic camera movement, natural lighting, high quality video, smooth motion. 0-10秒, medium shot, slow dolly in, natural expressions, soft ambient lighting, shallow depth of field.", "multiline": True}),
            },
            "optional": {
                "image": ("IMAGE",),
                "image2": ("IMAGE",),
                "system_prompt": ("STRING", {"default": "", "multiline": True}),
                "user_prompt": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "generate"
    CATEGORY = "stubs"
    DESCRIPTION = "Stub: Returns the prompt text directly. Edit CLIPTextEncode for video prompts."

    def generate(self, prompt, image=None, image2=None, system_prompt="", user_prompt=""):
        return (prompt,)


NODE_CLASS_MAPPINGS["Dapao_LlamaChat"] = Dapao_LlamaChat
NODE_DISPLAY_NAME_MAPPINGS["Dapao_LlamaChat"] = "Dapao LlamaChat (Stub)"


# --- RH_LLMAPI_Pro_Node stub ---
# Original: calls RunningHub LLM API and returns text.
# Stub: returns a default text string.
class RH_LLMAPI_Pro_Node:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "execute"
    CATEGORY = "stubs"
    DESCRIPTION = "Stub: Returns the prompt text directly."

    def execute(self, prompt, image=None):
        return (prompt,)


NODE_CLASS_MAPPINGS["RH_LLMAPI_Pro_Node"] = RH_LLMAPI_Pro_Node
NODE_DISPLAY_NAME_MAPPINGS["RH_LLMAPI_Pro_Node"] = "RH LLM API Pro (Stub)"


# --- Fast Groups Muter (rgthree) stub ---
# Original: frontend-only JS node for toggling groups. Has no Python-side outputs.
# Stub: no-op node so the workflow loads without errors.
class FastGroupsMuter:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "stubs"
    DESCRIPTION = "Stub: Frontend-only group toggle (no-op)."

    def execute(self):
        return {}


NODE_CLASS_MAPPINGS["Fast Groups Muter (rgthree)"] = FastGroupsMuter
NODE_DISPLAY_NAME_MAPPINGS["Fast Groups Muter (rgthree)"] = "Fast Groups Muter (Stub)"

# --- InpaintModelConditioningTiled ---
# Same as InpaintModelConditioning but uses vae.encode_tiled() instead of vae.encode()
# to avoid "MPSGaph does not support tensor dims larger than INT_MAX" on Apple Silicon.
class InpaintModelConditioningTiled:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"positive": ("CONDITIONING",),
                             "negative": ("CONDITIONING",),
                             "vae": ("VAE",),
                             "pixels": ("IMAGE",),
                             "mask": ("MASK",),
                             "noise_mask": ("BOOLEAN", {"default": True}),
                             "tile_size": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 64}),
                             "overlap": ("INT", {"default": 64, "min": 0, "max": 4096, "step": 32}),
                             }}

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "encode"
    CATEGORY = "model/conditioning/inpaint"
    DESCRIPTION = "Inpaint conditioning using tiled VAE encoding (MPS-safe for large images)"

    def encode(self, positive, negative, pixels, vae, mask, noise_mask=True, tile_size=512, overlap=64):
        import torch
        from comfy import node_helpers

        x = (pixels.shape[1] // 8) * 8
        y = (pixels.shape[2] // 8) * 8
        mask = torch.nn.functional.interpolate(mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])), size=(pixels.shape[1], pixels.shape[2]), mode="bilinear")

        orig_pixels = pixels
        pixels = orig_pixels.clone()
        if pixels.shape[1] != x or pixels.shape[2] != y:
            x_offset = (pixels.shape[1] % 8) // 2
            y_offset = (pixels.shape[2] % 8) // 2
            pixels = pixels[:, x_offset:x + x_offset, y_offset:y + y_offset, :]
            mask = mask[:, :, x_offset:x + x_offset, y_offset:y + y_offset]

        m = (1.0 - mask.round()).squeeze(1)
        for i in range(3):
            pixels[:, :, :, i] -= 0.5
            pixels[:, :, :, i] *= m
            pixels[:, :, :, i] += 0.5
        concat_latent = vae.encode_tiled(pixels, tile_x=tile_size, tile_y=tile_size, overlap=overlap)
        orig_latent = vae.encode_tiled(orig_pixels, tile_x=tile_size, tile_y=tile_size, overlap=overlap)

        out_latent = {}
        out_latent["samples"] = orig_latent
        if noise_mask:
            out_latent["noise_mask"] = mask

        out = []
        for conditioning in [positive, negative]:
            c = node_helpers.conditioning_set_values(conditioning, {"concat_latent_image": concat_latent,
                                                                     "concat_mask": mask})
            out.append(c)
        return (out[0], out[1], out_latent)


NODE_CLASS_MAPPINGS["InpaintModelConditioningTiled"] = InpaintModelConditioningTiled
NODE_DISPLAY_NAME_MAPPINGS["InpaintModelConditioningTiled"] = "Inpaint Model Conditioning (Tiled/MPS-Safe)"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
