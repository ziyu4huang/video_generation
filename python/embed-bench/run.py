# python/embed-bench/run.py
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from backends import lmstudio, llamacpp, mlx_native  # noqa: E402
from corpus import Chunk, load_and_chunk  # noqa: E402
from metrics import (  # noqa: E402
    QueryResult,
    mean_reciprocal_rank,
    percentile,
    rank_by_cosine_similarity,
    recall_at_k,
)
from query_gen import generate_queries  # noqa: E402
from report import write_report  # noqa: E402

DEFAULT_JUDGE_MODEL = "google/gemma-4-26b-a4b-qat"


def _load_model_configs(config_path: Path) -> dict:
    return json.loads(config_path.read_text(encoding="utf-8"))


def _time_single_calls(embed_fn, sample_text: str, reps: int) -> list[float]:
    durations = []
    for _ in range(reps):
        start = time.perf_counter()
        embed_fn([sample_text])
        durations.append((time.perf_counter() - start) * 1000)
    return durations


def _skipped_row(model_name: str, backend_name: str, reason: str = "unavailable") -> dict:
    return {
        "model": model_name,
        "backend": backend_name,
        "recall@1": "not tested",
        "recall@5": "not tested",
        "mrr": "not tested",
        "p50_ms": "not tested",
        "p95_ms": "not tested",
        "throughput_per_sec": "not tested",
        "reason": reason,
    }


def _run_combo(backend_name: str, model_name: str, embed_fn, chunks: list[Chunk], queries: list[tuple[str, str, str]]) -> dict:
    try:
        chunk_texts = [c.text for c in chunks]
        chunk_ids = [c.chunk_id for c in chunks]
        chunk_vecs = dict(zip(chunk_ids, embed_fn(chunk_texts)))

        query_results = []
        for query_id, relevant_chunk_id, query_text in queries:
            query_vec = embed_fn([query_text])[0]
            ranked = rank_by_cosine_similarity(query_vec, chunk_vecs)
            query_results.append(QueryResult(query_id, relevant_chunk_id, ranked))

        single_latencies = _time_single_calls(embed_fn, chunk_texts[0], reps=50)
        batch_texts = chunk_texts[:32]
        batch_start = time.perf_counter()
        embed_fn(batch_texts)
        batch_elapsed = time.perf_counter() - batch_start
        throughput = len(batch_texts) / batch_elapsed if batch_elapsed > 0 else 0.0

        return {
            "model": model_name,
            "backend": backend_name,
            "recall@1": recall_at_k(query_results, 1),
            "recall@5": recall_at_k(query_results, 5),
            "mrr": mean_reciprocal_rank(query_results),
            "p50_ms": percentile(single_latencies, 50),
            "p95_ms": percentile(single_latencies, 95),
            "throughput_per_sec": throughput,
        }
    except Exception as exc:
        print(f"  {backend_name}/{model_name} failed mid-run, marking not tested: {exc}", file=sys.stderr)
        return _skipped_row(model_name, backend_name, reason=repr(exc))


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark local embedding backends")
    parser.add_argument("corpus_dirs", nargs="+", type=Path, help="Directories to scan for *.md files")
    parser.add_argument("--models-config", type=Path, default=Path(__file__).parent / "models.json")
    parser.add_argument("--queries-per-chunk", type=int, default=2)
    parser.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "results")
    args = parser.parse_args()

    chunks = load_and_chunk(args.corpus_dirs)
    print(f"Loaded {len(chunks)} chunks from {len(args.corpus_dirs)} director{'y' if len(args.corpus_dirs) == 1 else 'ies'}")

    queries: list[tuple[str, str, str]] = []
    for chunk in chunks:
        try:
            generated = generate_queries(chunk.text, args.queries_per_chunk, args.judge_model)
        except Exception as exc:
            print(f"  query generation failed for {chunk.chunk_id}, skipping: {exc}", file=sys.stderr)
            continue
        for i, query_text in enumerate(generated):
            queries.append((f"{chunk.chunk_id}::q{i}", chunk.chunk_id, query_text))
    print(f"Generated {len(queries)} synthetic queries")

    model_configs = _load_model_configs(args.models_config)
    rows: list[dict] = []
    for model_name, config in model_configs.items():
        if lmstudio.is_available():
            print(f"Running lmstudio / {model_name}...")
            rows.append(_run_combo("lmstudio", model_name, lambda t, c=config: lmstudio.embed_batch(c["lmstudio_model_id"], t), chunks, queries))
        else:
            print(f"  lmstudio / {model_name} not available, skipping")
            rows.append(_skipped_row(model_name, "lmstudio"))

        if llamacpp.is_available():
            print(f"Running llamacpp / {model_name}...")
            rows.append(_run_combo("llamacpp", model_name, lambda t: llamacpp.embed_batch(t), chunks, queries))
        else:
            print(f"  llamacpp / {model_name} not available, skipping")
            rows.append(_skipped_row(model_name, "llamacpp"))

        mlx_repo = config.get("mlx_hf_repo")
        mlx_max_length = config.get("mlx_max_length", 512)
        if mlx_native.is_available(mlx_repo):
            print(f"Running mlx_native / {model_name}...")
            rows.append(_run_combo("mlx_native", model_name, lambda t, r=mlx_repo, m=mlx_max_length: mlx_native.embed_batch(r, t, max_length=m), chunks, queries))
        else:
            print(f"  mlx_native / {model_name} not available, skipping")
            rows.append(_skipped_row(model_name, "mlx_native"))

    write_report(rows, args.output_dir)
    print(f"Report written to {args.output_dir}/report.md")


if __name__ == "__main__":
    main()
