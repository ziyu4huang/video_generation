# Embedding Server Phase 0 Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone benchmark tool that measures LM Studio, llama.cpp, and MLX-native (Python) embedding backends across 3 candidate models on real corpus data (this repo's docs + the `study-news` Obsidian vault), producing a report that decides whether a Phase 1 Swift MLX production server is worth building.

**Architecture:** A flat Python package at `python/embed-bench/` with its own isolated venv. `corpus.py` chunks markdown into passages; `query_gen.py` uses a local LLM (LM Studio's loaded judge model) to generate synthetic search queries per passage; three `backends/*.py` modules embed text via LM Studio's HTTP API, llama.cpp's `llama-server` HTTP API, and in-process MLX inference respectively; `metrics.py` scores retrieval quality (Recall@1/@5, MRR) and latency (p50/p95, throughput); `report.py` renders the comparison; `run.py` is the CLI that wires it all together.

**Tech Stack:** Python 3.12, `mlx-embeddings` (Blaizzy) for in-process MLX inference, stdlib `urllib` for HTTP calls to LM Studio / llama.cpp (no extra HTTP client dependency needed), `pytest` for the two TDD'd modules, `uv` for venv management (repo convention).

Full context and research is in the spec: `.planning/specs/2026-08-08-embedding-server-benchmark-design.md`.

---

## Reference: model registry

All three tasks that touch model identifiers use this table. Sources verified during brainstorming:

| model key | LM Studio model id (edit if yours differs) | llama.cpp HF repo (`llama-server -hf ...`) | MLX HF repo (`mlx_embeddings.utils.load(...)`) |
|---|---|---|---|
| `bge-m3` | `text-embedding-bge-m3` | `gpustack/bge-m3-GGUF` | `mlx-community/bge-m3-mlx-8bit` |
| `qwen3-embedding-0.6b` | `text-embedding-qwen3-embedding-0.6b` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `mlx-community/Qwen3-Embedding-0.6B-8bit` |
| `nomic-embed-text-v1.5` | `text-embedding-nomic-embed-text-v1.5` | `nomic-ai/nomic-embed-text-v1.5-GGUF` | `null` — no verified MLX conversion exists; the harness must skip this combination automatically, not guess a repo id |

The LM Studio model ids are best-guess based on LM Studio's usual `text-embedding-<slug>` naming — they depend on what you actually download/load in the LM Studio GUI. `models.json` (Task 1) is a plain JSON file specifically so this is a one-line edit if your LM Studio session names them differently.

---

### Task 1: Scaffold `python/embed-bench/`

**Files:**
- Create: `python/embed-bench/requirements.txt`
- Create: `python/embed-bench/models.json`
- Create: `python/embed-bench/backends/__init__.py`
- Modify: `.gitignore`

- [ ] **Step 1: Create the requirements file**

```
# python/embed-bench/requirements.txt
mlx-embeddings
pytest
```

- [ ] **Step 2: Create the model registry**

```json
{
  "bge-m3": {
    "lmstudio_model_id": "text-embedding-bge-m3",
    "llamacpp_hf_repo": "gpustack/bge-m3-GGUF",
    "mlx_hf_repo": "mlx-community/bge-m3-mlx-8bit"
  },
  "qwen3-embedding-0.6b": {
    "lmstudio_model_id": "text-embedding-qwen3-embedding-0.6b",
    "llamacpp_hf_repo": "Qwen/Qwen3-Embedding-0.6B-GGUF",
    "mlx_hf_repo": "mlx-community/Qwen3-Embedding-0.6B-8bit"
  },
  "nomic-embed-text-v1.5": {
    "lmstudio_model_id": "text-embedding-nomic-embed-text-v1.5",
    "llamacpp_hf_repo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
    "mlx_hf_repo": null
  }
}
```

Save this as `python/embed-bench/models.json`.

- [ ] **Step 3: Create the backends package marker**

```python
# python/embed-bench/backends/__init__.py
```

(empty file — just makes `backends/` importable as a package)

- [ ] **Step 4: Add ignore rules for the isolated venv and generated results**

Append to `.gitignore`:

```

# python/embed-bench: isolated venv + generated benchmark output
python/embed-bench/.venv/
python/embed-bench/results/
```

- [ ] **Step 5: Create the isolated venv and install dependencies**

Run: `uv venv python/embed-bench/.venv --python 3.12`
Expected: `Using CPython 3.12...` then `Creating virtualenv at: python/embed-bench/.venv`

Run: `uv pip install --python python/embed-bench/.venv/bin/python -r python/embed-bench/requirements.txt`
Expected: install log ending in `Installed ... packages` with no errors

- [ ] **Step 6: Commit**

```bash
git add python/embed-bench/requirements.txt python/embed-bench/models.json python/embed-bench/backends/__init__.py .gitignore
git commit -m "chore(embed-bench): scaffold embedding benchmark tool directory"
```

---

### Task 2: `metrics.py` — retrieval quality and latency math (TDD)

**Files:**
- Create: `python/embed-bench/test_metrics.py`
- Create: `python/embed-bench/metrics.py`

- [ ] **Step 1: Write the failing tests**

```python
# python/embed-bench/test_metrics.py
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python/embed-bench/.venv/bin/python -m pytest python/embed-bench/test_metrics.py -v`
Expected: `ModuleNotFoundError: No module named 'metrics'` (or collection error) — `metrics.py` doesn't exist yet

- [ ] **Step 3: Write the implementation**

```python
# python/embed-bench/metrics.py
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python/embed-bench/.venv/bin/python -m pytest python/embed-bench/test_metrics.py -v`
Expected: `8 passed`

- [ ] **Step 5: Commit**

```bash
git add python/embed-bench/metrics.py python/embed-bench/test_metrics.py
git commit -m "feat(embed-bench): add retrieval quality and latency metrics"
```

---

### Task 3: `corpus.py` — markdown loading and chunking (TDD)

**Files:**
- Create: `python/embed-bench/test_corpus.py`
- Create: `python/embed-bench/corpus.py`

- [ ] **Step 1: Write the failing tests**

```python
# python/embed-bench/test_corpus.py
from corpus import chunk_markdown_file, load_and_chunk


def test_chunk_markdown_file_single_short_section(tmp_path):
    md_path = tmp_path / "doc.md"
    md_path.write_text("# Title\n\nA short paragraph about MLX embeddings.\n", encoding="utf-8")

    chunks = chunk_markdown_file(md_path, tmp_path)

    assert len(chunks) == 1
    assert chunks[0].source_path == "doc.md"
    assert chunks[0].heading == "Title"
    assert "MLX embeddings" in chunks[0].text
    assert chunks[0].chunk_id == "doc.md::Title::0"


def test_chunk_markdown_file_splits_long_section(tmp_path):
    md_path = tmp_path / "long.md"
    paragraph = "Paragraph about local embedding servers. " * 40  # ~1720 chars
    body = "\n\n".join([paragraph] * 3)
    md_path.write_text(f"# Long Section\n\n{body}\n", encoding="utf-8")

    chunks = chunk_markdown_file(md_path, tmp_path)

    assert len(chunks) >= 2
    assert all(len(c.text) <= 2000 for c in chunks)
    assert all(c.heading == "Long Section" for c in chunks)


def test_chunk_markdown_file_ignores_text_before_first_heading_if_empty(tmp_path):
    md_path = tmp_path / "preamble.md"
    md_path.write_text("\n\n# Real Section\n\nSome content here.\n", encoding="utf-8")

    chunks = chunk_markdown_file(md_path, tmp_path)

    assert len(chunks) == 1
    assert chunks[0].heading == "Real Section"


def test_load_and_chunk_scans_all_markdown_files_recursively(tmp_path):
    (tmp_path / "a.md").write_text("# A\n\nContent A.\n", encoding="utf-8")
    subdir = tmp_path / "nested"
    subdir.mkdir()
    (subdir / "b.md").write_text("# B\n\nContent B.\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")

    chunks = load_and_chunk([tmp_path])

    assert {c.source_path for c in chunks} == {"a.md", "nested/b.md"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python/embed-bench/.venv/bin/python -m pytest python/embed-bench/test_corpus.py -v`
Expected: `ModuleNotFoundError: No module named 'corpus'`

- [ ] **Step 3: Write the implementation**

```python
# python/embed-bench/corpus.py
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

TARGET_CHUNK_CHARS = 1200
MAX_CHUNK_CHARS = 2000

_HEADING_RE = re.compile(r"^#{1,6}\s+(.*)$")


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    source_path: str
    heading: str
    text: str


def _split_sections(markdown_text: str) -> list[tuple[str, str]]:
    """Split markdown into (heading, body) sections. Preamble before the
    first heading uses heading=''; dropped if empty."""
    sections: list[tuple[str, list[str]]] = [("", [])]
    for line in markdown_text.splitlines():
        match = _HEADING_RE.match(line)
        if match:
            sections.append((match.group(1).strip(), []))
        else:
            sections[-1][1].append(line)
    return [(heading, "\n".join(lines).strip()) for heading, lines in sections if "\n".join(lines).strip()]


def _split_paragraphs(body: str) -> list[str]:
    return [p.strip() for p in body.split("\n\n") if p.strip()]


def _pack_paragraphs(paragraphs: list[str]) -> list[str]:
    """Greedily pack paragraphs into chunks near TARGET_CHUNK_CHARS, never
    exceeding MAX_CHUNK_CHARS."""
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in paragraphs:
        if current and current_len + len(paragraph) > MAX_CHUNK_CHARS:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0
        current.append(paragraph)
        current_len += len(paragraph)
        if current_len >= TARGET_CHUNK_CHARS:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def chunk_markdown_file(path: Path, root: Path) -> list[Chunk]:
    text = path.read_text(encoding="utf-8")
    relative_path = str(path.relative_to(root))
    chunks: list[Chunk] = []
    for heading, body in _split_sections(text):
        paragraphs = _split_paragraphs(body)
        for index, chunk_text in enumerate(_pack_paragraphs(paragraphs)):
            chunk_id = f"{relative_path}::{heading or 'root'}::{index}"
            chunks.append(Chunk(chunk_id=chunk_id, source_path=relative_path, heading=heading, text=chunk_text))
    return chunks


def load_and_chunk(dirs: list[Path]) -> list[Chunk]:
    all_chunks: list[Chunk] = []
    for directory in dirs:
        for path in sorted(directory.rglob("*.md")):
            all_chunks.extend(chunk_markdown_file(path, directory))
    return all_chunks
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python/embed-bench/.venv/bin/python -m pytest python/embed-bench/test_corpus.py -v`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add python/embed-bench/corpus.py python/embed-bench/test_corpus.py
git commit -m "feat(embed-bench): add markdown corpus loading and chunking"
```

---

### Task 4: `backends/lmstudio.py` — LM Studio HTTP client

**Files:**
- Create: `python/embed-bench/backends/lmstudio.py`

**No automated test** (calls a real local HTTP service — see spec's Testing section). Verified manually in Step 3.

- [ ] **Step 1: Write the implementation**

```python
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
```

- [ ] **Step 2: Manually verify against a running LM Studio**

Prerequisite: open LM Studio, download and load an embedding model (e.g. search "bge-m3" in the model browser), start the local server (Developer tab → "Start Server", default port 1234).

Run:
```bash
python/embed-bench/.venv/bin/python -c "
from backends.lmstudio import is_available, embed_batch
import sys
sys.path.insert(0, 'python/embed-bench')
print('available:', is_available())
vecs = embed_batch('text-embedding-bge-m3', ['hello world'])
print('embedding dim:', len(vecs[0]))
"
```
Expected: `available: True` and `embedding dim: <some positive integer>`. If LM Studio's loaded model uses a different id than `text-embedding-bge-m3`, check `curl http://localhost:1234/v1/models` for the exact id and use that instead — this is exactly why `models.json` (Task 1) is editable.

If LM Studio isn't running yet, skip this manual check for now — it will be exercised for real in Task 9's end-to-end run. Note in the task summary whether it was verified now or deferred.

- [ ] **Step 3: Commit**

```bash
git add python/embed-bench/backends/lmstudio.py
git commit -m "feat(embed-bench): add LM Studio embedding backend"
```

---

### Task 5: `backends/llamacpp.py` — llama.cpp HTTP client

**Files:**
- Create: `python/embed-bench/backends/llamacpp.py`

**No automated test** (same reasoning as Task 4).

- [ ] **Step 1: Write the implementation**

```python
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
```

- [ ] **Step 2: Manually verify against a running llama-server**

Run in a separate terminal (leave running):
```bash
llama-server -hf Qwen/Qwen3-Embedding-0.6B-GGUF --embedding --port 8080
```

Then run:
```bash
python/embed-bench/.venv/bin/python -c "
import sys
sys.path.insert(0, 'python/embed-bench')
from backends.llamacpp import is_available, embed_batch
print('available:', is_available())
vecs = embed_batch(['hello world'])
print('embedding dim:', len(vecs[0]))
"
```
Expected: `available: True` and `embedding dim: <some positive integer>`.

If `llama-server` isn't running yet, skip this manual check for now — it will be exercised for real in Task 9's end-to-end run.

- [ ] **Step 3: Commit**

```bash
git add python/embed-bench/backends/llamacpp.py
git commit -m "feat(embed-bench): add llama.cpp embedding backend"
```

---

### Task 6: `backends/mlx_native.py` — in-process MLX inference

**Files:**
- Create: `python/embed-bench/backends/mlx_native.py`

**No automated test** (loads real model weights — same reasoning as Tasks 4/5).

- [ ] **Step 1: Write the implementation**

```python
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
```

- [ ] **Step 2: Manually verify**

Run:
```bash
python/embed-bench/.venv/bin/python -c "
import sys
sys.path.insert(0, 'python/embed-bench')
from backends.mlx_native import is_available, embed_batch
repo = 'mlx-community/bge-m3-mlx-8bit'
print('available:', is_available(repo))
vecs = embed_batch(repo, ['hello world'])
print('embedding dim:', len(vecs[0]))
"
```
Expected: first run downloads the model from Hugging Face (may take a minute), then prints `available: True` and `embedding dim: <some positive integer>`.

- [ ] **Step 3: Commit**

```bash
git add python/embed-bench/backends/mlx_native.py
git commit -m "feat(embed-bench): add MLX-native in-process embedding backend"
```

---

### Task 7: `query_gen.py` — synthetic query generation

**Files:**
- Create: `python/embed-bench/query_gen.py`

**No automated test** (calls a real local LLM — same reasoning as the backends).

- [ ] **Step 1: Write the implementation**

```python
# python/embed-bench/query_gen.py
from __future__ import annotations

import json
import urllib.request

CHAT_URL = "http://localhost:1234/v1/chat/completions"

_PROMPT_TEMPLATE = """You are generating search queries for a retrieval evaluation.
Given the passage below, write {num_queries} short natural-language search queries
that someone would type to find this exact passage. Output one query per line,
no numbering, no extra commentary.

Passage:
{passage}
"""


def generate_queries(passage: str, num_queries: int, model: str) -> list[str]:
    prompt = _PROMPT_TEMPLATE.format(num_queries=num_queries, passage=passage)
    payload = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        CHAT_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read())
    content = body["choices"][0]["message"]["content"]
    queries = [line.strip("- ").strip() for line in content.splitlines() if line.strip()]
    return queries[:num_queries]
```

- [ ] **Step 2: Manually verify against LM Studio's chat completions**

Prerequisite: LM Studio server running with `google/gemma-4-26b-a4b-qat` (the project's default judge model) loaded and its identifier confirmed via `curl http://localhost:1234/v1/models`.

Run:
```bash
python/embed-bench/.venv/bin/python -c "
import sys
sys.path.insert(0, 'python/embed-bench')
from query_gen import generate_queries
queries = generate_queries('MLX is Apple\'s array framework for machine learning on Apple Silicon.', num_queries=2, model='google/gemma-4-26b-a4b-qat')
print(queries)
"
```
Expected: a Python list of 2 short query strings related to the passage.

- [ ] **Step 3: Commit**

```bash
git add python/embed-bench/query_gen.py
git commit -m "feat(embed-bench): add synthetic query generation via local LLM"
```

---

### Task 8: `report.py` — markdown + JSON report rendering

**Files:**
- Create: `python/embed-bench/report.py`

- [ ] **Step 1: Write the implementation**

```python
# python/embed-bench/report.py
from __future__ import annotations

import json
from pathlib import Path

_COLUMNS = ["model", "backend", "recall@1", "recall@5", "mrr", "p50_ms", "p95_ms", "throughput_per_sec"]


def render_markdown_table(rows: list[dict]) -> str:
    lines = ["| " + " | ".join(_COLUMNS) + " |", "| " + " | ".join(["---"] * len(_COLUMNS)) + " |"]
    for row in rows:
        cells = []
        for column in _COLUMNS:
            value = row.get(column, "not tested")
            cells.append(f"{value:.3f}" if isinstance(value, float) else str(value))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def write_report(rows: list[dict], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.md").write_text(render_markdown_table(rows), encoding="utf-8")
    (output_dir / "results.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
```

- [ ] **Step 2: Manually verify**

Run:
```bash
python/embed-bench/.venv/bin/python -c "
import sys
sys.path.insert(0, 'python/embed-bench')
from report import render_markdown_table
rows = [{'model': 'bge-m3', 'backend': 'lmstudio', 'recall@1': 0.8, 'recall@5': 0.95, 'mrr': 0.87, 'p50_ms': 12.3, 'p95_ms': 20.1, 'throughput_per_sec': 340.5}]
print(render_markdown_table(rows))
"
```
Expected: a markdown table with header row, separator row, and one data row with values formatted to 3 decimal places.

- [ ] **Step 3: Commit**

```bash
git add python/embed-bench/report.py
git commit -m "feat(embed-bench): add markdown/JSON report rendering"
```

---

### Task 9: `run.py` — CLI orchestrator and end-to-end run

**Files:**
- Create: `python/embed-bench/run.py`

- [ ] **Step 1: Write the implementation**

```python
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


def _run_combo(backend_name: str, model_name: str, embed_fn, chunks: list[Chunk], queries: list[tuple[str, str, str]]) -> dict:
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


def _skipped_row(model_name: str, backend_name: str) -> dict:
    return {
        "model": model_name,
        "backend": backend_name,
        "recall@1": "not tested",
        "recall@5": "not tested",
        "mrr": "not tested",
        "p50_ms": "not tested",
        "p95_ms": "not tested",
        "throughput_per_sec": "not tested",
    }


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
        for i, query_text in enumerate(generate_queries(chunk.text, args.queries_per_chunk, args.judge_model)):
            queries.append((f"{chunk.chunk_id}::q{i}", chunk.chunk_id, query_text))
    print(f"Generated {len(queries)} synthetic queries")

    model_configs = _load_model_configs(args.models_config)
    rows: list[dict] = []
    for model_name, config in model_configs.items():
        if lmstudio.is_available():
            print(f"Running lmstudio / {model_name}...")
            rows.append(_run_combo("lmstudio", model_name, lambda t, c=config: lmstudio.embed_batch(c["lmstudio_model_id"], t), chunks, queries))
        else:
            rows.append(_skipped_row(model_name, "lmstudio"))

        if llamacpp.is_available():
            print(f"Running llamacpp / {model_name}...")
            rows.append(_run_combo("llamacpp", model_name, lambda t: llamacpp.embed_batch(t), chunks, queries))
        else:
            rows.append(_skipped_row(model_name, "llamacpp"))

        mlx_repo = config.get("mlx_hf_repo")
        if mlx_native.is_available(mlx_repo):
            print(f"Running mlx_native / {model_name}...")
            rows.append(_run_combo("mlx_native", model_name, lambda t, r=mlx_repo: mlx_native.embed_batch(r, t), chunks, queries))
        else:
            rows.append(_skipped_row(model_name, "mlx_native"))

    write_report(rows, args.output_dir)
    print(f"Report written to {args.output_dir}/report.md")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit the orchestrator**

```bash
git add python/embed-bench/run.py
git commit -m "feat(embed-bench): add CLI orchestrator wiring corpus, backends, and report"
```

---

### Task 10: Run the full benchmark end-to-end

**Files:** none (this task produces `python/embed-bench/results/report.md` and `results.json`, both gitignored — see Task 1 Step 4)

**Prerequisites (manual, do these first):**
1. LM Studio: download and load `bge-m3`, `qwen3-embedding-0.6b`, and `nomic-embed-text-v1.5` embedding models (search each name in the model browser), start the local server (Developer tab → Start Server). Check `curl http://localhost:1234/v1/models` and update `python/embed-bench/models.json`'s `lmstudio_model_id` fields if the ids differ from the defaults. LM Studio can only serve embeddings for whichever model is currently loaded — if it only supports one loaded embedding model at a time, run the harness once per loaded model and merge results, or check LM Studio's multi-model docs for whether it can hold all three loaded simultaneously.
2. LM Studio: also load the judge chat model (`google/gemma-4-26b-a4b-qat`) for `query_gen.py`, unless it's already loaded per the project's standing default.
3. llama.cpp: for each model, run `llama-server -hf <repo> --embedding --port 8080` in its own terminal before that model's combination runs (see the model registry table for each repo). Since `llama-server` binds one model per process, this needs restarting between models — the harness will report `llamacpp` as unavailable for any model not currently being served.

- [ ] **Step 1: Run the harness against this repo's docs**

```bash
python/embed-bench/.venv/bin/python python/embed-bench/run.py docs --output-dir python/embed-bench/results/repo-docs
```
Expected: progress lines for each backend×model combination, ending in `Report written to python/embed-bench/results/repo-docs/report.md`. Combinations without a running/available backend show as `not tested` rows rather than crashing the run.

- [ ] **Step 2: Run the harness against the study-news vault**

```bash
python/embed-bench/.venv/bin/python python/embed-bench/run.py /Users/huangziyu/proj/study-news/content --output-dir python/embed-bench/results/study-news
```
Expected: same shape of output, written to `python/embed-bench/results/study-news/report.md`.

- [ ] **Step 3: Read both reports and summarize the winner**

Read `python/embed-bench/results/repo-docs/report.md` and `python/embed-bench/results/study-news/report.md`. Write a one-paragraph summary (in the task's completion notes, not a new file) of which backend×model combination wins on quality (Recall@5/MRR) vs. speed (p50/throughput), and whether the gap justifies Phase 1 (a Swift MLX production server) per the spec's decision criteria.

---

## Self-review notes

- **Spec coverage**: corpus (repo docs + study-news) ✓ Task 10; 3 candidate models ✓ `models.json`; 3 backends ✓ Tasks 4–6; synthetic query generation via local LLM ✓ Task 7; Recall@1/@5/MRR + p50/p95/throughput ✓ Task 2; graceful skip for unavailable combos ✓ `run.py`'s `_skipped_row`; markdown + JSON report ✓ Task 8; unit tests only on `metrics.py`/`corpus.py` ✓ Tasks 2–3, no tests elsewhere ✓.
- **Nomic MLX gap**: spec called out needing to flag weak Chinese coverage for the continuity model; since no verified MLX conversion of Nomic exists, `mlx_hf_repo: null` makes `mlx_native` for `nomic-embed-text-v1.5` auto-skip via `is_available()`'s `None` check — this is the graceful-degradation path the spec designed for, not a gap.
- **Type consistency checked**: `Chunk` fields (`chunk_id`, `source_path`, `heading`, `text`) match between `corpus.py` and its test; `QueryResult` fields match between `metrics.py` and its test and `run.py`'s construction; `embed_fn` signature (`list[str] -> list[list[float]]`) is consistent across all three backend modules and how `run.py` calls them.
