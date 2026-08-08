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
