"""Regression tests for app/comfyui_workflow_parser.py — ComfyUI workflow JSON parsing.

Pure Python — no external dependencies. Tests use inline workflow JSON dicts.
"""

import json
import pytest

from app.comfyui_workflow_parser import (
    NodeInfo,
    ModelRef,
    WorkflowSummary,
    _parse_node,
    _is_custom_node,
    _extract_models,
    _extract_sampler_params,
    _extract_outpaint_params,
    _extract_inpaint_params,
    _extract_prompts,
    parse_workflow,
    parse_workflow_file,
    get_outpaint_params,
    print_workflow_summary,
    _NODE_WIDGET_MAP,
)


# ==========================================================================
# _parse_node
# ==========================================================================

class TestParseNode:
    def test_ksampler_node(self):
        raw = {
            "id": 5,
            "type": "KSampler",
            "title": "Sampler",
            "mode": 0,
            "widgets_values": [42, "randomize", 9, 5.0, "euler", "normal", 0.5],
            "inputs": [{"name": "model", "link": 1}],
            "outputs": [{"type": "latent"}],
        }
        node = _parse_node(raw)
        assert node.type == "KSampler"
        assert node.params["seed"] == 42
        assert node.params["steps"] == 9
        assert node.params["cfg"] == 5.0
        assert node.mode == 0
        assert "model" in node.inputs

    def test_clip_text_encode(self):
        raw = {
            "id": 3,
            "type": "CLIPTextEncode",
            "widgets_values": ["a beautiful photo"],
            "inputs": [{"name": "clip", "link": 2}],
        }
        node = _parse_node(raw)
        assert node.type == "CLIPTextEncode"
        assert node.params["text"] == "a beautiful photo"

    def test_muted_node(self):
        raw = {"id": 99, "type": "KSampler", "mode": 4}
        node = _parse_node(raw)
        assert node.mode == 4

    def test_empty_widgets(self):
        raw = {"id": 1, "type": "PreviewImage", "widgets_values": []}
        node = _parse_node(raw)
        assert node.params == {}

    def test_unknown_type(self):
        """Unknown node type still produces a basic NodeInfo."""
        raw = {"id": 99, "type": "CustomNode123", "widgets_values": ["hello"]}
        node = _parse_node(raw)
        assert node.type == "CustomNode123"
        assert node.params == {}  # no widget map for unknown types

    def test_input_link_resolution(self):
        raw = {
            "id": 10,
            "type": "KSampler",
            "inputs": [{"name": "model", "link": 42}, {"name": "positive", "link": 7}],
        }
        node = _parse_node(raw)
        assert node.inputs["model"] == "42"
        assert node.inputs["positive"] == "7"


# ==========================================================================
# _is_custom_node
# ==========================================================================

class TestIsCustomNode:
    def test_known_core_node_returns_false(self):
        assert _is_custom_node("KSampler") is False
        assert _is_custom_node("VAEDecode") is False
        assert _is_custom_node("CLIPTextEncode") is False

    def test_custom_prefix_detected(self):
        # "CR " prefix — but CR Prompt Text is in the widget map so it's known
        assert _is_custom_node("CR Custom Something") is True
        assert _is_custom_node("LayerUtility: something") is True
        assert _is_custom_node("SeedVR2 something") is True

    def test_unknown_type_returns_true(self):
        """Unknown nodes are assumed custom."""
        assert _is_custom_node("TotallyRandomNodeName") is True

    def test_known_core_edge_cases(self):
        assert _is_custom_node("GetImageSize") is False  # in core_nodes


# ==========================================================================
# _extract_models
# ==========================================================================

