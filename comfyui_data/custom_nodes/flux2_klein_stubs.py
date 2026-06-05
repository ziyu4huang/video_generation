"""
Stub nodes for Flux2 Klein workflow compatibility.
VRAMReserver: passthrough node that optionally offloads VRAM before passing the model.
MarkdownNote: display-only node, no-op at runtime.
"""


class VRAMReserver:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "anything": ("*",),
                "reserved": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 1.0, "step": 0.05}),
                "offload_all_vram": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("output",)
    FUNCTION = "run"
    CATEGORY = "utils"

    def run(self, anything=None, reserved=0.6, offload_all_vram=False):
        if offload_all_vram:
            try:
                import comfy.model_management as mm
                mm.unload_all_models()
                mm.soft_empty_cache()
            except Exception:
                pass
        return (anything,)


class MarkdownNote:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {"multiline": True, "default": ""})}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "utils"

    def run(self, text=""):
        return {}


NODE_CLASS_MAPPINGS = {
    "VRAMReserver": VRAMReserver,
    "MarkdownNote": MarkdownNote,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VRAMReserver": "VRAM Reserver",
    "MarkdownNote": "Markdown Note",
}
