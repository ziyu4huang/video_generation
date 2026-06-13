"""comfyui_workflow_parser — Parse ComfyUI workflow JSON into structured representation.

Extracts key parameters from node graph: sampler settings, outpaint padding,
model references, prompts, and custom node dependencies.

Usage:
    from app.comfyui_workflow_parser import parse_workflow_file, print_workflow_summary
    summary = parse_workflow_file("workflow.json")
    print_workflow_summary(summary)
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class NodeInfo:
    """A single ComfyUI node with its widget values."""
    id: str
    type: str
    title: str
    params: dict[str, Any]        # Named widget values
    inputs: dict[str, str]        # input_name → connected node_id
    outputs: list[dict[str, Any]]           # Output slot info
    widget_values: list[Any]                # Raw positional widget values
    mode: int = 0                 # 0=normal, 4=bypassed/muted


@dataclass
class ModelRef:
    """A model/LoRA/VAE reference found in the workflow."""
    node_type: str                # e.g. "UNETLoader", "LoraLoader", "VAELoader"
    model_name: str               # e.g. "flux-2-klein-9b-bf16.safetensors"
    model_type: str               # e.g. "unet", "clip", "vae", "lora"
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class WorkflowSummary:
    """Structured summary of a ComfyUI workflow."""
    name: str
    node_count: int
    nodes: list[NodeInfo]
    models: list[ModelRef]
    sampler_params: dict[str, Any]       # From KSampler/SamplerCustomAdvanced
    outpaint_params: dict[str, Any]      # From ImagePadForOutpaint
    inpaint_params: dict[str, Any]       # From InpaintModelConditioning
    prompts: list[str]                   # Extracted prompt texts
    custom_nodes: set[str]               # Node types requiring custom packages
    link_count: int = 0
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Node type → widget name mapping
# ---------------------------------------------------------------------------

# Maps node_type to (widget_names, model_type).
# widget_names order must match widgets_values positional order.
_NODE_WIDGET_MAP: dict[str, tuple[list[str], str]] = {
    "KSampler": (["seed", "control_after_generate", "steps", "cfg", "sampler_name",
                   "scheduler", "denoise"], "sampler"),
    "KSamplerAdvanced": (["add_noise", "noise_seed", "control_after_generate",
                           "steps", "cfg", "sampler_name", "scheduler",
                           "start_at_step", "end_at_step", "return_with_leftover_noise"], "sampler"),
    "SamplerCustomAdvanced": ([], "sampler"),
    "KSamplerSelect": (["sampler_name"], "sampler"),
    "Flux2Scheduler": (["steps", "width", "height"], "scheduler"),
    "BasicScheduler": (["scheduler", "steps", "denoise"], "scheduler"),
    "CFGGuider": (["cfg"], "sampler"),
    "RandomNoise": (["noise_seed", "control_after_generate"], "noise"),
    "UNETLoader": (["unet_name", "weight_dtype"], "unet"),
    "CheckpointLoaderSimple": (["ckpt_name"], "unet"),
    "CLIPLoader": (["clip_name", "type", "device"], "clip"),
    "VAELoader": (["vae_name"], "vae"),
    "DualCLIPLoader": (["clip_name1", "clip_name2", "type"], "clip"),
    "LoraLoader": (["lora_name", "strength_model", "strength_clip"], "lora"),
    "LoraLoaderModelOnly": (["lora_name", "strength_model"], "lora"),
    "CLIPTextEncode": (["text"], "prompt"),
    "ImagePadForOutpaint": (["left", "top", "right", "bottom", "feathering"], "outpaint"),
    "InpaintModelConditioning": (["noise_mask"], "inpaint"),
    "DifferentialDiffusion": (["strength"], "inpaint"),
    "SetLatentNoiseMask": ([], "inpaint"),
    "FluxGuidance": (["guidance"], "sampler"),
    "SaveImage": (["filename_prefix"], "output"),
    "PreviewImage": ([], "output"),
    "LoadImage": (["image", "upload"], "input"),
    "EmptyLatentImage": (["width", "height", "batch_size"], "latent"),
    "EmptySD3LatentImage": (["width", "height", "batch_size"], "latent"),
    "EmptyFlux2LatentImage": (["width", "height", "batch_size"], "latent"),
    "CR Prompt Text": (["prompt"], "prompt"),
    "PrimitiveInt": (["value", "control"], "primitive"),
    "PrimitiveFloat": (["value", "control"], "primitive"),
    "GetImageSize": ([], "utility"),
}

# Custom node prefixes that indicate third-party packages
_CUSTOM_NODE_PREFIXES = (
    "LayerUtility:", "CR ", "SeedVR2", "rgthree",
    "DrawMaskOnImage", "Image Comparer",
)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _parse_node(node_data: dict) -> NodeInfo:
    """Parse a single node from workflow JSON."""
    node_id = str(node_data.get("id", ""))
    node_type = node_data.get("type", "")
    title = node_data.get("title", node_type)
    mode = node_data.get("mode", 0)
    widget_values = node_data.get("widgets_values", [])

    # Build named params from widget map
    params: dict[str, Any] = {}
    if node_type in _NODE_WIDGET_MAP:
        widget_names, _ = _NODE_WIDGET_MAP[node_type]
        for i, name in enumerate(widget_names):
            if i < len(widget_values):
                params[name] = widget_values[i]

    # Build inputs map: input_name → source node_id (from links)
    inputs: dict[str, str] = {}
    for inp in node_data.get("inputs", []):
        link_id = inp.get("link")
        if link_id is not None:
            inputs[inp.get("name", "")] = str(link_id)

    outputs = node_data.get("outputs", [])

    return NodeInfo(
        id=node_id,
        type=node_type,
        title=title,
        params=params,
        inputs=inputs,
        outputs=outputs,
        widget_values=widget_values,
        mode=mode,
    )


def _is_custom_node(node_type: str) -> bool:
    """Check if a node type requires a custom package (not comfy-core)."""
    if node_type in _NODE_WIDGET_MAP:
        return False
    if node_type.startswith(_CUSTOM_NODE_PREFIXES):
        return True
    # Common comfy-core nodes
    core_nodes = {
        "SetNode", "GetNode", "MarkdownNote", "VAEDecode", "VAEEncode",
        "ConditioningZeroOut", "ReferenceLatent", "GetImageSize",
        "ImageScale", "ImageScaleBy", "ImageInvert", "CLIPSetLastLayer",
    }
    return node_type not in core_nodes


def _extract_models(nodes: list[NodeInfo]) -> list[ModelRef]:
    """Extract model references from loader nodes."""
    models = []
    for node in nodes:
        if node.type == "UNETLoader":
            models.append(ModelRef(
                node_type=node.type,
                model_name=node.params.get("unet_name", ""),
                model_type="unet",
                params={"weight_dtype": node.params.get("weight_dtype", "")},
            ))
        elif node.type == "CheckpointLoaderSimple":
            models.append(ModelRef(
                node_type=node.type,
                model_name=node.params.get("ckpt_name", ""),
                model_type="checkpoint",
            ))
        elif node.type == "CLIPLoader":
            models.append(ModelRef(
                node_type=node.type,
                model_name=node.params.get("clip_name", ""),
                model_type="clip",
                params={"type": node.params.get("type", ""), "device": node.params.get("device", "")},
            ))
        elif node.type == "DualCLIPLoader":
            models.append(ModelRef(
                node_type=node.type,
                model_name=node.params.get("clip_name1", ""),
                model_type="clip",
                params={"clip_name2": node.params.get("clip_name2", ""), "type": node.params.get("type", "")},
            ))
        elif node.type == "VAELoader":
            models.append(ModelRef(
                node_type=node.type,
                model_name=node.params.get("vae_name", ""),
                model_type="vae",
            ))
        elif node.type in ("LoraLoader", "LoraLoaderModelOnly"):
            models.append(ModelRef(
                node_type=node.type,
                model_name=node.params.get("lora_name", ""),
                model_type="lora",
                params={k: v for k, v in node.params.items() if k.startswith("strength")},
            ))
        # Custom model loaders (SeedVR2, etc.)
        elif "Load" in node.type and "Model" in node.type:
            if node.widget_values:
                models.append(ModelRef(
                    node_type=node.type,
                    model_name=str(node.widget_values[0]) if node.widget_values else "",
                    model_type="custom",
                ))
    return models


def _extract_sampler_params(nodes: list[NodeInfo]) -> dict[str, Any]:
    """Merge sampler-related parameters from KSampler, Flux2Scheduler, etc."""
    params: dict[str, Any] = {}
    for node in nodes:
        if node.type in ("KSampler", "KSamplerAdvanced"):
            params.update({
                k: v for k, v in node.params.items()
                if k in ("steps", "cfg", "sampler_name", "scheduler", "denoise")
            })
        elif node.type == "Flux2Scheduler":
            params["steps"] = node.params.get("steps", params.get("steps"))
            params["scheduler"] = "flux2"
        elif node.type == "BasicScheduler":
            params["scheduler"] = node.params.get("scheduler", params.get("scheduler"))
            params["steps"] = node.params.get("steps", params.get("steps"))
            params["denoise"] = node.params.get("denoise", params.get("denoise"))
        elif node.type == "KSamplerSelect":
            params["sampler_name"] = node.params.get("sampler_name", params.get("sampler_name"))
        elif node.type == "CFGGuider":
            params["cfg"] = node.params.get("cfg", params.get("cfg"))
        elif node.type == "RandomNoise":
            params["seed"] = node.params.get("noise_seed", params.get("seed"))
        elif node.type == "FluxGuidance":
            params["guidance"] = node.params.get("guidance", params.get("guidance"))
    return params


def _extract_outpaint_params(nodes: list[NodeInfo]) -> dict[str, Any]:
    """Extract outpaint-specific parameters."""
    params: dict[str, Any] = {}
    for node in nodes:
        if node.type == "ImagePadForOutpaint":
            params["padding"] = {
                "left": node.params.get("left", 0),
                "top": node.params.get("top", 0),
                "right": node.params.get("right", 0),
                "bottom": node.params.get("bottom", 0),
            }
            params["feathering"] = node.params.get("feathering", 0)
    return params


def _extract_inpaint_params(nodes: list[NodeInfo]) -> dict[str, Any]:
    """Extract inpaint-specific parameters."""
    params: dict[str, Any] = {}
    for node in nodes:
        if node.type == "InpaintModelConditioning":
            params["noise_mask"] = node.params.get("noise_mask")
        elif node.type == "DifferentialDiffusion":
            params["differential_strength"] = node.params.get("strength", 1.0)
        elif node.type == "SetLatentNoiseMask":
            params["set_latent_noise_mask"] = True
    return params


def _extract_prompts(nodes: list[NodeInfo]) -> list[str]:
    """Extract prompt texts from text encoding and prompt nodes."""
    prompts = []
    seen = set()
    for node in nodes:
        text = None
        if node.type == "CLIPTextEncode":
            text = node.params.get("text")
        elif node.type == "CR Prompt Text":
            text = node.params.get("prompt")
        if text and isinstance(text, str) and text.strip() and text not in seen:
            prompts.append(text)
            seen.add(text)
    return prompts


def parse_workflow(workflow_json: dict, name: str = "") -> WorkflowSummary:
    """Parse a ComfyUI workflow JSON into a structured summary.

    Args:
        workflow_json: The parsed JSON dict from a .json workflow file.
        name: Optional name for the workflow.

    Returns:
        WorkflowSummary with extracted parameters.
    """
    raw_nodes = workflow_json.get("nodes", [])
    links = workflow_json.get("links", [])

    nodes = [_parse_node(n) for n in raw_nodes]

    # Filter out muted/bypassed nodes
    active_nodes = [n for n in nodes if n.mode != 4]

    # Resolve link references: link_id → (from_node_id, from_slot, to_node_id, to_slot)
    # link format: [link_id, from_node_id, from_slot, to_node_id, to_slot, type_name]
    link_map: dict[int, tuple] = {}
    for link in links:
        if isinstance(link, list) and len(link) >= 6:
            link_map[link[0]] = (link[1], link[2], link[3], link[4])

    # Update node inputs to point to actual node IDs instead of link IDs
    for node in active_nodes:
        resolved = {}
        for inp_name, link_id_str in node.inputs.items():
            try:
                lid = int(link_id_str)
                if lid in link_map:
                    resolved[inp_name] = str(link_map[lid][0])  # source node id
                else:
                    resolved[inp_name] = link_id_str
            except (ValueError, TypeError):
                resolved[inp_name] = link_id_str
        node.inputs = resolved

    models = _extract_models(active_nodes)
    sampler_params = _extract_sampler_params(active_nodes)
    outpaint_params = _extract_outpaint_params(active_nodes)
    inpaint_params = _extract_inpaint_params(active_nodes)
    prompts = _extract_prompts(active_nodes)

    custom_nodes = set()
    for node in active_nodes:
        if _is_custom_node(node.type):
            custom_nodes.add(node.type)

    warnings = []
    if not sampler_params:
        warnings.append("No sampler parameters found")
    if not active_nodes:
        warnings.append("No active nodes found (all muted/bypassed?)")

    return WorkflowSummary(
        name=name or "unnamed",
        node_count=len(active_nodes),
        nodes=active_nodes,
        models=models,
        sampler_params=sampler_params,
        outpaint_params=outpaint_params,
        inpaint_params=inpaint_params,
        prompts=prompts,
        custom_nodes=custom_nodes,
        link_count=len(links),
        warnings=warnings,
    )


def parse_workflow_file(path: str | Path) -> WorkflowSummary:
    """Parse a ComfyUI workflow JSON file.

    Args:
        path: Path to the .json workflow file.

    Returns:
        WorkflowSummary with extracted parameters.
    """
    path = Path(path)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return parse_workflow(data, name=path.stem)


def get_outpaint_params(summary: WorkflowSummary) -> dict[str, Any]:
    """Get outpaint-specific parameters merged from a workflow summary.

    Returns a dict with 'padding', 'feathering', sampler settings, and models.
    """
    result: dict[str, Any] = {}
    if summary.outpaint_params:
        result.update(summary.outpaint_params)
    if summary.inpaint_params:
        result["inpaint"] = summary.inpaint_params
    if summary.sampler_params:
        result["sampler"] = summary.sampler_params
    unet_models = [m for m in summary.models if m.model_type == "unet"]
    if unet_models:
        result["model"] = unet_models[0].model_name
    return result


# ---------------------------------------------------------------------------
# Pretty-print
# ---------------------------------------------------------------------------

def print_workflow_summary(summary: WorkflowSummary) -> None:
    """Print a human-readable summary of a parsed workflow."""
    print(f"Workflow: {summary.name}")
    print(f"  Nodes: {summary.node_count} active ({summary.link_count} links)")

    # Sampler params
    if summary.sampler_params:
        sp = summary.sampler_params
        parts = []
        if "steps" in sp:
            parts.append(f"steps={sp['steps']}")
        if "cfg" in sp:
            parts.append(f"cfg={sp['cfg']}")
        if "sampler_name" in sp:
            parts.append(f"sampler={sp['sampler_name']}")
        if "scheduler" in sp:
            parts.append(f"scheduler={sp['scheduler']}")
        if "denoise" in sp:
            parts.append(f"denoise={sp['denoise']}")
        if "guidance" in sp:
            parts.append(f"guidance={sp['guidance']}")
        if "seed" in sp:
            parts.append(f"seed={sp['seed']}")
        print(f"  Sampler: {', '.join(parts)}")

    # Outpaint params
    if summary.outpaint_params:
        pad = summary.outpaint_params.get("padding", {})
        feather = summary.outpaint_params.get("feathering", "?")
        pad_str = f"L={pad.get('left',0)} T={pad.get('top',0)} R={pad.get('right',0)} B={pad.get('bottom',0)}"
        print(f"  Outpaint: padding=[{pad_str}], feathering={feather}")

    # Inpaint params
    if summary.inpaint_params:
        parts = [f"{k}={v}" for k, v in summary.inpaint_params.items()]
        print(f"  Inpaint: {', '.join(parts)}")

    # Models
    if summary.models:
        print(f"  Models ({len(summary.models)}):")
        for m in summary.models:
            extra = f" ({', '.join(f'{k}={v}' for k, v in m.params.items() if v)})" if m.params else ""
            print(f"    [{m.model_type}] {m.model_name}{extra}")

    # Prompts
    if summary.prompts:
        print(f"  Prompts ({len(summary.prompts)}):")
        for p in summary.prompts:
            snippet = p[:100] + "..." if len(p) > 100 else p
            print(f"    \"{snippet}\"")

    # Custom nodes
    if summary.custom_nodes:
        print(f"  Custom nodes ({len(summary.custom_nodes)}):")
        for cn in sorted(summary.custom_nodes):
            print(f"    - {cn}")

    # Warnings
    if summary.warnings:
        print(f"  Warnings:")
        for w in summary.warnings:
            print(f"    ⚠ {w}")
