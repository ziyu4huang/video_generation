# python/embed-bench/backends/mlx_native.py
from __future__ import annotations

import sys

from mlx_embeddings.utils import load

_loaded_models: dict[str, tuple] = {}
_MICRO_BATCH_SIZE = 32


def _get_model(hf_repo: str):
    if hf_repo not in _loaded_models:
        _loaded_models[hf_repo] = load(hf_repo)
    return _loaded_models[hf_repo]


def is_available(hf_repo: str | None) -> bool:
    if hf_repo is None:
        return False
    try:
        _get_model(hf_repo)
        return True
    except Exception as exc:
        print(f"mlx_native unavailable for {hf_repo}: {exc}", file=sys.stderr)
        return False


def embed_batch(hf_repo: str, texts: list[str], max_length: int = 512) -> list[list[float]]:
    model, tokenizer = _get_model(hf_repo)
    embeddings: list[list[float]] = []
    for start in range(0, len(texts), _MICRO_BATCH_SIZE):
        micro_batch = texts[start : start + _MICRO_BATCH_SIZE]
        inputs = tokenizer.batch_encode_plus(
            micro_batch,
            return_tensors="mlx",
            padding=True,
            truncation=True,
            max_length=max_length,
        )
        outputs = model(inputs["input_ids"], attention_mask=inputs["attention_mask"])
        embeddings.extend(row.tolist() for row in outputs.text_embeds)
    return embeddings
