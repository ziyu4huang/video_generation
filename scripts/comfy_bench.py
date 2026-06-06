#!/usr/bin/env python3
"""ComfyUI Workflow Runner & Benchmark Tool.

Universal CLI to manage ComfyUI lifecycle, run any workflow,
collect metrics, and download outputs for VLM review.

Usage:
    # Lifecycle
    python scripts/comfy_bench.py start [--port 8188] [--force-restart]
    python scripts/comfy_bench.py stop  [--port 8188]
    python scripts/comfy_bench.py status

    # Run any workflow (universal)
    python scripts/comfy_bench.py run --workflow-file path/to/workflow.json --variant my-label --tag test
    python scripts/comfy_bench.py run --workflow-file workflow.json --variant fp8 --set-param 138.value=12

    # Run via convenience alias (backward compat)
    python scripts/comfy_bench.py run --workflow fp16 --tag baseline
    python scripts/comfy_bench.py run --workflow fp8 --param steps=12 --randomize-seeds

    # Other
    python scripts/comfy_bench.py run-ui --workflow fp16
    python scripts/comfy_bench.py convert --workflow fp16
    python scripts/comfy_bench.py baseline save --run-dir comfyui_data/output/bench_results/run-dir
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
import random
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import psutil
import requests
import websocket

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_DIR = Path(__file__).resolve().parent.parent
COMFY_DIR = REPO_DIR / "ComfyUI"
DATA_DIR = REPO_DIR / "comfyui_data"
VENV_PYTHON = COMFY_DIR / ".venv" / "bin" / "python"
OUTPUT_DIR = DATA_DIR / "output"
BENCH_RESULTS_DIR = OUTPUT_DIR / "bench_results"
RUN_SH = REPO_DIR / "run.sh"

WORKFLOW_MAP: dict[str, dict[str, Any]] = {
    "fp16": {
        "file": DATA_DIR / "user" / "default" / "workflows" / "flux2-klein9b-character-profile-fp16.json",
        "variant": "bf16",
        "save_prefix": "ComfyUI",
        "save_labels": {140: "front", 141: "back", 142: "side", 132: "stitched"},
    },
    "fp8": {
        "file": DATA_DIR / "user" / "default" / "workflows" / "flux2-klein9b-character-profile-fp8.json",
        "variant": "fp8",
        "save_prefix": "Klein9B-fp8",
        "save_labels": {140: "front", 141: "back", 142: "side", 132: "stitched"},
    },
    "img-exp-bf16": {
        "file": DATA_DIR / "user" / "default" / "workflows" / "flux2-klein-image-expansion.json",
        "variant": "bf16",
        "save_labels": {20: "expanded", 61: "upscaled"},
    },
    "img-exp-fp8": {
        "file": DATA_DIR / "user" / "default" / "workflows" / "flux2-klein-image-expansion-fp8.json",
        "variant": "fp8",
        "save_labels": {20: "expanded", 61: "upscaled"},
    },
}

# SaveImage node ID → view label (legacy global; per-workflow labels in WORKFLOW_MAP take precedence)
SAVE_IMAGE_LABELS: dict[int, str] = {
    140: "front",
    141: "back",
    142: "side",
    132: "stitched",
}

# Named parameter aliases → (node_id_str, input_name)
PARAM_ALIASES: dict[str, tuple[str, str]] = {
    "steps": ("138", "value"),
    "seed_front": ("2", "noise_seed"),
    "seed_back": ("120", "noise_seed"),
    "seed_side": ("130", "noise_seed"),
    "cfg_front": ("4", "cfg"),
    "cfg_back": ("116", "cfg"),
    "cfg_side": ("126", "cfg"),
    "desc": ("137", "string"),
}

BASELINE_DIR = BENCH_RESULTS_DIR / "baseline"


# ---------------------------------------------------------------------------
# Workflow resolution (alias or direct file path)
# ---------------------------------------------------------------------------


def _resolve_workflow(args: argparse.Namespace) -> tuple[Path, str]:
    """Resolve workflow file path and variant name from CLI args.

    Supports two modes:
      --workflow ALIAS       → lookup in WORKFLOW_MAP (backward compat)
      --workflow-file PATH   → direct file path (requires --variant)

    Returns (wf_path, variant_name).
    """
    wf_key = getattr(args, "workflow", None)
    wf_file = getattr(args, "workflow_file", None)

    if wf_key and wf_file:
        print("Cannot use both --workflow and --workflow-file")
        sys.exit(1)

    if wf_key:
        if wf_key not in WORKFLOW_MAP:
            print(f"Unknown workflow alias: {wf_key}. Available: {', '.join(WORKFLOW_MAP)}")
            sys.exit(1)
        info = WORKFLOW_MAP[wf_key]
        return info["file"], info["variant"]

    if wf_file:
        variant = getattr(args, "variant", None)
        if not variant:
            print("--variant is required when using --workflow-file")
            sys.exit(1)
        wf_path = Path(wf_file)
        if not wf_path.is_absolute():
            wf_path = REPO_DIR / wf_path
        if not wf_path.exists():
            print(f"Workflow file not found: {wf_path}")
            sys.exit(1)
        return wf_path, variant

    print("Specify --workflow ALIAS or --workflow-file PATH")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Static widget-order mapping (positional widgets_values → named inputs)
# ---------------------------------------------------------------------------

# Format: node_class_type -> list of API input names in positional order.
# Trailing UI-only values (control_after_generate, upload, collapsed state)
# are NOT listed — they are skipped during conversion.
WIDGET_ORDER: dict[str, list[str]] = {
    "UNETLoader": ["unet_name", "weight_dtype"],
    "CLIPLoader": ["clip_name", "type", "device"],
    "VAELoader": ["vae_name"],
    "KSamplerSelect": ["sampler_name"],
    "CFGGuider": ["cfg"],
    "RandomNoise": ["noise_seed"],  # skip control_after_generate
    "EmptyFlux2LatentImage": ["width", "height", "batch_size"],
    "Flux2Scheduler": ["steps", "width", "height"],
    "CLIPTextEncode": ["text"],
    "SaveImage": ["filename_prefix"],
    "LoadImage": ["image"],  # skip upload selector
    "StringConcatenate": ["string_a", "string_b", "delimiter"],
    "StringConstant": ["string"],
    "INTConstant": ["value"],
    "ImageScaleToTotalPixels": ["upscale_method", "megapixels", "resolution_steps"],
    "AILab_ImageStitch": [
        "stitch_mode", "match_image_size", "megapixels",
        "max_width", "max_height", "upscale_method", "spacing_width", "background_color",
    ],
    "VRAMReserver": ["reserved", "offload_all_vram"],
    # ResolutionMaster: 23 positional API inputs from widgets_values
    "ResolutionMaster": [
        "mode", "latent_format", "width", "height", "swap_dims",
        "lock_aspect", "aspect_ratio", "batch_size", "normalize",
        "flip", "randomize", "upscale", "landscape", "portrait",
        "preset", "tile_size", "tile_batch_size", "target_length",
        "tile_count", "preset_data", "lock_key", "aspect_value",
        "aspect_batch_size",
    ],
    # These have no widget values (all linked inputs)
    "SamplerCustomAdvanced": [],
    "VAEDecode": [],
    "VAEEncode": [],
    "ConditioningZeroOut": [],
    "ReferenceLatent": [],
    "GetImageSize": [],
    # image-expansion workflow nodes
    "SetNode": ["key"],
    "GetNode": ["key"],
    "PrimitiveInt": ["value"],   # skip trailing 'fixed' control value
    "CR Prompt Text": ["text"],
    "DifferentialDiffusion": ["strength"],
    "InpaintModelConditioning": ["noise_mask"],
    "DrawMaskOnImage": ["color", "device"],
    "ImagePadForOutpaint": ["left", "top", "right", "bottom", "feathering"],
    # SeedVR2: widgets_values has a UI-only 'randomize' control at index 1 after seed;
    # list only "seed" so the control value doesn't get mapped to a real input name.
    # resolution/batch/etc are handled via API lookup when ComfyUI is running.
    "SeedVR2VideoUpscaler": ["seed"],
    "SeedVR2LoadVAEModel": [
        "model", "device",
        "encode_tiled", "encode_tile_size", "encode_tile_overlap",
        "decode_tiled", "decode_tile_size", "decode_tile_overlap",
        "tile_debug", "offload_device", "cache_model",
    ],
    "SeedVR2LoadDiTModel": [
        "model", "device",
        "blocks_to_swap", "swap_io_components", "offload_device",
        "cache_model", "attention_mode",
    ],
}

# Node types that are UI-only and should be excluded from API payload
SKIP_NODE_TYPES = {"MarkdownNote", "Image Comparer (rgthree)", "PreviewImage"}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log = logging.getLogger("comfy_bench")


def setup_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )


# ===========================================================================
# ComfyUIClient — HTTP + WebSocket API wrapper
# ===========================================================================


class ComfyUIClient:
    """Wraps all ComfyUI REST API calls."""

    def __init__(self, base_url: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self._object_info_cache: dict[str, dict] = {}

    # -- health / system ----------------------------------------------------

    def is_alive(self) -> bool:
        try:
            r = self.session.get(f"{self.base_url}/system_stats", timeout=5)
            return r.status_code == 200
        except requests.RequestException:
            return False

    def get_system_stats(self) -> dict:
        r = self.session.get(f"{self.base_url}/system_stats", timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    # -- object info ---------------------------------------------------------

    def get_object_info(self, class_type: str) -> dict:
        if class_type not in self._object_info_cache:
            r = self.session.get(
                f"{self.base_url}/object_info/{class_type}", timeout=self.timeout
            )
            r.raise_for_status()
            data = r.json()
            self._object_info_cache[class_type] = data.get(class_type, data)
        return self._object_info_cache[class_type]

    # -- queue ---------------------------------------------------------------

    def get_queue(self) -> dict:
        r = self.session.get(f"{self.base_url}/queue", timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    # -- prompt submission ---------------------------------------------------

    def submit_prompt(self, workflow_api: dict, client_id: str) -> dict:
        payload = {"prompt": workflow_api, "client_id": client_id}
        r = self.session.post(
            f"{self.base_url}/prompt",
            json=payload,
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()

    # -- history -------------------------------------------------------------

    def get_history(self, prompt_id: str = "", max_items: int = 0) -> dict:
        if prompt_id:
            r = self.session.get(
                f"{self.base_url}/history/{prompt_id}", timeout=self.timeout
            )
            r.raise_for_status()
            return r.json()
        params: dict[str, str] = {}
        if max_items:
            params["max_items"] = str(max_items)
        r = self.session.get(
            f"{self.base_url}/history", params=params, timeout=self.timeout
        )
        r.raise_for_status()
        return r.json()

    # -- interrupt -----------------------------------------------------------

    def interrupt(self) -> None:
        self.session.post(f"{self.base_url}/interrupt", timeout=self.timeout)

    # -- image download ------------------------------------------------------

    def download_image(
        self, filename: str, subfolder: str, img_type: str, dest: Path
    ) -> Path:
        params: dict[str, str] = {"filename": filename}
        if subfolder:
            params["subfolder"] = subfolder
        if img_type:
            params["type"] = img_type
        r = self.session.get(
            f"{self.base_url}/view", params=params, timeout=self.timeout
        )
        r.raise_for_status()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        return dest

    # -- wait for completion -------------------------------------------------

    def wait_for_completion(
        self,
        prompt_id: str,
        client_id: str,
        timeout_sec: float = 1200.0,
        poll_interval: float = 2.0,
    ) -> dict:
        """Wait for a prompt to finish. Tries WebSocket first, falls back to polling."""
        result = self._wait_ws(prompt_id, client_id, timeout_sec)
        if result is not None:
            return result
        log.warning("WebSocket failed, falling back to HTTP polling")
        return self._wait_poll(prompt_id, timeout_sec, poll_interval)

    def _wait_ws(
        self, prompt_id: str, client_id: str, timeout_sec: float
    ) -> Optional[dict]:
        """WebSocket-based monitoring. Returns history entry or None on failure."""
        ws_url = self.base_url.replace("http", "ws") + f"/ws?clientId={client_id}"
        done = threading.Event()
        result_holder: list[Optional[dict]] = [None]
        error_holder: list[Optional[str]] = [None]

        def on_message(ws: websocket.WebSocketApp, msg: str | bytes) -> None:
            try:
                data = json.loads(msg)
            except (json.JSONDecodeError, TypeError):
                return
            msg_type = data.get("type", "")
            msg_data = data.get("data", {})
            msg_pid = msg_data.get("prompt_id", "")

            if msg_type == "progress" and msg_pid == prompt_id:
                v = msg_data.get("value", 0)
                m = msg_data.get("max", 0)
                if m > 0:
                    pct = v / m * 100
                    log.info(f"  Progress: {v}/{m} ({pct:.0f}%)")

            elif msg_type == "executing" and msg_pid == prompt_id:
                node = msg_data.get("node")
                if node:
                    log.debug(f"  Executing node: {node}")

            elif msg_type == "execution_success" and msg_pid == prompt_id:
                log.info("  Execution succeeded (WebSocket)")
                done.set()

            elif msg_type == "execution_error" and msg_pid == prompt_id:
                err = msg_data.get("exception_message", "Unknown error")
                log.error(f"  Execution error: {err}")
                error_holder[0] = err
                done.set()

        def on_error(ws: websocket.WebSocketApp, err: Exception) -> None:
            log.debug(f"  WebSocket error: {err}")
            done.set()

        def on_close(
            ws: websocket.WebSocketApp,
            close_status_code: int | None,
            close_msg: str | None,
        ) -> None:
            log.debug("  WebSocket closed")
            done.set()

        def on_open(ws: websocket.WebSocketApp) -> None:
            log.debug("  WebSocket connected")

        try:
            ws_app = websocket.WebSocketApp(
                ws_url,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            ws_thread = threading.Thread(target=ws_app.run_forever, daemon=True)
            ws_thread.start()

            if not done.wait(timeout=timeout_sec):
                log.warning("  WebSocket timed out")
                ws_app.close()
                return None

            ws_app.close()

            if error_holder[0]:
                # Still try to get history for partial results
                pass

            # Fetch history
            history = self.get_history(prompt_id)
            if prompt_id in history:
                result_holder[0] = history[prompt_id]

            return result_holder[0]

        except Exception as exc:
            log.debug(f"  WebSocket exception: {exc}")
            return None

    def _wait_poll(
        self, prompt_id: str, timeout_sec: float, poll_interval: float
    ) -> dict:
        """HTTP polling fallback."""
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            try:
                history = self.get_history(prompt_id)
                if prompt_id in history:
                    entry = history[prompt_id]
                    status = entry.get("status", {})
                    if status.get("status_str") in ("success", "error"):
                        return entry
            except requests.RequestException:
                pass
            elapsed = time.monotonic() - (deadline - timeout_sec)
            log.info(f"  Polling... {elapsed:.0f}s elapsed")
            time.sleep(poll_interval)
        raise TimeoutError(f"Prompt {prompt_id} did not complete within {timeout_sec}s")


# ===========================================================================
# ComfyUILifecycle — Process management
# ===========================================================================


class ComfyUILifecycle:
    """Smart start/stop for ComfyUI with port management."""

    def __init__(self, port: int = 8188) -> None:
        self.port = port
        self.base_url = f"http://127.0.0.1:{port}"
        self.client = ComfyUIClient(self.base_url)
        self._started_by_us = False
        self._pid: Optional[int] = None

    def find_pid_on_port(self) -> Optional[int]:
        """Find PID listening on our port via lsof."""
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{self.port}", "-sTCP:LISTEN"],
                capture_output=True, text=True, timeout=5,
            )
            pids = result.stdout.strip().splitlines()
            if pids:
                return int(pids[0])
        except (subprocess.TimeoutExpired, ValueError):
            pass
        return None

    def is_healthy(self) -> bool:
        return self.client.is_alive()

    def start(self, force_restart: bool = False) -> int:
        """Ensure ComfyUI is running. Returns PID."""
        if force_restart:
            self._kill_port()

        if self.is_healthy():
            pid = self.find_pid_on_port()
            log.info(f"ComfyUI already running on port {self.port} (PID {pid})")
            self._pid = pid
            return pid or 0

        # Not running — start it
        log.info(f"Starting ComfyUI on port {self.port}...")
        log_path = BENCH_RESULTS_DIR / f"comfyui_port{self.port}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_file = open(log_path, "a")
        proc = subprocess.Popen(
            ["bash", str(RUN_SH), "--port", str(self.port)],
            cwd=str(REPO_DIR),
            stdout=log_file,
            stderr=log_file,
            env={
                **os.environ,
                "PYTORCH_MPS_HIGH_WATERMARK_RATIO": "0.0",
                "PYTORCH_ENABLE_MPS_FALLBACK": "1",
            },
        )
        log.info(f"ComfyUI stdout/stderr → {log_path}")
        self._started_by_us = True
        self._pid = proc.pid

        # Wait for it to become healthy
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if self.is_healthy():
                elapsed = time.monotonic() - (deadline - 120)
                log.info(f"ComfyUI ready on port {self.port} ({elapsed:.0f}s)")
                return proc.pid
            time.sleep(2)

        raise TimeoutError(f"ComfyUI did not start within 120s on port {self.port}")

    def stop(self) -> None:
        """Stop ComfyUI if we started it."""
        if not self._started_by_us:
            log.info("ComfyUI was already running — not stopping")
            return

        pid = self.find_pid_on_port()
        if pid:
            log.info(f"Stopping ComfyUI (PID {pid})...")
            try:
                os.kill(pid, signal.SIGTERM)
                # Wait for it to die
                for _ in range(10):
                    time.sleep(1)
                    if not self.is_healthy():
                        log.info("ComfyUI stopped")
                        return
                # Force kill
                os.kill(pid, signal.SIGKILL)
                log.info("ComfyUI force-killed")
            except ProcessLookupError:
                pass

    def _kill_port(self) -> None:
        """Kill whatever is listening on our port."""
        pid = self.find_pid_on_port()
        if pid:
            log.info(f"Force-restart: killing PID {pid}")
            try:
                os.kill(pid, signal.SIGTERM)
                time.sleep(2)
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            except ProcessLookupError:
                pass


# ===========================================================================
# Workflow Converter — full workflow JSON → API format
# ===========================================================================


def _resolve_portals(
    nodes: list,
    link_map: dict[int, tuple[int, int]],
) -> dict[int, tuple[int, int]]:
    """Resolve SetNode/GetNode portal connections into direct links.

    ComfyUI's Set/Get nodes are frontend-only "portal" connectors — the browser UI
    substitutes them with direct connections before submitting to /prompt.  We replicate
    that substitution here so the API payload never references SetNode/GetNode.

    Algorithm: any link whose source is a GetNode is replaced with the link that feeds
    the matching SetNode (matched by the shared key widget value).
    """
    # key → (from_node, from_slot) of the value wired into each SetNode
    set_sources: dict[str, tuple[int, int]] = {}
    for n in nodes:
        if n.get("type") == "SetNode":
            key = n.get("widgets_values", [None])[0]
            if key is None:
                continue
            for inp in n.get("inputs", []):
                link_id = inp.get("link")
                if link_id is not None and link_id in link_map:
                    set_sources[key] = link_map[link_id]
                    break

    # node_id → key for every GetNode
    get_keys: dict[int, str] = {}
    for n in nodes:
        if n.get("type") == "GetNode":
            key = n.get("widgets_values", [None])[0]
            if key is not None:
                get_keys[n["id"]] = key

    # Rewrite any link whose origin is a GetNode to the SetNode's source
    resolved = dict(link_map)
    for link_id, (from_node, from_slot) in link_map.items():
        if from_node in get_keys:
            key = get_keys[from_node]
            if key in set_sources:
                resolved[link_id] = set_sources[key]

    return resolved


# Portal node types — excluded from API payload after portal resolution
_PORTAL_NODE_TYPES = {"SetNode", "GetNode"}


def convert_workflow_to_api(
    workflow_path: Path,
    client: Optional[ComfyUIClient] = None,
    overrides: Optional[dict[str, dict]] = None,
) -> dict:
    """Convert a stored ComfyUI workflow JSON to the API format for POST /prompt.

    Args:
        workflow_path: Path to the workflow .json file.
        client: Optional ComfyUIClient for runtime object_info lookups (unknown nodes).
        overrides: Optional dict of {node_id: {"inputs": {key: value}}} to override inputs.

    Returns:
        Dict of {node_id: {"class_type": ..., "inputs": {...}}}.
    """
    with open(workflow_path) as f:
        wf = json.load(f)

    nodes = wf.get("nodes", [])
    links_raw = wf.get("links", [])

    # Build link lookup: link_id → (from_node_id, from_output_slot)
    link_map: dict[int, tuple[int, int]] = {}
    for link in links_raw:
        link_id = link[0]
        from_node = link[1]
        from_output = link[2]
        link_map[link_id] = (from_node, from_output)

    # Resolve SetNode/GetNode portals → direct connections
    link_map = _resolve_portals(nodes, link_map)

    # Build node lookup by ID
    node_by_id: dict[int, dict] = {n["id"]: n for n in nodes}

    # Track which inputs are linked (have a link ID) per node
    linked_inputs: dict[int, set[str]] = {}
    for n in nodes:
        linked_inputs[n["id"]] = set()
        for inp in n.get("inputs", []):
            if inp.get("link") is not None:
                linked_inputs[n["id"]].add(inp["name"])

    api_format: dict[str, dict] = {}

    for node in nodes:
        nid = node["id"]
        ntype = node.get("type", "")

        # Skip UI-only nodes and resolved portal nodes
        if ntype in SKIP_NODE_TYPES or ntype in _PORTAL_NODE_TYPES:
            continue

        entry: dict[str, Any] = {
            "class_type": ntype,
            "_meta": {"title": node.get("title", ntype)},
            "inputs": {},
        }

        # 1. Resolve linked inputs
        for inp in node.get("inputs", []):
            link_id = inp.get("link")
            if link_id is not None and link_id in link_map:
                from_node, from_slot = link_map[link_id]
                entry["inputs"][inp["name"]] = [str(from_node), from_slot]

        # 2. Resolve widget values (skip inputs already resolved via links)
        widgets = node.get("widgets_values", [])
        if widgets:
            widget_names = _get_widget_names(ntype, client)
            if widget_names is not None:
                linked = linked_inputs.get(nid, set())
                for i, name in enumerate(widget_names):
                    if i < len(widgets) and name not in linked:
                        entry["inputs"][name] = widgets[i]
            else:
                # Unknown type — try object_info from API
                _map_widgets_from_api(ntype, widgets, entry, client)

        api_format[str(nid)] = entry

    # Apply overrides
    if overrides:
        for node_id_str, node_overrides in overrides.items():
            if node_id_str in api_format:
                for key, value in node_overrides.items():
                    api_format[node_id_str]["inputs"][key] = value

    return api_format


def _get_widget_names(
    class_type: str, client: Optional[ComfyUIClient]
) -> Optional[list[str]]:
    """Get the ordered widget input names for a known node type."""
    if class_type in WIDGET_ORDER:
        names = WIDGET_ORDER[class_type]
        return names if names else None  # empty list = no widgets
    return None


def _map_widgets_from_api(
    class_type: str,
    widgets: list,
    entry: dict,
    client: Optional[ComfyUIClient],
) -> None:
    """Fall back to GET /object_info to discover widget input names."""
    if client is None:
        log.warning(f"Unknown node type {class_type} and no client for lookup — skipping widgets")
        return

    try:
        info = client.get_object_info(class_type)
        input_order = info.get("input_order", {})
        all_inputs = input_order.get("required", []) + input_order.get("optional", [])
        for i, name in enumerate(all_inputs):
            if i < len(widgets):
                entry["inputs"][name] = widgets[i]
    except Exception as exc:
        log.warning(f"Could not fetch object_info for {class_type}: {exc}")


# ===========================================================================
# MetricsCollector — Resource monitoring during execution
# ===========================================================================


@dataclasses.dataclass
class RunMetrics:
    prompt_id: str = ""
    variant: str = ""
    tag: str = ""
    wall_time_sec: float = 0.0
    peak_rss_mb: float = 0.0
    disk_output_bytes: int = 0
    disk_output_files: int = 0
    system_stats_before: dict = dataclasses.field(default_factory=dict)
    system_stats_after: dict = dataclasses.field(default_factory=dict)
    timestamp: str = ""
    status: str = ""
    error_message: Optional[str] = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


class MetricsCollector:
    """Background thread that monitors ComfyUI process RSS."""

    def __init__(self) -> None:
        self._peak_rss: float = 0.0
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._pid: Optional[int] = None

    def start(self, pid: int, interval: float = 2.0) -> None:
        self._pid = pid
        self._stop_event.clear()
        self._peak_rss = 0.0
        self._thread = threading.Thread(target=self._monitor, args=(pid, interval), daemon=True)
        self._thread.start()

    def stop(self) -> float:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        return self._peak_rss

    def _monitor(self, pid: int, interval: float) -> None:
        while not self._stop_event.is_set():
            try:
                proc = psutil.Process(pid)
                # Walk the process tree (ComfyUI spawns children)
                total_rss = proc.memory_info().rss
                for child in proc.children(recursive=True):
                    try:
                        total_rss += child.memory_info().rss
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                rss_mb = total_rss / (1024 * 1024)
                if rss_mb > self._peak_rss:
                    self._peak_rss = rss_mb
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            self._stop_event.wait(interval)


def measure_output_dir() -> tuple[int, int]:
    """Measure total size and file count in the ComfyUI output directory."""
    total_size = 0
    file_count = 0
    if OUTPUT_DIR.exists():
        for f in OUTPUT_DIR.rglob("*"):
            if f.is_file():
                total_size += f.stat().st_size
                file_count += 1
    return total_size, file_count


# ===========================================================================
# CLI Subcommands
# ===========================================================================


def cmd_start(args: argparse.Namespace) -> None:
    lc = ComfyUILifecycle(port=args.port)
    pid = lc.start(force_restart=args.force_restart)
    print(f"ComfyUI running on port {args.port}, PID={pid}")


def cmd_stop(args: argparse.Namespace) -> None:
    lc = ComfyUILifecycle(port=args.port)
    lc.stop()


def cmd_status(args: argparse.Namespace) -> None:
    client = ComfyUIClient(f"http://127.0.0.1:{args.port}")
    if client.is_alive():
        stats = client.get_system_stats()
        queue = client.get_queue()
        ram = stats.get("system", {})
        print(f"ComfyUI running on port {args.port}")
        ram_free = ram.get("ram_free", 0)
        ram_total = ram.get("ram_total", 0)
        if ram_total:
            print(f"  RAM: {ram_free / 1e9:.1f}/{ram_total / 1e9:.1f} GB free")
        for dev in stats.get("devices", []):
            name = dev.get("name", "unknown")
            vfree = dev.get("vram_free", 0)
            vtotal = dev.get("vram_total", 0)
            if vtotal:
                print(f"  VRAM ({name}): {vfree / 1e9:.1f}/{vtotal / 1e9:.1f} GB free")
        running = queue.get("queue_running", [])
        pending = queue.get("queue_pending", [])
        print(f"  Queue: {len(running)} running, {len(pending)} pending")
    else:
        print(f"ComfyUI NOT running on port {args.port}")


def cmd_convert(args: argparse.Namespace) -> None:
    wf_path, _variant = _resolve_workflow(args)
    api = convert_workflow_to_api(wf_path)
    print(json.dumps(api, indent=2, ensure_ascii=False))


def _parse_param_overrides(args: argparse.Namespace) -> dict[str, dict]:
    """Build overrides dict from --set-param, --param, and --randomize-seeds flags."""
    overrides: dict[str, dict] = {}

    # --set-param NODE_ID.INPUT=VALUE (raw, repeatable)
    for spec in getattr(args, "set_param", None) or []:
        parts = spec.split("=", 1)
        if len(parts) != 2:
            print(f"Invalid --set-param format: {spec} (expected NODE_ID.INPUT=VALUE)")
            sys.exit(1)
        node_key, value_str = parts
        dot = node_key.split(".", 1)
        if len(dot) != 2:
            print(f"Invalid --set-param node key: {node_key} (expected NODE_ID.INPUT)")
            sys.exit(1)
        node_id, input_name = dot
        # Auto-detect type: int → float → string
        try:
            value: Any = int(value_str)
        except ValueError:
            try:
                value = float(value_str)
            except ValueError:
                value = value_str
        overrides.setdefault(node_id, {})[input_name] = value
        log.info(f"  Override: node {node_id}.{input_name} = {value!r}")

    # --param ALIAS=VALUE (aliased, repeatable)
    for spec in getattr(args, "param", None) or []:
        parts = spec.split("=", 1)
        if len(parts) != 2:
            print(f"Invalid --param format: {spec} (expected ALIAS=VALUE)")
            sys.exit(1)
        alias, value_str = parts
        if alias not in PARAM_ALIASES:
            print(f"Unknown param alias: {alias}. Available: {', '.join(sorted(PARAM_ALIASES))}")
            sys.exit(1)
        node_id, input_name = PARAM_ALIASES[alias]
        try:
            value = int(value_str)
        except ValueError:
            try:
                value = float(value_str)
            except ValueError:
                value = value_str
        overrides.setdefault(node_id, {})[input_name] = value
        log.info(f"  Override (alias {alias}): node {node_id}.{input_name} = {value!r}")

    # --randomize-seeds
    if getattr(args, "randomize_seeds", False):
        base_seed = random.randint(0, 2**53)
        for alias in ("seed_front", "seed_back", "seed_side"):
            node_id, input_name = PARAM_ALIASES[alias]
            seed_val = base_seed + {"seed_front": 0, "seed_back": 1, "seed_side": 2}[alias]
            overrides.setdefault(node_id, {})[input_name] = seed_val
            log.info(f"  Random seed ({alias}): {seed_val}")

    return overrides


def _emit_bench_output(
    variant: str,
    tag: str,
    metrics: "RunMetrics",
    image_paths: list[str],
    metrics_path: Path,
    mode: str = "api",
    use_json: bool = False,
) -> None:
    """Print the structured bench run summary (text and optional JSON block)."""
    result = {
        "variant": variant,
        "tag": tag,
        "prompt_id": metrics.prompt_id,
        "wall_time": metrics.wall_time_sec,
        "peak_rss": metrics.peak_rss_mb,
        "disk_output": f"{metrics.disk_output_bytes} bytes ({metrics.disk_output_files} files)",
        "status": metrics.status,
        "error": metrics.error_message or None,
        "metrics_json": str(metrics_path),
        "images": image_paths,
    }

    # Always print human-readable text
    print()
    print("=== BENCH RUN COMPLETE ===")
    if mode == "playwright":
        print(f"mode: playwright")
    print(f"variant: {variant}")
    print(f"tag: {tag}")
    print(f"prompt_id: {metrics.prompt_id}")
    print(f"wall_time: {metrics.wall_time_sec}s")
    print(f"peak_rss: {metrics.peak_rss_mb} MB")
    print(f"disk_output: {metrics.disk_output_bytes} bytes ({metrics.disk_output_files} files)")
    print(f"status: {metrics.status}")
    if metrics.error_message:
        print(f"error: {metrics.error_message}")
    print("images:")
    for p in image_paths:
        print(f"  - {p}")
    print(f"metrics_json: {metrics_path}")
    print("=== END BENCH RUN ===")

    # Optional: structured JSON block for machine parsing
    if use_json:
        print()
        print("=== JSON START ===")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        print("=== JSON END ===")


def cmd_run(args: argparse.Namespace) -> None:
    wf_path, variant = _resolve_workflow(args)
    tag = args.tag or "default"

    if not wf_path.exists():
        print(f"Workflow file not found: {wf_path}")
        sys.exit(1)

    # -- Phase 0: Ensure ComfyUI is running --
    log.info("=== Phase 0: ComfyUI Lifecycle ===")
    lc = ComfyUILifecycle(port=args.port)
    pid = lc.start(force_restart=getattr(args, "force_restart", False))

    client = lc.client
    client_id = str(uuid.uuid4())

    # -- Phase 1: Convert workflow to API format --
    log.info("=== Phase 1: Converting workflow to API format ===")

    # Resolve save-image labels: --label overrides, else WORKFLOW_MAP defaults
    save_labels: dict[int, str] = {}
    if getattr(args, "label", None):
        for spec in args.label:
            parts = spec.split("=", 1)
            if len(parts) != 2:
                print(f"Invalid --label format: {spec} (expected NODE_ID=NAME)")
                sys.exit(1)
            save_labels[int(parts[0])] = parts[1]
    else:
        # Use per-workflow save_labels if defined, else fall back to global SAVE_IMAGE_LABELS
        wf_key = getattr(args, "workflow", None)
        if wf_key and wf_key in WORKFLOW_MAP:
            wf_entry_labels = WORKFLOW_MAP[wf_key].get("save_labels")
            save_labels = wf_entry_labels.copy() if wf_entry_labels else SAVE_IMAGE_LABELS.copy()

    overrides: dict[str, dict] = {}
    if args.input_image:
        input_dir = DATA_DIR / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        src = Path(args.input_image)
        dest = input_dir / src.name
        if src != dest:
            shutil.copy2(src, dest)
        input_node = getattr(args, "input_node", "34") or "34"
        overrides[input_node] = {"image": dest.name}
        log.info(f"Using input image: {dest.name} (node {input_node})")

    # Merge parameter overrides from --set-param, --param, --randomize-seeds
    param_overrides = _parse_param_overrides(args)
    for node_id, node_ov in param_overrides.items():
        overrides.setdefault(node_id, {}).update(node_ov)

    api_workflow = convert_workflow_to_api(wf_path, client=client, overrides=overrides)
    log.info(f"Converted {len(api_workflow)} nodes")

    # -- Phase 2: Submit & collect metrics --
    log.info("=== Phase 2: Submitting workflow ===")
    metrics = RunMetrics(
        variant=variant,
        tag=tag,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

    try:
        metrics.system_stats_before = client.get_system_stats()
    except Exception:
        metrics.system_stats_before = {}

    disk_before, _ = measure_output_dir()
    mem_collector = MetricsCollector()
    mem_collector.start(pid)

    t0 = time.monotonic()

    try:
        result = client.submit_prompt(api_workflow, client_id)
        prompt_id = result["prompt_id"]
        metrics.prompt_id = prompt_id
        log.info(f"Submitted prompt: {prompt_id}")

        history_entry = client.wait_for_completion(prompt_id, client_id)

        status_info = history_entry.get("status", {})
        status_str = status_info.get("status_str", "unknown")
        metrics.status = status_str

        if status_str == "error":
            messages = status_info.get("messages", [])
            err_msg = str(messages) if messages else "Unknown execution error"
            metrics.error_message = err_msg
            log.error(f"Execution failed: {err_msg}")
        else:
            log.info("Execution completed successfully")

    except Exception as exc:
        metrics.status = "error"
        metrics.error_message = str(exc)
        log.error(f"Submission/execution error: {exc}")
        history_entry = {}
        prompt_id = metrics.prompt_id or "unknown"

    t1 = time.monotonic()
    metrics.wall_time_sec = round(t1 - t0, 2)
    peak_rss = mem_collector.stop()
    metrics.peak_rss_mb = round(peak_rss, 1)

    try:
        metrics.system_stats_after = client.get_system_stats()
    except Exception:
        metrics.system_stats_after = {}

    disk_after, files_after = measure_output_dir()
    metrics.disk_output_bytes = disk_after - disk_before
    metrics.disk_output_files = files_after

    # -- Phase 3: Collect outputs --
    log.info("=== Phase 3: Collecting outputs ===")
    result_dir = BENCH_RESULTS_DIR / tag / variant
    result_dir.mkdir(parents=True, exist_ok=True)

    image_paths: list[str] = []

    outputs = history_entry.get("outputs", {})
    for node_id_str, node_output in outputs.items():
        images = node_output.get("images", [])
        node_id = int(node_id_str)

        for img_info in images:
            filename = img_info["filename"]
            subfolder = img_info.get("subfolder", "")
            img_type = img_info.get("type", "output")

            # Determine output filename
            if node_id in save_labels:
                ext = Path(filename).suffix or ".png"
                out_name = f"{save_labels[node_id]}{ext}"
            else:
                out_name = filename

            dest = result_dir / out_name
            try:
                client.download_image(filename, subfolder, img_type, dest)
                image_paths.append(str(dest))
                log.info(f"  Downloaded: {dest.name}")
            except Exception as exc:
                log.warning(f"  Failed to download {filename}: {exc}")

    # Save metrics
    metrics_path = result_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics.to_dict(), indent=2, ensure_ascii=False))
    log.info(f"Metrics saved: {metrics_path}")

    # -- Structured summary --
    _emit_bench_output(
        variant=variant,
        tag=tag,
        metrics=metrics,
        image_paths=image_paths,
        metrics_path=metrics_path,
        mode="api",
        use_json=getattr(args, "json", False),
    )


# ===========================================================================
# Playwright UI-driven execution — runs workflow through the real web UI
# ===========================================================================


def _read_workflow_uuid(workflow_path: Path) -> str:
    """Read the workflow UUID from the stored JSON file."""
    with open(workflow_path) as f:
        wf = json.load(f)
    return wf.get("id", "")


def _run_ui_playwright(
    base_url: str,
    workflow_uuid: str,
    client: ComfyUIClient,
    timeout_sec: float = 1200.0,
    screenshots_dir: Optional[Path] = None,
) -> dict:
    """Drive ComfyUI via Playwright: load workflow by UUID hash, click Queue.

    Returns the history entry for the executed prompt.
    """
    from playwright.sync_api import sync_playwright

    history_entry: dict = {}
    prompt_id_holder: list[str] = [""]
    client_id = str(uuid.uuid4())

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            # Accept locale for Chinese prompts
            locale="en-US",
        )
        page = context.new_page()

        # Capture console messages for debugging
        console_logs: list[str] = []
        page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))

        log.info("  Loading ComfyUI web UI...")

        # Navigate to the workflow via its UUID hash
        url = f"{base_url}/#{workflow_uuid}"
        page.goto(url, wait_until="networkidle", timeout=60_000)
        log.info("  Page loaded")

        # Wait for the canvas/graph to render (nodes appear)
        # The app object becomes available after the page initializes
        page.wait_for_function(
            "() => window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app",
            timeout=30_000,
        )
        log.info("  ComfyUI app initialized")

        # Wait a moment for the workflow graph to fully render
        page.wait_for_timeout(2000)

        # Take a screenshot of the loaded workflow
        if screenshots_dir:
            screenshots_dir.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshots_dir / "workflow_loaded.png"))
            log.info("  Screenshot: workflow_loaded.png")

        # Inject a WebSocket listener to capture the prompt_id from the queue response
        # The app's API client sends prompts and gets back a prompt_id
        page.evaluate(f"""
            () => {{
                // Override the api.dispatch to capture prompt_id
                const origFetch = window.comfyAPI.api.api.fetchApi;
                window.__bench_prompt_ids = [];
                window.comfyAPI.api.api.fetchApi = function(...args) {{
                    const result = origFetch.apply(this, args);
                    // Check if this is a /prompt POST
                    if (args[0] === '/prompt' && args[1] && args[1].method === 'POST') {{
                        result.then(async (r) => {{
                            try {{
                                const data = await r.clone().json();
                                if (data.prompt_id) {{
                                    window.__bench_prompt_ids.push(data.prompt_id);
                                }}
                            }} catch(e) {{}}
                        }});
                    }}
                    return result;
                }};
            }}
        """)

        # Now trigger Queue Prompt via the app API
        log.info("  Queueing prompt via web UI...")
        page.evaluate("""
            () => {
                const app = window.comfyAPI.app.app;
                return app.queuePrompt(0);  // 0 = queue at end
            }
        """)

        # Wait for the prompt_id to appear
        prompt_id = ""
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ids = page.evaluate("() => window.__bench_prompt_ids || []")
            if ids:
                prompt_id = ids[0]
                break
            time.sleep(0.5)

        if not prompt_id:
            # Fallback: get the most recent prompt from history
            log.warning("  Could not capture prompt_id from UI, checking history...")
            history = client.get_history(max_items=1)
            if history:
                prompt_id = list(history.keys())[-1]

        prompt_id_holder[0] = prompt_id
        log.info(f"  Prompt ID: {prompt_id}")

        if not prompt_id:
            log.error("  No prompt_id captured — execution may not have started")
            if screenshots_dir:
                page.screenshot(path=str(screenshots_dir / "error_no_prompt.png"))
            browser.close()
            return {"status": {"status_str": "error"}, "outputs": {}}

        # Wait for execution to complete via the API (polling)
        log.info("  Waiting for execution to complete...")
        poll_start = time.monotonic()
        last_progress = ""

        while time.monotonic() - poll_start < timeout_sec:
            try:
                history = client.get_history(prompt_id)
                if prompt_id in history:
                    entry = history[prompt_id]
                    status = entry.get("status", {})
                    status_str = status.get("status_str", "")
                    if status_str in ("success", "error"):
                        history_entry = entry
                        # Take screenshot of completion state
                        if screenshots_dir:
                            page.screenshot(path=str(screenshots_dir / "workflow_complete.png"))
                        break
            except requests.RequestException:
                pass

            elapsed = time.monotonic() - poll_start
            # Log progress every 30s
            if f"{elapsed:.0f}" != last_progress and int(elapsed) % 30 == 0:
                last_progress = f"{elapsed:.0f}"
                log.info(f"  ... {elapsed:.0f}s elapsed")

            time.sleep(2)

        browser.close()

    return history_entry


def cmd_run_ui(args: argparse.Namespace) -> None:
    """Run workflow through the ComfyUI web UI via Playwright."""
    wf_path, variant = _resolve_workflow(args)
    tag = args.tag or "default"

    if not wf_path.exists():
        print(f"Workflow file not found: {wf_path}")
        sys.exit(1)

    # Read the workflow UUID (for the URL hash)
    workflow_uuid = _read_workflow_uuid(wf_path)
    if not workflow_uuid:
        print(f"Workflow file has no UUID: {wf_path}")
        sys.exit(1)
    log.info(f"Workflow UUID: {workflow_uuid}")

    # -- Phase 0: Ensure ComfyUI is running --
    log.info("=== Phase 0: ComfyUI Lifecycle ===")
    lc = ComfyUILifecycle(port=args.port)
    pid = lc.start(force_restart=getattr(args, "force_restart", False))
    client = lc.client
    base_url = f"http://127.0.0.1:{args.port}"

    # -- Phase 1: Execute via Playwright --
    log.info("=== Phase 1: Executing via Playwright (web UI) ===")

    result_dir = BENCH_RESULTS_DIR / tag / variant
    screenshots_dir = result_dir / "screenshots"

    metrics = RunMetrics(
        variant=variant,
        tag=tag,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

    try:
        metrics.system_stats_before = client.get_system_stats()
    except Exception:
        metrics.system_stats_before = {}

    disk_before, _ = measure_output_dir()
    mem_collector = MetricsCollector()
    mem_collector.start(pid)

    t0 = time.monotonic()

    try:
        history_entry = _run_ui_playwright(
            base_url=base_url,
            workflow_uuid=workflow_uuid,
            client=client,
            timeout_sec=1200.0,
            screenshots_dir=screenshots_dir,
        )

        status_info = history_entry.get("status", {})
        status_str = status_info.get("status_str", "unknown")
        metrics.status = status_str

        # Extract prompt_id from history
        # The history key is the prompt_id
        # We need to get it from the polling inside _run_ui_playwright
        # Look in history outputs
        outputs = history_entry.get("outputs", {})

        # Try to find prompt_id from the client history
        try:
            full_history = client.get_history(max_items=1)
            if full_history:
                metrics.prompt_id = list(full_history.keys())[0]
        except Exception:
            pass

        if status_str == "error":
            messages = status_info.get("messages", [])
            err_msg = str(messages) if messages else "Unknown execution error"
            metrics.error_message = err_msg
            log.error(f"Execution failed: {err_msg}")
        else:
            log.info("Execution completed successfully")

    except Exception as exc:
        metrics.status = "error"
        metrics.error_message = str(exc)
        log.error(f"Playwright execution error: {exc}")
        history_entry = {}

    t1 = time.monotonic()
    metrics.wall_time_sec = round(t1 - t0, 2)
    peak_rss = mem_collector.stop()
    metrics.peak_rss_mb = round(peak_rss, 1)

    try:
        metrics.system_stats_after = client.get_system_stats()
    except Exception:
        metrics.system_stats_after = {}

    disk_after, files_after = measure_output_dir()
    metrics.disk_output_bytes = disk_after - disk_before
    metrics.disk_output_files = files_after

    # -- Phase 2: Collect outputs --
    log.info("=== Phase 2: Collecting outputs ===")
    result_dir.mkdir(parents=True, exist_ok=True)

    image_paths: list[str] = []
    outputs = history_entry.get("outputs", {})
    for node_id_str, node_output in outputs.items():
        images = node_output.get("images", [])
        node_id = int(node_id_str)

        for img_info in images:
            filename = img_info["filename"]
            subfolder = img_info.get("subfolder", "")
            img_type = img_info.get("type", "output")

            if node_id in SAVE_IMAGE_LABELS:
                ext = Path(filename).suffix or ".png"
                out_name = f"{SAVE_IMAGE_LABELS[node_id]}{ext}"
            else:
                out_name = filename

            dest = result_dir / out_name
            try:
                client.download_image(filename, subfolder, img_type, dest)
                image_paths.append(str(dest))
                log.info(f"  Downloaded: {dest.name}")
            except Exception as exc:
                log.warning(f"  Failed to download {filename}: {exc}")

    # Include screenshots in output
    if screenshots_dir.exists():
        for ss in screenshots_dir.glob("*.png"):
            image_paths.append(str(ss))

    # Save metrics
    metrics_path = result_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics.to_dict(), indent=2, ensure_ascii=False))
    log.info(f"Metrics saved: {metrics_path}")

    # -- Structured summary --
    _emit_bench_output(
        variant=variant,
        tag=tag,
        metrics=metrics,
        image_paths=image_paths,
        metrics_path=metrics_path,
        mode="playwright",
        use_json=getattr(args, "json", False),
    )


# ===========================================================================
# Argument Parser
# ===========================================================================


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="ComfyUI Workflow Runner & Benchmark Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Debug logging")
    parser.add_argument(
        "--port", type=int, default=8188, help="ComfyUI port (default: 8188)"
    )

    subs = parser.add_subparsers(dest="command", required=True)

    # start
    p_start = subs.add_parser("start", help="Start ComfyUI (or reuse existing)")
    p_start.add_argument("--force-restart", action="store_true", help="Kill existing and restart")

    # stop
    subs.add_parser("stop", help="Stop ComfyUI if started by us")

    # status
    subs.add_parser("status", help="Check ComfyUI status")

    # convert
    p_convert = subs.add_parser("convert", help="Convert workflow to API format (debug)")
    p_convert.add_argument(
        "--workflow", default=None, choices=list(WORKFLOW_MAP.keys()),
        help="Workflow alias to convert",
    )
    p_convert.add_argument(
        "--workflow-file", default=None,
        help="Direct path to a workflow JSON file",
    )
    p_convert.add_argument(
        "--variant", default=None,
        help="Variant label (required with --workflow-file)",
    )

    def _add_universal_run_flags(p: argparse.ArgumentParser) -> None:
        """Add workflow selection + override flags shared by run and run-ui."""
        # Workflow selection: alias OR direct file (exactly one required)
        wf_excl = p.add_mutually_exclusive_group(required=True)
        wf_excl.add_argument(
            "--workflow", default=None, choices=list(WORKFLOW_MAP.keys()),
            help="Workflow alias (e.g. fp16, fp8)",
        )
        wf_excl.add_argument(
            "--workflow-file", default=None,
            help="Direct path to any workflow JSON file",
        )
        p.add_argument(
            "--variant", default=None,
            help="Variant label (required with --workflow-file)",
        )
        p.add_argument("--tag", default="", help="Tag for this run (e.g., baseline, comparison)")

        # Input image
        p.add_argument("--input-image", default=None, help="Override input image path")
        p.add_argument(
            "--input-node", default="34",
            help="LoadImage node ID for --input-image (default: 34)",
        )

        # Output labels
        p.add_argument(
            "--label", action="append", default=[],
            metavar="NODE_ID=NAME",
            help="Rename SaveImage output, e.g. --label 140=front (repeatable)",
        )

        # Lifecycle
        p.add_argument("--force-restart", action="store_true", help="Restart ComfyUI before run")

        # Parameter overrides
        p.add_argument(
            "--set-param", action="append", default=[],
            metavar="NODE_ID.INPUT=VALUE",
            help="Override a node input, e.g. --set-param 138.value=8",
        )
        p.add_argument(
            "--param", action="append", default=[],
            metavar="ALIAS=VALUE",
            help="Override using named alias, e.g. --param steps=12 --param seed_back=999",
        )
        p.add_argument(
            "--randomize-seeds", action="store_true",
            help="Override all 3 noise seeds with random unique values",
        )
        p.add_argument(
            "--json", action="store_true",
            help="Emit structured JSON output after text summary",
        )

    # run (API mode)
    p_run = subs.add_parser("run", help="Run a workflow (API mode)")
    _add_universal_run_flags(p_run)

    # run-ui (Playwright mode)
    p_rui = subs.add_parser("run-ui", help="Run a workflow via Playwright (web UI)")
    _add_universal_run_flags(p_rui)

    # baseline (save / load / compare)
    p_bl = subs.add_parser("baseline", help="Manage benchmark baseline")
    p_bl.add_argument(
        "action", choices=["save", "load", "compare"],
        help="save: save a run as baseline | load: print baseline info | compare: compare run vs baseline",
    )
    p_bl.add_argument("--run-dir", default=None, help="Run directory to save or compare")

    return parser


# ===========================================================================
# Main
# ===========================================================================


def _extract_workflow_params(wf_path: Path) -> dict[str, Any]:
    """Extract key parameters from a workflow JSON for baseline storage."""
    with open(wf_path) as f:
        wf = json.load(f)
    nodes = {n["id"]: n for n in wf.get("nodes", [])}
    params: dict[str, Any] = {}

    def _widget(nodes_dict, nid, idx):
        n = nodes_dict.get(nid)
        if n and "widgets_values" in n:
            vals = n["widgets_values"]
            if idx < len(vals):
                return vals[idx]
        return None

    params["steps"] = _widget(nodes, 138, 0)
    params["seed_front"] = _widget(nodes, 2, 0)
    params["seed_back"] = _widget(nodes, 120, 0)
    params["seed_side"] = _widget(nodes, 130, 0)
    params["cfg_front"] = _widget(nodes, 4, 0)
    params["cfg_back"] = _widget(nodes, 116, 0)
    params["cfg_side"] = _widget(nodes, 126, 0)
    params["desc"] = _widget(nodes, 137, 0)
    # Resolution from ResolutionMaster node 104
    w = _widget(nodes, 104, 2)  # width index
    h = _widget(nodes, 104, 3)  # height index
    if w and h:
        params["resolution"] = [w, h]

    return params


def cmd_baseline(args: argparse.Namespace) -> None:
    """Manage benchmark baseline (save / load / compare)."""
    action = args.action

    if action == "save":
        if not args.run_dir:
            print("--run-dir is required for 'save'")
            sys.exit(1)
        run_dir = Path(args.run_dir)
        if not run_dir.is_absolute():
            run_dir = REPO_DIR / run_dir
        metrics_path = run_dir / "metrics.json"
        if not metrics_path.exists():
            print(f"No metrics.json found in {run_dir}")
            sys.exit(1)

        metrics = json.loads(metrics_path.read_text())

        # Determine which workflow was used from the variant
        variant = metrics.get("variant", "bf16")
        wf_key = "fp16" if variant in ("bf16", "fp16") else "fp8"
        wf_path = WORKFLOW_MAP[wf_key]["file"]
        params = _extract_workflow_params(wf_path)

        # Collect image paths
        images: dict[str, str] = {}
        for label in ("front", "back", "side", "stitched"):
            img = run_dir / f"{label}.png"
            if img.exists():
                images[label] = str(img)

        baseline_data = {
            "version": 1,
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "source_run_dir": str(run_dir.relative_to(REPO_DIR)),
            "metrics": metrics,
            "parameters": params,
            "images": images,
        }

        BASELINE_DIR.mkdir(parents=True, exist_ok=True)
        baseline_path = BASELINE_DIR / "baseline.json"
        baseline_path.write_text(json.dumps(baseline_data, indent=2, ensure_ascii=False))

        # Symlink images into baseline dir for easy reference
        bl_img_dir = BASELINE_DIR / variant
        bl_img_dir.mkdir(parents=True, exist_ok=True)
        for label, src_str in images.items():
            src = Path(src_str)
            link = bl_img_dir / f"{label}.png"
            if link.exists() or link.is_symlink():
                link.unlink()
            link.symlink_to(src)

        print(f"Baseline saved to {baseline_path}")
        print(f"  Source: {run_dir}")
        print(f"  Variant: {variant}")
        print(f"  Parameters: steps={params.get('steps')}, seeds={params.get('seed_front')}/{params.get('seed_back')}/{params.get('seed_side')}")
        print(f"  Images symlinked to {bl_img_dir}")

    elif action == "load":
        baseline_path = BASELINE_DIR / "baseline.json"
        if not baseline_path.exists():
            print("No baseline found. Run 'baseline save --run-dir ...' first.")
            sys.exit(1)
        baseline_data = json.loads(baseline_path.read_text())
        print(json.dumps(baseline_data, indent=2, ensure_ascii=False))

    elif action == "compare":
        if not args.run_dir:
            print("--run-dir is required for 'compare'")
            sys.exit(1)
        baseline_path = BASELINE_DIR / "baseline.json"
        if not baseline_path.exists():
            print("No baseline found. Run 'baseline save --run-dir ...' first.")
            sys.exit(1)
        run_dir = Path(args.run_dir)
        if not run_dir.is_absolute():
            run_dir = REPO_DIR / run_dir
        metrics_path = run_dir / "metrics.json"
        if not metrics_path.exists():
            print(f"No metrics.json found in {run_dir}")
            sys.exit(1)

        baseline = json.loads(baseline_path.read_text())
        new_metrics = json.loads(metrics_path.read_text())

        bm = baseline["metrics"]
        delta_wall = new_metrics.get("wall_time_sec", 0) - bm.get("wall_time_sec", 0)
        delta_rss = new_metrics.get("peak_rss_mb", 0) - bm.get("peak_rss_mb", 0)

        # Load reviews if available
        reviews_path = run_dir / "reviews.json"
        bl_reviews_path = Path(baseline["images"].get("front", "")).parent / "reviews.json" if baseline.get("images") else None
        new_reviews = None
        bl_reviews = None

        if reviews_path.exists():
            new_reviews = json.loads(reviews_path.read_text())
        if bl_reviews_path and bl_reviews_path.exists():
            bl_reviews = json.loads(bl_reviews_path.read_text())

        comparison = {
            "baseline_source": baseline["source_run_dir"],
            "new_run_dir": str(run_dir.relative_to(REPO_DIR)),
            "performance": {
                "wall_time_delta_sec": round(delta_wall, 2),
                "rss_delta_mb": round(delta_rss, 1),
                "baseline_wall_time": bm.get("wall_time_sec"),
                "new_wall_time": new_metrics.get("wall_time_sec"),
            },
            "status": {
                "baseline": bm.get("status"),
                "new": new_metrics.get("status"),
            },
        }

        # Compute VLM score deltas if reviews exist
        if new_reviews and bl_reviews:
            def _avg_scores(reviews_list):
                if not reviews_list:
                    return None
                dims = ["anatomy", "consistency", "quality", "background", "clothing", "overall"]
                sums = {d: 0.0 for d in dims}
                count = 0
                for r in reviews_list:
                    if isinstance(r, dict):
                        count += 1
                        for d in dims:
                            sums[d] += r.get(d, 0)
                if count == 0:
                    return None
                return {d: round(s / count, 1) for d, s in sums.items()}

            bl_scores = _avg_scores(bl_reviews)
            new_scores = _avg_scores(new_reviews)
            if bl_scores and new_scores:
                deltas = {d: round(new_scores[d] - bl_scores[d], 1) for d in bl_scores}
                comparison["quality_deltas"] = deltas
                comparison["baseline_scores"] = bl_scores
                comparison["new_scores"] = new_scores
                overall_delta = deltas.get("overall", 0)
                if overall_delta >= 0.3:
                    comparison["verdict"] = "improved"
                elif overall_delta <= -0.3:
                    comparison["verdict"] = "regressed"
                else:
                    comparison["verdict"] = "neutral"
            else:
                comparison["verdict"] = "no_baseline_reviews"
        else:
            comparison["verdict"] = "no_reviews"

        print(json.dumps(comparison, indent=2, ensure_ascii=False))


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    setup_logging(args.verbose)

    cmd_map = {
        "start": cmd_start,
        "stop": cmd_stop,
        "status": cmd_status,
        "convert": cmd_convert,
        "run": cmd_run,
        "run-ui": cmd_run_ui,
        "baseline": cmd_baseline,
    }
    cmd_map[args.command](args)


if __name__ == "__main__":
    main()
