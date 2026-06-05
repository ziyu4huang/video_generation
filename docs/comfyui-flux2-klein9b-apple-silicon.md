# ComfyUI + Flux 2 Klein 9B on Apple Silicon (MPS)

Complete setup guide for running the Flux 2 Klein 9B workflow on macOS with Apple Silicon. This documents every issue encountered and how it was resolved.

## Overview

- **Model**: Flux 2 Klein 9B (Black Forest Labs)
- **Platform**: macOS, Apple Silicon (MPS backend)
- **Python**: 3.13 (Homebrew)
- **ComfyUI version**: 0.24.0
- **Generation time**: ~158s per run (4 images, 864×2016)

---

## 1. Install ComfyUI

```bash
cd /Users/huangziyu/proj/video_generation
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI

# Create isolated venv with Python 3.13 (system Python 3.9 is too old)
/opt/homebrew/bin/python3.13 -m venv .venv
.venv/bin/pip install --upgrade pip

# Install PyTorch CPU/MPS build first
.venv/bin/pip install torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cpu

# Install remaining ComfyUI dependencies
.venv/bin/pip install -r requirements.txt
```

Launch script (`ComfyUI/run.sh`):

```bash
#!/usr/bin/env bash
cd "$(dirname "$0")"
.venv/bin/python main.py "$@"
```

---

## 2. Install Custom Nodes

```bash
cd ComfyUI/custom_nodes

# ComfyUI Manager (node management UI)
git clone https://github.com/ltdrdata/ComfyUI-Manager.git

# KJNodes — INTConstant, StringConstant
git clone https://github.com/kijai/ComfyUI-KJNodes.git

# Resolution Master — ResolutionMaster
git clone https://github.com/Azornes/Comfyui-Resolution-Master.git

# RMBG — AILab_ImageStitch
git clone https://github.com/1038lab/ComfyUI-RMBG.git

# cg-use-everywhere — ue_properties support
git clone https://github.com/chrisgoringe/cg-use-everywhere.git

# Install RMBG deps (CPU onnxruntime, no GPU version on Mac)
cd ../
.venv/bin/pip install onnxruntime transparent-background segment-anything \
    opencv-python protobuf hydra-core omegaconf iopath diffusers -q
```

### Stub nodes (VRAMReserver + MarkdownNote)

These two nodes used by the workflow are not in any public registry. Create `custom_nodes/flux2_klein_stubs.py`:

```python
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
```

---

## 3. Download Models

### Login to HuggingFace first

```bash
.venv/bin/pip install huggingface_hub
.venv/bin/python -c "from huggingface_hub import login; login()"
```

### VAE (320 MB, no license required)

```bash
.venv/bin/python -c "
from huggingface_hub import hf_hub_download; import shutil
path = hf_hub_download('Comfy-Org/flux2-dev', 'split_files/vae/flux2-vae.safetensors')
shutil.copy(path, 'models/vae/flux2-vae.safetensors')
"
```

### Text Encoder — Qwen 3 8B FP8 (8.2 GB, no license required)

```bash
.venv/bin/python -c "
from huggingface_hub import hf_hub_download; import shutil
path = hf_hub_download('Comfy-Org/flux2-klein-9B',
    'split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors')
shutil.copy(path, 'models/text_encoders/qwen_3_8b_fp8mixed.safetensors')
"
```

### Diffusion Model — Klein 9B FP8 (8.8 GB, **requires BFL license**)

1. Visit `https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8`
2. Accept the agreement with your HuggingFace account
3. Then download:

```bash
.venv/bin/python -c "
from huggingface_hub import hf_hub_download; import shutil
path = hf_hub_download('black-forest-labs/FLUX.2-klein-9b-fp8',
    'flux-2-klein-9b-fp8.safetensors')
shutil.copy(path, 'models/diffusion_models/flux-2-klein-9b-fp8.safetensors')
"
```

---

## 4. Convert FP8 Model to BF16 (Critical for Apple Silicon)

**The FP8 model cannot run on Apple MPS.** PyTorch's MPS backend does not support `Float8_e4m3fn` dtype. The error is:

```
TypeError: Trying to convert Float8_e4m3fn to the MPS backend but it does not have support for that dtype.
```

Flags like `--fp16-unet`, `--bf16-unet`, `--force-fp16` do **not** fix this — the issue occurs deep in the memory transfer path (`comfy-aimdo` / `cast_bias_weight`) before dtype conversion can happen.

