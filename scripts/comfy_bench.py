#!/usr/bin/env python3
"""ComfyUI Benchmark & Workflow Automation.

CLI tool to manage ComfyUI lifecycle, run workflows (fp16/fp8),
collect metrics, and download outputs for VLM review.

Usage:
    ComfyUI/.venv/bin/python scripts/comfy_bench.py start [--port 8188] [--force-restart]
    ComfyUI/.venv/bin/python scripts/comfy_bench.py stop  [--port 8188]
    ComfyUI/.venv/bin/python scripts/comfy_bench.py status [--port 8188]
    ComfyUI/.venv/bin/python scripts/comfy_bench.py run --workflow fp16 [--tag baseline] [--port 8188]
    ComfyUI/.venv/bin/python scripts/comfy_bench.py run-ui --workflow fp16 [--tag baseline] [--port 8188]
    ComfyUI/.venv/bin/python scripts/comfy_bench.py convert --workflow fp16
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
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
        "file": DATA_DIR / "user" / "default" / "workflows" / "flux2-klein9b-character-profile.json",
        "variant": "bf16",
        "save_prefix": "ComfyUI",
    },
    "fp8": {
        "file": DATA_DIR / "user" / "default" / "workflows" / "flux2-klein9b-character-profile-fp8.json",
        "variant": "fp8",
        "save_prefix": "Klein9B-fp8",
    },
}

# SaveImage node ID → view label
SAVE_IMAGE_LABELS: dict[int, str] = {
    140: "front",
    141: "back",
    142: "side",
    132: "stitched",
}

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
}

# Node types that are UI-only and should be excluded from API payload
SKIP_NODE_TYPES = {"MarkdownNote"}

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
        proc = subprocess.Popen(
            ["bash", str(RUN_SH), "--port", str(self.port)],
            cwd=str(REPO_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                **os.environ,
                "PYTORCH_MPS_HIGH_WATERMARK_RATIO": "0.0",
                "PYTORCH_ENABLE_MPS_FALLBACK": "1",
            },
        )
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

        # Skip UI-only nodes
        if ntype in SKIP_NODE_TYPES:
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

        # 2. Resolve widget values
        widgets = node.get("widgets_values", [])
        if widgets:
            widget_names = _get_widget_names(ntype, client)
            if widget_names is not None:
                for i, name in enumerate(widget_names):
                    if i < len(widgets):
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
    wf_key = args.workflow
    if wf_key not in WORKFLOW_MAP:
        print(f"Unknown workflow: {wf_key}. Available: {', '.join(WORKFLOW_MAP)}")
        sys.exit(1)
    wf_path = WORKFLOW_MAP[wf_key]["file"]
    api = convert_workflow_to_api(wf_path)
    print(json.dumps(api, indent=2, ensure_ascii=False))


def cmd_run(args: argparse.Namespace) -> None:
    wf_key = args.workflow
    if wf_key not in WORKFLOW_MAP:
        print(f"Unknown workflow: {wf_key}. Available: {', '.join(WORKFLOW_MAP)}")
        sys.exit(1)

    wf_info = WORKFLOW_MAP[wf_key]
    wf_path = wf_info["file"]
    variant = wf_info["variant"]
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

    overrides: dict[str, dict] = {}
    if args.input_image:
        input_dir = DATA_DIR / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        src = Path(args.input_image)
        dest = input_dir / src.name
        if src != dest:
            shutil.copy2(src, dest)
        # Node 34 is LoadImage in this workflow
        overrides["34"] = {"image": dest.name}
        log.info(f"Using input image: {dest.name}")

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
        label = SAVE_IMAGE_LABELS.get(node_id)

        for img_info in images:
            filename = img_info["filename"]
            subfolder = img_info.get("subfolder", "")
            img_type = img_info.get("type", "output")

            # Determine output filename
            if label:
                ext = Path(filename).suffix or ".png"
                out_name = f"{label}{ext}"
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
    print()
    print("=== BENCH RUN COMPLETE ===")
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
    wf_key = args.workflow
    if wf_key not in WORKFLOW_MAP:
        print(f"Unknown workflow: {wf_key}. Available: {', '.join(WORKFLOW_MAP)}")
        sys.exit(1)

    wf_info = WORKFLOW_MAP[wf_key]
    wf_path = wf_info["file"]
    variant = wf_info["variant"]
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
        label = SAVE_IMAGE_LABELS.get(node_id)

        for img_info in images:
            filename = img_info["filename"]
            subfolder = img_info.get("subfolder", "")
            img_type = img_info.get("type", "output")

            if label:
                ext = Path(filename).suffix or ".png"
                out_name = f"{label}{ext}"
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
    print()
    print("=== BENCH RUN COMPLETE ===")
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


# ===========================================================================
# Argument Parser
# ===========================================================================


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="ComfyUI Benchmark & Workflow Automation",
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
        "--workflow", required=True, choices=list(WORKFLOW_MAP.keys()),
        help="Workflow variant to convert",
    )

    # run (API mode)
    p_run = subs.add_parser("run", help="Run a workflow benchmark (API mode)")
    p_run.add_argument(
        "--workflow", required=True, choices=list(WORKFLOW_MAP.keys()),
        help="Workflow variant to run",
    )
    p_run.add_argument("--tag", default="", help="Tag for this run (e.g., baseline, comparison)")
    p_run.add_argument("--input-image", default=None, help="Override input image path")
    p_run.add_argument("--force-restart", action="store_true", help="Restart ComfyUI before run")

    # run-ui (Playwright mode — drives the real web UI)
    p_rui = subs.add_parser("run-ui", help="Run a workflow benchmark via Playwright (web UI)")
    p_rui.add_argument(
        "--workflow", required=True, choices=list(WORKFLOW_MAP.keys()),
        help="Workflow variant to run",
    )
    p_rui.add_argument("--tag", default="", help="Tag for this run (e.g., baseline, comparison)")
    p_rui.add_argument("--force-restart", action="store_true", help="Restart ComfyUI before run")

    return parser


# ===========================================================================
# Main
# ===========================================================================


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
    }
    cmd_map[args.command](args)


if __name__ == "__main__":
    main()
