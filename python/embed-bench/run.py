# python/embed-bench/run.py
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from backends import embed_mlx_server, lmstudio, llamacpp, mlx_native  # noqa: E402
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


def _queries_fingerprint(chunks: list[Chunk], queries_per_chunk: int, judge_model: str) -> str:
    # Ties the cache to exactly the inputs that determine query content: the
    # corpus text/chunking and the query-gen config. Any change to source
    # data or approach changes the fingerprint, so a stale cache is detected
    # automatically instead of silently reused.
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk.chunk_id.encode("utf-8"))
        digest.update(chunk.text.encode("utf-8"))
    digest.update(str(queries_per_chunk).encode("utf-8"))
    digest.update(judge_model.encode("utf-8"))
    return digest.hexdigest()[:16]



def _read_cache_records(cache_path: Path) -> list:
    # JSONL, not one big JSON blob: each query is its own line, so git diffs
    # on a re-generation show exactly which queries changed, and (more
    # importantly) a query gets flushed to disk the moment it's generated —
    # a process killed mid-run (this has happened twice: once to system
    # memory pressure, once to a harness/session restart) loses at most the
    # in-flight query, not the whole set generated so far, and the run can
    # resume from it instead of re-paying the judge LLM for chunks it
    # already covered. A line that fails to parse is a write cut short
    # mid-syscall by the same kind of interruption — stop there rather than
    # erroring, since flush() makes every *earlier* line durable.
    records = []
    for line in cache_path.read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            break
    return records


def _load_or_generate_queries(
    chunks: list[Chunk], queries_per_chunk: int, judge_model: str, cache_path: Path | None
) -> list[tuple[str, str, str]]:
    fingerprint = _queries_fingerprint(chunks, queries_per_chunk, judge_model)

    queries: list[tuple[str, str, str]] = []
    done_chunk_ids: set[str] = set()
    resume = False

    if cache_path is not None and cache_path.exists():
        records = _read_cache_records(cache_path)
        if records and records[0].get("fingerprint") == fingerprint:
            body = records[1:]
            if body and body[-1] == {"complete": True}:
                queries = [tuple(r) for r in body[:-1]]
                print(f"Loaded {len(queries)} cached queries from {cache_path} (skipped judge LLM)")
                return queries
            queries = [tuple(r) for r in body if r != {"complete": True}]
            done_chunk_ids = {relevant_chunk_id for _, relevant_chunk_id, _ in queries}
            resume = bool(queries)
            if resume:
                print(f"Resuming from {len(queries)} cached queries ({len(done_chunk_ids)} chunks already covered) in {cache_path}")
        else:
            print(f"Cache at {cache_path} is stale (corpus or query-gen config changed), regenerating from scratch...")

    cache_file = None
    if cache_path is not None:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        if resume:
            cache_file = cache_path.open("a", encoding="utf-8")
        else:
            cache_file = cache_path.open("w", encoding="utf-8")
            cache_file.write(json.dumps({"fingerprint": fingerprint}, ensure_ascii=False) + "\n")
            cache_file.flush()

    for chunk in chunks:
        if chunk.chunk_id in done_chunk_ids:
            continue
        try:
            generated = generate_queries(chunk.text, queries_per_chunk, judge_model)
        except Exception as exc:
            print(f"  query generation failed for {chunk.chunk_id}, skipping: {exc}", file=sys.stderr)
            continue
        for i, query_text in enumerate(generated):
            record = (f"{chunk.chunk_id}::q{i}", chunk.chunk_id, query_text)
            queries.append(record)
            if cache_file is not None:
                cache_file.write(json.dumps(list(record), ensure_ascii=False) + "\n")
                cache_file.flush()
    print(f"Generated {len(queries)} total synthetic queries" + (" (including resumed)" if resume else ""))

    if cache_file is not None:
        cache_file.write(json.dumps({"complete": True}) + "\n")
        cache_file.close()
        print(f"Saved {len(queries)} queries to {cache_path}")

    return queries


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
    parser.add_argument(
        "--backends",
        default="lmstudio,llamacpp,mlx_native,embed_mlx_server",
        help="Comma-separated subset of backends to exercise (default: all).",
    )
    parser.add_argument(
        "--models",
        default=None,
        help="Comma-separated subset of models.json keys to exercise (default: all).",
    )
    parser.add_argument(
        "--queries-cache",
        type=Path,
        default=None,
        help=(
            "Path to a JSONL file caching generated queries (one per line, plus a fingerprint "
            "header and a completion trailer), keyed by a fingerprint of the corpus + "
            "--queries-per-chunk + --judge-model. Reused across runs (no judge LLM calls) until "
            "the corpus or query-gen config changes; commit this file to reuse the same query "
            "set across backend-scoped re-runs."
        ),
    )
    args = parser.parse_args()
    args.backends = set(args.backends.split(","))

    chunks = load_and_chunk(args.corpus_dirs)
    print(f"Loaded {len(chunks)} chunks from {len(args.corpus_dirs)} director{'y' if len(args.corpus_dirs) == 1 else 'ies'}")

    queries = _load_or_generate_queries(chunks, args.queries_per_chunk, args.judge_model, args.queries_cache)

    model_configs = _load_model_configs(args.models_config)
    if args.models is not None:
        wanted = set(args.models.split(","))
        model_configs = {k: v for k, v in model_configs.items() if k in wanted}
    rows: list[dict] = []
    for model_name, config in model_configs.items():
        if "lmstudio" in args.backends:
            if lmstudio.is_available():
                print(f"Running lmstudio / {model_name}...")
                rows.append(_run_combo("lmstudio", model_name, lambda t, c=config: lmstudio.embed_batch(c["lmstudio_model_id"], t), chunks, queries))
            else:
                print(f"  lmstudio / {model_name} not available, skipping")
                rows.append(_skipped_row(model_name, "lmstudio"))

        if "llamacpp" in args.backends:
            if llamacpp.is_available():
                print(f"Running llamacpp / {model_name}...")
                rows.append(_run_combo("llamacpp", model_name, lambda t: llamacpp.embed_batch(t), chunks, queries))
            else:
                print(f"  llamacpp / {model_name} not available, skipping")
                rows.append(_skipped_row(model_name, "llamacpp"))

        if "mlx_native" in args.backends:
            mlx_repo = config.get("mlx_hf_repo")
            mlx_max_length = config.get("mlx_max_length", 512)
            if mlx_native.is_available(mlx_repo):
                print(f"Running mlx_native / {model_name}...")
                rows.append(_run_combo("mlx_native", model_name, lambda t, r=mlx_repo, m=mlx_max_length: mlx_native.embed_batch(r, t, max_length=m), chunks, queries))
            else:
                print(f"  mlx_native / {model_name} not available, skipping")
                rows.append(_skipped_row(model_name, "mlx_native"))

        # embed_mlx_server is single-model-per-process, so each model needs
        # its own running `serve --port ... --model ...` instance (see
        # MODEL_PORTS) before it can be exercised here.
        if "embed_mlx_server" in args.backends:
            if embed_mlx_server.is_available(model_name):
                print(f"Running embed_mlx_server / {model_name}...")
                rows.append(_run_combo("embed_mlx_server", model_name, lambda t, m=model_name: embed_mlx_server.embed_batch(m, t), chunks, queries))
            else:
                print(f"  embed_mlx_server / {model_name} not available, skipping")
                rows.append(_skipped_row(model_name, "embed_mlx_server"))

    write_report(rows, args.output_dir)
    print(f"Report written to {args.output_dir}/report.md")


if __name__ == "__main__":
    main()
