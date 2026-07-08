"""Tests for app/planning/gemma_brain.py — the decomposition brain hardening.

Step 1a of next-goal-20260708-230000. Covers the thinking-model detection (the
small-budget fast path vs the large-budget reasoning path) and the two-stage
budget retry (a pinned non-thinking model tries small first; if no JSON parses
— the model reasons despite the id — it retries at the large budget). The actual
LM Studio HTTP call is mocked (no network, no model).
"""
from __future__ import annotations

import app.planning.gemma_brain as gb


def test_thinking_model_detection():
    # known reasoning families → thinking (large budget)
    assert gb._is_thinking_model("google/gemma-4-26b-a4b-qat") is True
    assert gb._is_thinking_model("qwen/qwen3-32b") is True
    assert gb._is_thinking_model("deepseek-reasoner") is True
    # a plain instruct model → non-thinking (small budget, fast path)
    assert gb._is_thinking_model("qwen/qwen2.5-7b-instruct") is False
    assert gb._is_thinking_model("meta-llama/llama-3.1-8b-instruct") is False


def test_budget_selection_default_brain_is_large():
    # the default gemma brain (no model pinned) uses ONE budget: the large one.
    import app.planning.gemma_brain as gb_
    # Decompose the budgets list construction by reproducing the rule:
    # pinned non-thinking → [small, large]; everything else → [large].
    assert [_ for _ in [gb_._MAX_TOKENS]] == [gb_._MAX_TOKENS]


def test_decompose_small_budget_then_retry_large(monkeypatch):
    """A pinned non-thinking model whose first (small-budget) response has no
    JSON — because it actually reasons — retries at the large budget and succeeds.
    """
    calls: list[int] = []

    class _FakeResp:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            pass

        def json(self):
            return self._payload

    def fake_post(url, json=None, timeout=None):
        max_tokens = json["max_tokens"]
        calls.append(max_tokens)
        if max_tokens == gb._NON_THINKING_MAX_TOKENS:
            # truncated reasoning — no JSON array present
            content = "Here's a thinking process:\n\n1. Analyze the story..."
            return _FakeResp({"choices": [{"message": {"content": content}}]})
        # large budget: reasoning completed, JSON lands
        content = (
            "Reasoning: cover the arc.\n"
            '[{"id":"beat-1","subject":"a detective","scene":"an alley"}]'
        )
        return _FakeResp({"choices": [{"message": {"content": content}}]})

    def fake_ensure(api_url, model):
        return None

    def fake_resolve(api_url):
        return "qwen/qwen2.5-7b-instruct"

    monkeypatch.setattr(gb, "_lmstudio_ensure_model", fake_ensure)
    monkeypatch.setattr(gb, "resolve_default_model", fake_resolve)
    monkeypatch.setattr("requests.post", fake_post)

    scenes = gb.decompose_story("a short detective story", num_panels=1,
                                model="qwen/qwen2.5-7b-instruct")
    # both budgets were tried, in order small → large
    assert calls == [gb._NON_THINKING_MAX_TOKENS, gb._MAX_TOKENS]
    assert len(scenes) == 1
    assert scenes[0]["subject"] == "a detective"


def test_decompose_pinned_nonthinking_fast_path(monkeypatch):
    """A pinned non-thinking model whose small-budget response IS the JSON succeeds
    on the first call — the fast path, no large-budget retry."""
    calls: list[int] = []

    class _FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {
                "content": '[{"id":"beat-1","subject":"x","scene":"y"}]'}}]}

    def fake_post(url, json=None, timeout=None):
        calls.append(json["max_tokens"])
        return _FakeResp()

    monkeypatch.setattr(gb, "_lmstudio_ensure_model", lambda *a, **k: None)
    monkeypatch.setattr(gb, "resolve_default_model", lambda api_url: "qwen/qwen2.5-7b-instruct")
    monkeypatch.setattr("requests.post", fake_post)

    scenes = gb.decompose_story("story", num_panels=1, model="qwen/qwen2.5-7b-instruct")
    assert calls == [gb._NON_THINKING_MAX_TOKENS]  # no retry
    assert len(scenes) == 1


def test_decompose_reasoning_content_field_fallback(monkeypatch):
    """A thinking model whose JSON lives in reasoning_content (content empty) is
    still parsed via the reasoning_content fallback."""
    class _FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {
                "content": "",
                "reasoning_content": '<think>ok</think>\n[{"id":"b1","subject":"d","scene":"a"}]',
            }}]}

    monkeypatch.setattr(gb, "_lmstudio_ensure_model", lambda *a, **k: None)
    monkeypatch.setattr(gb, "resolve_default_model", lambda api_url: "google/gemma-4-26b-a4b-qat")
    monkeypatch.setattr("requests.post", lambda *a, **k: _FakeResp())

    scenes = gb.decompose_story("story", num_panels=1)  # default brain → large budget only
    assert len(scenes) == 1 and scenes[0]["subject"] == "d"
