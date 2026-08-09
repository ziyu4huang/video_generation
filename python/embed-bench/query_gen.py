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
