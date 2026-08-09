from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class QueryResult:
    query_id: str
    relevant_chunk_id: str
    ranked_chunk_ids: list[str]  # most similar first


def recall_at_k(results: list[QueryResult], k: int) -> float:
    if not results:
        return 0.0
    hits = sum(1 for r in results if r.relevant_chunk_id in r.ranked_chunk_ids[:k])
    return hits / len(results)


def mean_reciprocal_rank(results: list[QueryResult]) -> float:
    if not results:
        return 0.0
    reciprocal_ranks = []
    for r in results:
        try:
            rank = r.ranked_chunk_ids.index(r.relevant_chunk_id) + 1
            reciprocal_ranks.append(1.0 / rank)
        except ValueError:
            reciprocal_ranks.append(0.0)
    return sum(reciprocal_ranks) / len(reciprocal_ranks)


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def rank_by_cosine_similarity(query_vec: list[float], chunk_vecs: dict[str, list[float]]) -> list[str]:
    scored = [(chunk_id, _cosine_similarity(query_vec, vec)) for chunk_id, vec in chunk_vecs.items()]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return [chunk_id for chunk_id, _ in scored]


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(int(round(p / 100 * (len(ordered) - 1))), len(ordered) - 1)
    return ordered[index]
