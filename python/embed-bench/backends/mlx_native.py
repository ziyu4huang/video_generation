# python/embed-bench/backends/mlx_native.py
from __future__ import annotations

import sys

import mlx.core as mx
from mlx_embeddings.utils import load

# run.py's access pattern never interleaves models within a single process
# (it finishes all backends for one model.json entry before moving to the
# next), so caching more than the current model buys nothing and just keeps
# every previously-touched model's weights resident. On a machine already
# running multiple other MLX/GGUF processes concurrently (the Swift
# embed-mlx-server, llama-server, LM Studio), that accumulation was a real
# contributor to a memory-pressure incident that got both this process and
# the unrelated launchd-managed embed-mlx-server SIGKILLed (2026-08-10) — see
# swift/embed-mlx-server's README / project memory. Keep only one model
# resident, and release MLX's Metal scratch-buffer cache (which is not
# returned to the OS automatically — ml-explore/mlx docs) on every switch.
_loaded_model: tuple[str, tuple] | None = None
_MICRO_BATCH_SIZE = 32


def _get_model(hf_repo: str):
    global _loaded_model
    if _loaded_model is None or _loaded_model[0] != hf_repo:
        _loaded_model = (hf_repo, load(hf_repo))
        mx.clear_cache()
    return _loaded_model[1]


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
