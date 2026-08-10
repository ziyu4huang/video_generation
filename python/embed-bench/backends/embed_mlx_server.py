# python/embed-bench/backends/embed_mlx_server.py
from __future__ import annotations

import json
import socket
import urllib.request

HOST = "127.0.0.1"

# The server is single-model-per-process (see
# swift/embed-mlx-server/Sources/EmbedMLXServer/Config.swift), so an A/B
# across models needs one running instance per model, each on its own port.
# Port 8090 is the launchd-managed production instance (bge-m3) — never
# started/stopped by this file. Other entries are ad-hoc `serve --port ...
# --model ...` processes the caller is responsible for starting before a run
# and stopping afterward.
MODEL_PORTS = {
    "bge-m3": 8090,
    "qwen3-embedding-0.6b": 8091,
}

# This service is meant to stay compact — a lightweight production endpoint,
# not something benchmarking or bulk callers should push big batches through.
# Its own EmbeddingEngine only ever runs 32 texts per MLX forward pass
# (ServerConfig.defaultMicroBatchSize in the Swift server), so a client
# request of more than that just queues work behind a single HTTP call for
# no benefit — match it 1:1 so each request is exactly one forward pass.
_MICRO_BATCH_SIZE = 32

# Secondary safety net, independent of the count cap above: Hummingbird's
# BasicRequestContext.maxUploadSize defaults to 2 MiB (2*1024*1024 bytes) and
# the server has no override for it — a request body over that limit gets
# truncated during collection, which then fails JSON decode and surfaces as
# a misleading "invalid JSON" 400. 32 texts should never get near this, but
# pathologically long individual texts still could.
_MICRO_BATCH_CHARS = 400_000


def is_available(model_name: str) -> bool:
    # No /v1/models or health route (documented limitation of the server), so
    # unlike lmstudio.py/llamacpp.py this can't do a lightweight HTTP probe.
    # A raw TCP connect checks the process is listening without triggering
    # real inference just to test liveness.
    port = MODEL_PORTS.get(model_name)
    if port is None:
        return False
    try:
        with socket.create_connection((HOST, port), timeout=2):
            return True
    except OSError:
        return False


def _post_batch(port: int, texts: list[str]) -> list[list[float]]:
    # The server accepts but ignores the "model" field (it always serves
    # whatever repo it was started with), so any placeholder string is fine.
    payload = json.dumps({"model": "unused", "input": texts}).encode("utf-8")
    request = urllib.request.Request(
        f"http://{HOST}:{port}/v1/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read())
    return [item["embedding"] for item in body["data"]]


def embed_batch(model_name: str, texts: list[str]) -> list[list[float]]:
    port = MODEL_PORTS[model_name]
    embeddings: list[list[float]] = []
    micro_batch: list[str] = []
    micro_batch_chars = 0
    for text in texts:
        would_overflow = micro_batch and (
            len(micro_batch) >= _MICRO_BATCH_SIZE or micro_batch_chars + len(text) > _MICRO_BATCH_CHARS
        )
        if would_overflow:
            embeddings.extend(_post_batch(port, micro_batch))
            micro_batch = []
            micro_batch_chars = 0
        micro_batch.append(text)
        micro_batch_chars += len(text)
    if micro_batch:
        embeddings.extend(_post_batch(port, micro_batch))
    return embeddings