class TestExtractModels:
    def test_unet_loader(self):
        node = NodeInfo(id="1", type="UNETLoader", title="", params={"unet_name": "model.safetensors", "weight_dtype": "fp8"},
                        inputs={}, outputs=[], widget_values=[])
        models = _extract_models([node])
        assert len(models) == 1
        assert models[0].model_type == "unet"
        assert models[0].model_name == "model.safetensors"

    def test_vae_loader(self):
        node = NodeInfo(id="2", type="VAELoader", title="", params={"vae_name": "vae.safetensors"},
                        inputs={}, outputs=[], widget_values=[])
        models = _extract_models([node])
        assert len(models) == 1
        assert models[0].model_type == "vae"

    def test_lora_loader(self):
        node = NodeInfo(id="3", type="LoraLoader", title="",
                        params={"lora_name": "style.safetensors", "strength_model": 0.8},
                        inputs={}, outputs=[], widget_values=[])
        models = _extract_models([node])
        assert len(models) == 1
        assert models[0].model_type == "lora"
        assert models[0].params["strength_model"] == 0.8

    def test_no_model_nodes_returns_empty(self):
        nodes = [
            NodeInfo(id="1", type="KSampler", title="", params={}, inputs={}, outputs=[], widget_values=[]),
            NodeInfo(id="2", type="SaveImage", title="", params={}, inputs={}, outputs=[], widget_values=[]),
        ]
        models = _extract_models(nodes)
        assert models == []

    def test_multiple_loaders(self):
        nodes = [
            NodeInfo(id="1", type="UNETLoader", title="", params={"unet_name": "a.safetensors"},
                     inputs={}, outputs=[], widget_values=[]),
            NodeInfo(id="2", type="VAELoader", title="", params={"vae_name": "b.safetensors"},
                     inputs={}, outputs=[], widget_values=[]),
            NodeInfo(id="3", type="LoraLoader", title="", params={"lora_name": "c.safetensors"},
                     inputs={}, outputs=[], widget_values=[]),
        ]
        models = _extract_models(nodes)
        assert len(models) == 3

    def test_dual_clip_loader(self):
        node = NodeInfo(id="1", type="DualCLIPLoader", title="",
                        params={"clip_name1": "c1.safetensors", "clip_name2": "c2.safetensors", "type": "flux"},
                        inputs={}, outputs=[], widget_values=[])
        models = _extract_models([node])
        assert len(models) == 1
        assert models[0].model_type == "clip"
        assert models[0].params["clip_name2"] == "c2.safetensors"

    def test_checkpoint_loader_simple(self):
        node = NodeInfo(id="1", type="CheckpointLoaderSimple", title="",
                        params={"ckpt_name": "checkpoint.safetensors"},
                        inputs={}, outputs=[], widget_values=[])
        models = _extract_models([node])
        assert len(models) == 1
        assert models[0].model_type == "checkpoint"


# ==========================================================================
# _extract_sampler_params
# ==========================================================================

class TestExtractSamplerParams:
    def test_ksampler(self):
        node = NodeInfo(id="1", type="KSampler", title="",
                        params={"steps": 9, "cfg": 5.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 0.5},
                        inputs={}, outputs=[], widget_values=[])
        params = _extract_sampler_params([node])
        assert params["steps"] == 9
        assert params["cfg"] == 5.0
        assert params["denoise"] == 0.5

    def test_no_sampler_params_returns_empty(self):
        params = _extract_sampler_params([])
        assert params == {}

    def test_flux2_scheduler(self):
        scheduler = NodeInfo(id="1", type="Flux2Scheduler", title="",
                             params={"steps": 4}, inputs={}, outputs=[], widget_values=[])
        params = _extract_sampler_params([scheduler])
        assert params["steps"] == 4
        assert params["scheduler"] == "flux2"

    def test_random_noise_seed(self):
        noise = NodeInfo(id="1", type="RandomNoise", title="",
                         params={"noise_seed": 777}, inputs={}, outputs=[], widget_values=[])
        params = _extract_sampler_params([noise])
        assert params["seed"] == 777

    def test_guidance(self):
        guide = NodeInfo(id="1", type="FluxGuidance", title="",
                         params={"guidance": 3.5}, inputs={}, outputs=[], widget_values=[])
        params = _extract_sampler_params([guide])
        assert params["guidance"] == 3.5


# ==========================================================================
# _extract_outpaint_params / _extract_inpaint_params
# ==========================================================================

class TestExtractOutpaintParams:
    def test_outpaint_padding(self):
        node = NodeInfo(id="1", type="ImagePadForOutpaint", title="",
                        params={"left": 64, "top": 0, "right": 64, "bottom": 0, "feathering": 10},
                        inputs={}, outputs=[], widget_values=[])
        params = _extract_outpaint_params([node])
        assert "padding" in params
        assert params["padding"]["left"] == 64
        assert params["feathering"] == 10

    def test_no_outpaint_nodes_returns_empty(self):
        assert _extract_outpaint_params([]) == {}


