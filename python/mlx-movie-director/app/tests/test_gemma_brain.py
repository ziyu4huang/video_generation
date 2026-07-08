"""Tests for app/planning/gemma_brain.py — the decomposition brain fast path.

Step 1a of next-goal-20260709-000000. The fast path sends ``reasoning_effort:"none"``
(the knob LM Studio honors to suppress gemma-4-26b thinking — NOT
``enable_thinking``/``chat_template_kwargs``) with the small budget; the JSON lands
directly in ``content`` (~9s measured). The large-budget retry is a DEFENSIVE
safety net that fires only when the fast path produced no JSON — not thinking-ness
name-guessing. The LM Studio HTTP call is mocked (no network, no model).
"""
from __future__ import annotations

import app.planning.gemma_brain as gb


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def test_fast_path_sends_reasoning_effort_none(monkeypatch):
    """The DEFAULT gemma brain uses the fast path first: small budget +
    reasoning_effort:"none". When the JSON lands in `content` it returns on the
    first call — no large-budget retry."""
    sent: list[dict] = []

    def fake_post(url, json=None, timeout=None):
        sent.append(json)
        return _FakeResp({"choices": [{"message": {
            "content": '[{"id":"beat-1","subject":"a detective","scene":"an alley"}]',
            "reasoning_content": "",
        }}]})

    monkeypatch.setattr(gb, "_lmstudio_ensure_model", lambda *a, **k: None)
    monkeypatch.setattr(gb, "resolve_default_model", lambda api_url: "google/gemma-4-26b-a4b-qat")
    monkeypatch.setattr("requests.post", fake_post)

    scenes = gb.decompose_story("a short detective story", num_panels=1)
    # exactly one HTTP call, the fast path
    assert len(sent) == 1
    assert sent[0]["max_tokens"] == gb._NON_THINKING_MAX_TOKENS
    assert sent[0]["reasoning_effort"] == "none"  # the verified knob
    assert len(scenes) == 1 and scenes[0]["subject"] == "a detective"


def test_decompose_fast_path_no_json_retries_large(monkeypatch):
    """A brain that ignores reasoning_effort:none (its first call's content+reasoning
    both lack JSON) retries ONCE at the large budget WITHOUT reasoning_effort:none,
    and succeeds when the reasoning completes."""
    calls: list[dict] = []

    def fake_post(url, json=None, timeout=None):
        calls.append(json)
        if json.get("reasoning_effort") == "none":
            # fast path: truncated reasoning, no JSON array
            return _FakeResp({"choices": [{"message": {
                "content": "Here's a thinking process:\n\n1. Analyze the story...",
                "reasoning_content": "",
            }}]})
        # large budget, no reasoning suppression: reasoning completed, JSON lands
        return _FakeResp({"choices": [{"message": {
            "content": '[{"id":"beat-1","subject":"a detective","scene":"an alley"}]',
        }}]})

    monkeypatch.setattr(gb, "_lmstudio_ensure_model", lambda *a, **k: None)
    monkeypatch.setattr(gb, "resolve_default_model", lambda api_url: "google/gemma-4-26b-a4b-qat")
    monkeypatch.setattr("requests.post", fake_post)

    scenes = gb.decompose_story("a short detective story", num_panels=1)
    # both budgets tried, fast (small+reasoning:none) then safety net (large, none)
    assert len(calls) == 2
    assert calls[0]["max_tokens"] == gb._NON_THINKING_MAX_TOKENS
    assert calls[0]["reasoning_effort"] == "none"
    assert calls[1]["max_tokens"] == gb._MAX_TOKENS
    assert "reasoning_effort" not in calls[1]  # safety net lets reasoning run
    assert len(scenes) == 1 and scenes[0]["subject"] == "a detective"


def test_decompose_reasoning_content_fallback(monkeypatch):
    """A reasoning model whose JSON lives in reasoning_content (content empty) is
    still parsed via the reasoning_content fallback — the safety-net retry path."""
    def fake_post(url, json=None, timeout=None):
        return _FakeResp({"choices": [{"message": {
            "content": "",
            "reasoning_content": '<think>ok</think>\n[{"id":"b1","subject":"d","scene":"a"}]',
        }}]})

    monkeypatch.setattr(gb, "_lmstudio_ensure_model", lambda *a, **k: None)
    monkeypatch.setattr(gb, "resolve_default_model", lambda api_url: "google/gemma-4-26b-a4b-qat")
    monkeypatch.setattr("requests.post", fake_post)

    scenes = gb.decompose_story("story", num_panels=1)
    assert len(scenes) == 1 and scenes[0]["subject"] == "d"
