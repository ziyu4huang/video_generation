from metrics import (
    QueryResult,
    mean_reciprocal_rank,
    percentile,
    rank_by_cosine_similarity,
    recall_at_k,
)


def test_recall_at_k_counts_hits_within_top_k():
    results = [
        QueryResult(query_id="q1", relevant_chunk_id="c1", ranked_chunk_ids=["c1", "c2", "c3"]),
        QueryResult(query_id="q2", relevant_chunk_id="c5", ranked_chunk_ids=["c2", "c3", "c4"]),
    ]

    assert recall_at_k(results, k=1) == 0.5
    assert recall_at_k(results, k=3) == 0.5  # c5 never appears in q2's ranking


def test_recall_at_k_empty_results_is_zero():
    assert recall_at_k([], k=5) == 0.0


def test_mean_reciprocal_rank_averages_inverse_rank():
    results = [
        QueryResult(query_id="q1", relevant_chunk_id="c1", ranked_chunk_ids=["c1", "c2"]),  # rank 1 -> 1.0
        QueryResult(query_id="q2", relevant_chunk_id="c2", ranked_chunk_ids=["c1", "c2"]),  # rank 2 -> 0.5
    ]

    assert mean_reciprocal_rank(results) == 0.75


def test_mean_reciprocal_rank_missing_relevant_doc_scores_zero():
    results = [
        QueryResult(query_id="q1", relevant_chunk_id="c9", ranked_chunk_ids=["c1", "c2"]),
    ]

    assert mean_reciprocal_rank(results) == 0.0


def test_rank_by_cosine_similarity_orders_most_similar_first():
    query_vec = [1.0, 0.0]
    chunk_vecs = {
        "exact": [1.0, 0.0],
        "orthogonal": [0.0, 1.0],
        "opposite": [-1.0, 0.0],
    }

    ranked = rank_by_cosine_similarity(query_vec, chunk_vecs)

    assert ranked == ["exact", "orthogonal", "opposite"]


def test_percentile_p50_is_median_for_odd_count():
    assert percentile([10.0, 30.0, 20.0], 50) == 20.0


def test_percentile_p95_near_top_of_range():
    values = [float(i) for i in range(1, 101)]  # 1..100

    assert percentile(values, 95) == 95.0


def test_percentile_empty_list_is_zero():
    assert percentile([], 50) == 0.0