class TestExtractInpaintParams:
    def test_inpaint_conditioning(self):
        node = NodeInfo(id="1", type="InpaintModelConditioning", title="",
                        params={"noise_mask": True}, inputs={}, outputs=[], widget_values=[])
        params = _extract_inpaint_params([node])
        assert params["noise_mask"] is True

    def test_differential_diffusion(self):
        node = NodeInfo(id="1", type="DifferentialDiffusion", title="",
                        params={"strength": 0.5}, inputs={}, outputs=[], widget_values=[])
        params = _extract_inpaint_params([node])
        assert params["differential_strength"] == 0.5

    def test_no_inpaint_nodes_returns_empty(self):
        assert _extract_inpaint_params([]) == {}


# ==========================================================================
# _extract_prompts
# ==========================================================================

class TestExtractPrompts:
    def test_clip_text_encode(self):
        node = NodeInfo(id="1", type="CLIPTextEncode", title="",
                        params={"text": "a cat"}, inputs={}, outputs=[], widget_values=[])
        prompts = _extract_prompts([node])
        assert prompts == ["a cat"]

    def test_cr_prompt_text(self):
        node = NodeInfo(id="1", type="CR Prompt Text", title="",
                        params={"prompt": "a dog"}, inputs={}, outputs=[], widget_values=[])
        prompts = _extract_prompts([node])
        assert prompts == ["a dog"]

    def test_duplicate_prompts_deduplicated(self):
        nodes = [
            NodeInfo(id="1", type="CLIPTextEncode", title="",
                     params={"text": "duplicate"}, inputs={}, outputs=[], widget_values=[]),
            NodeInfo(id="2", type="CLIPTextEncode", title="",
                     params={"text": "duplicate"}, inputs={}, outputs=[], widget_values=[]),
        ]
        prompts = _extract_prompts(nodes)
        assert len(prompts) == 1

    def test_empty_prompt_skipped(self):
        node = NodeInfo(id="1", type="CLIPTextEncode", title="",
                        params={"text": ""}, inputs={}, outputs=[], widget_values=[])
        assert _extract_prompts([node]) == []

    def test_whitespace_only_prompt_skipped(self):
        node = NodeInfo(id="1", type="CLIPTextEncode", title="",
                        params={"text": "   "}, inputs={}, outputs=[], widget_values=[])
        assert _extract_prompts([node]) == []


# ==========================================================================
# parse_workflow — end-to-end
# ==========================================================================

class TestParseWorkflow:
    def test_minimal_workflow(self):
        """Minimal workflow with no nodes."""
        result = parse_workflow({"nodes": [], "links": []}, name="empty")
        assert result.name == "empty"
        assert result.node_count == 0
        assert result.warnings == ["No sampler parameters found", "No active nodes found (all muted/bypassed?)"]

    def test_full_workflow(self):
        """A realistic workflow with KSampler + UNETLoader + VAE + prompts."""
        workflow = {
            "nodes": [
                {"id": 1, "type": "KSampler", "widgets_values": [42, "randomize", 9, 5.0, "euler", "normal", 0.5]},
                {"id": 2, "type": "UNETLoader", "widgets_values": ["flux-model.safetensors", "fp8"]},
                {"id": 3, "type": "VAELoader", "widgets_values": ["vae.safetensors"]},
                {"id": 4, "type": "CLIPTextEncode", "widgets_values": ["a beautiful landscape"]},
                {"id": 5, "type": "SaveImage", "widgets_values": ["my_output"]},
            ],
            "links": [],
        }
        result = parse_workflow(workflow, name="test_workflow")
        assert result.node_count == 5
        assert len(result.sampler_params) > 0
        assert result.sampler_params["steps"] == 9
        assert len(result.models) == 2
        assert len(result.prompts) == 1
        assert result.prompts[0] == "a beautiful landscape"

    def test_muted_nodes_excluded(self):
        """Bypassed/muted nodes (mode=4) are excluded from summary."""
        workflow = {
            "nodes": [
                {"id": 1, "type": "KSampler", "mode": 0, "widgets_values": [42, "r", 9, 5, "euler", "n", 1.0]},
                {"id": 2, "type": "CLIPTextEncode", "mode": 4, "widgets_values": ["ignored prompt"]},
            ],
            "links": [],
        }
        result = parse_workflow(workflow)
        assert result.node_count == 1

    def test_link_resolution(self):
        """Links map input IDs to source node IDs."""
        workflow = {
            "nodes": [
                {"id": 1, "type": "KSampler", "inputs": [{"name": "model", "link": 0}], "widgets_values": [0, "r", 9, 5, "e", "n", 1.0]},
                {"id": 2, "type": "UNETLoader", "inputs": []},
            ],
            "links": [[0, 2, 0, 1, 0, "model"]],
        }
        result = parse_workflow(workflow)
        ksampler = result.nodes[0]
        assert ksampler.inputs["model"] == "2"  # resolved to node id 2

    def test_custom_node_detection(self):
        workflow = {
            "nodes": [
                {"id": 1, "type": "LayerUtility: MyNode", "widgets_values": []},
                {"id": 2, "type": "KSampler", "widgets_values": [0, "r", 9, 5, "e", "n", 1.0]},
            ],
            "links": [],
        }
        result = parse_workflow(workflow)
        assert "LayerUtility: MyNode" in result.custom_nodes

    def test_outpaint_workflow(self):
        workflow = {
            "nodes": [
                {"id": 1, "type": "ImagePadForOutpaint", "widgets_values": [64, 0, 64, 0, 10]},
                {"id": 2, "type": "KSampler", "widgets_values": [0, "r", 9, 5, "e", "n", 1.0]},
            ],
            "links": [],
        }
        result = parse_workflow(workflow)
        assert result.outpaint_params["padding"]["left"] == 64
        assert result.outpaint_params["feathering"] == 10


