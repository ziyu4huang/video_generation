# python/embed-bench/backends/llamacpp.py
from __future__ import annotations

import json
import urllib.request

BASE_URL = "http://localhost:8080/v1"


def is_available() -> bool:
    try:
        urllib.request.urlopen(f"{BASE_URL}/models", timeout=2)
        return True
    except Exception:
        return False


def embed_batch(texts: list[str]) -> list[list[float]]:
    # llama-server binds one model per process, so unlike LM Studio there's
    # no "model" field to select — whatever model the server was started
    # with is what responds.
    payload = json.dumps({"input": texts}).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read())
    return [item["embedding"] for item in body["data"]]
