# python/embed-bench/backends/lmstudio.py
from __future__ import annotations

import json
import urllib.request

BASE_URL = "http://localhost:1234/v1"


def is_available() -> bool:
    try:
        urllib.request.urlopen(f"{BASE_URL}/models", timeout=2)
        return True
    except Exception:
        return False


def embed_batch(model_id: str, texts: list[str]) -> list[list[float]]:
    payload = json.dumps({"model": model_id, "input": texts}).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read())
    return [item["embedding"] for item in body["data"]]