# ==========================================================================
# parse_workflow_file
# ==========================================================================

class TestParseWorkflowFile:
    def test_reads_json_file(self, tmp_path):
        wf = tmp_path / "test.json"
        wf.write_text(json.dumps({"nodes": [{"id": 1, "type": "KSampler", "widgets_values": [0, "r", 9, 5, "e", "n", 1.0]}]}))
        result = parse_workflow_file(str(wf))
        assert result.name == "test"
        assert result.node_count == 1

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            parse_workflow_file(str(tmp_path / "missing.json"))


# ==========================================================================
# get_outpaint_params
# ==========================================================================

class TestGetOutpaintParams:
    def test_merges_outpaint_and_sampler(self):
        summary = WorkflowSummary(
            name="test", node_count=0, nodes=[], models=[],
            sampler_params={"steps": 9, "cfg": 5},
            outpaint_params={"padding": {"left": 64}, "feathering": 10},
            inpaint_params={}, prompts=[], custom_nodes=set(),
        )
        result = get_outpaint_params(summary)
        assert result["padding"]["left"] == 64
        assert result["sampler"]["steps"] == 9


# ==========================================================================
# print_workflow_summary — output format
# ==========================================================================

class TestPrintWorkflowSummary:
    def test_output_format(self, capsys):
        summary = WorkflowSummary(
            name="my_workflow", node_count=3,
            nodes=[NodeInfo(id="1", type="KSampler", title="S", params={"steps": 9},
                            inputs={}, outputs=[], widget_values=[])],
            models=[ModelRef(node_type="UNETLoader", model_name="model.safetensors", model_type="unet")],
            sampler_params={"steps": 9, "cfg": 5.0},
            outpaint_params={}, inpaint_params={},
            prompts=["a dog"], custom_nodes={"LayerUtility: MyNode"},
            link_count=5,
        )
        print_workflow_summary(summary)
        out = capsys.readouterr().out
        assert "my_workflow" in out
        assert "3 active" in out
        assert "steps=9" in out
        assert "model.safetensors" in out
        assert "LayerUtility: MyNode" in out

    def test_warnings_output(self, capsys):
        summary = WorkflowSummary(name="empty", node_count=0, nodes=[], models=[], sampler_params={},
                                  outpaint_params={}, inpaint_params={}, prompts=[], custom_nodes=set(),
                                  warnings=["No sampler parameters found"])
        print_workflow_summary(summary)
        out = capsys.readouterr().out
        assert "Warning" in out or "⚠" in out


# ==========================================================================
# _NODE_WIDGET_MAP integrity
# ==========================================================================

class TestNodeWidgetMap:
    """Regression: ensure known entries exist in the widget map."""

    def test_key_types_present(self):
        for key in ("KSampler", "KSamplerAdvanced", "CLIPTextEncode", "UNETLoader",
                    "VAELoader", "LoraLoader", "SaveImage", "EmptyLatentImage"):
            assert key in _NODE_WIDGET_MAP, f"Missing widget map entry: {key}"

    def test_sampler_has_steps_and_cfg(self):
        names, _ = _NODE_WIDGET_MAP["KSampler"]
        assert "steps" in names
        assert "cfg" in names
        assert "seed" in names
