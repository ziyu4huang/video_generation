# python/embed-bench/backends/mlx_native.py
from __future__ import annotations

from mlx_embeddings.utils import load

_loaded_models: dict[str, tuple] = {}


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
    except Exception:
        return False


def embed_batch(hf_repo: str, texts: list[str]) -> list[list[float]]:
    model, tokenizer = _get_model(hf_repo)
    inputs = tokenizer.batch_encode_plus(
        texts,
        return_tensors="mlx",
        padding=True,
        truncation=True,
        max_length=512,
    )
    outputs = model(inputs["input_ids"], attention_mask=inputs["attention_mask"])
    return [row.tolist() for row in outputs.text_embeds]