**Solution: pre-convert the model to BF16** (one-time, ~5 min, produces ~17 GB file):

```python
# save as: convert_fp8_to_bf16.py
import torch
from safetensors import safe_open
from safetensors.torch import save_file
from pathlib import Path

src = Path("models/diffusion_models/flux-2-klein-9b-fp8.safetensors")
dst = Path("models/diffusion_models/flux-2-klein-9b-bf16.safetensors")

tensors = {}
with safe_open(str(src), framework="pt", device="cpu") as f:
    all_keys = list(f.keys())
    fp8_weights = {k for k in all_keys if f.get_tensor(k).dtype == torch.float8_e4m3fn}
    for key in all_keys:
        tensors[key] = f.get_tensor(key)

final = {}
skip_keys = set()
for key in all_keys:
    if key in skip_keys:
        continue
    t = tensors[key]
    if key in fp8_weights:
        scale_key = key.replace(".weight", ".weight_scale")
        if scale_key in tensors:
            t_bf16 = (t.float() * tensors[scale_key].float()).bfloat16()
            final[key] = t_bf16
            skip_keys.add(scale_key)   # drop the fp8 scale tensor
        else:
            final[key] = t.to(torch.bfloat16)
    elif key not in skip_keys:
        final[key] = t

save_file(final, str(dst))
print(f"Done: {dst.stat().st_size // 1024 // 1024} MB")
```

Run inside the ComfyUI directory:

```bash
cd ComfyUI
.venv/bin/python convert_fp8_to_bf16.py
```

---

## 5. Update Workflow to Use BF16 Model

Open the workflow JSON and change the `UNETLoader` node's widget value:

```
flux-2-klein-9b-fp8.safetensors  →  flux-2-klein-9b-bf16.safetensors
```

Or via Python:

```bash
python3 -c "
import json
with open('user/default/workflows/flux2-klein9b.json') as f:
    wf = json.load(f)
for n in wf.get('nodes', []):
    if n.get('type') == 'UNETLoader':
        wv = n.get('widgets_values', [])
        if wv: wv[0] = 'flux-2-klein-9b-bf16.safetensors'
with open('user/default/workflows/flux2-klein9b.json', 'w') as f:
    json.dump(wf, f)
"
```

---

## 6. Run ComfyUI

```bash
cd ComfyUI
./run.sh
# or:
.venv/bin/python main.py --port 8188
```

Open `http://127.0.0.1:8188` in a browser.

The workflow file is pre-loaded at:
```
ComfyUI/user/default/workflows/flux2-klein9b.json
```

For the `LoadImage` node, upload any reference image (the workflow uses it as img2img reference).

---

## 7. Expected Results

- **Generation time**: ~158 seconds per batch (4 images)
- **Output resolution**: 864×2016 (configurable via `ResolutionMaster` node)
- **Device**: MPS (Apple Silicon GPU, unified memory)
- **Output location**: `ComfyUI/output/ComfyUI_*.png`

---

## File Summary

| File | Size | Purpose |
|------|------|---------|
| `models/diffusion_models/flux-2-klein-9b-fp8.safetensors` | 8.8 GB | Original model (not used on Mac) |
| `models/diffusion_models/flux-2-klein-9b-bf16.safetensors` | 17 GB | **Converted model (use this)** |
| `models/text_encoders/qwen_3_8b_fp8mixed.safetensors` | 8.2 GB | Text encoder |
| `models/vae/flux2-vae.safetensors` | 320 MB | VAE |
| `custom_nodes/flux2_klein_stubs.py` | — | VRAMReserver + MarkdownNote stubs |
| `user/default/workflows/flux2-klein9b.json` | — | Workflow file |

---

## Troubleshooting

### `TypeError: Trying to convert Float8_e4m3fn to the MPS backend`

You are using the fp8 model. Switch to the bf16 model (see Step 4).

### `Error loading ComfyUI-RMBG: No module named 'groundingdino'`

Non-fatal. GroundingDINO and Triton are Linux/CUDA-only. The `AILab_ImageStitch` node (the one used by this workflow) still works without them.

### `Port 8188 is already in use`

```bash
lsof -i :8188 | awk 'NR>1 {print $2}' | xargs kill -9
```

### Missing required input errors on first run

The `LoadImage` node references a specific image file. Upload any image to the node before queuing.
