"""gemma_brain — the local gemma brain call for storyline decomposition.

The IO half of Step 1b (next-goal-20260708-220000). ``decompose_story`` sends the
``decompose_prompt`` to the local gemma brain (LM Studio, OpenAI-compatible) as a
TEXT-ONLY chat completion (no image — decomposition is a pure text→JSON task), then
parses the strict ``SceneSpec[]`` JSON.

LOCAL ONLY (constraint 2: brain = local gemma on LM Studio localhost:1234, never a
cloud LLM). Reuses ``caption.resolve_default_model`` (the gemma brain resolver —
preferred loaded variant, else auto-load gemma-4-26b) and ``caption._lmstudio_ensure_model``
so the model is loaded before the request. Generation itself stays on run.py
(constraint 1); this module only does the LLM planning call.

Fast path (Step 1a, next-goal-20260709-000000 — VERIFIED by direct measurement):
``reasoning_effort:"none"`` is the OpenAI-style knob LM Studio HONORS to suppress
gemma-4-26b's thinking (NOT ``enable_thinking``/``thinking``/``chat_template_kwargs``,
which leave ``reasoning_content`` populated). With reasoning off, gemma emits the
JSON directly in ``content`` (``reasoning_content`` stays empty) and a 4-panel
decomposition lands in **~9s** at the small budget — vs the 3-5min thinking pass.
So gemma-4-26b IS the fast non-thinking brain we already have; the only model that
needs loading is the one already loaded. This retires the PR-#368 "no fast brain
loaded" honest-negative, which was a self-inflicted artifact of the wrong param.
"""
from __future__ import annotations

import sys
from typing import Any

from app.commands.caption import (
    _DEFAULT_API_URL,
    _lmstudio_ensure_model,
    resolve_default_model,
)
from app.planning.decompose_prompt import build_decompose_prompt, parse_decomposition

# The fast-path budget: with ``reasoning_effort:"none"`` suppressing thinking, the
# JSON lands directly in ``content`` and a 4-6 panel decomposition fits comfortably
# (~9s measured on gemma-4-26b). This is the DEFAULT budget for every brain now.
_NON_THINKING_MAX_TOKENS = 2048

# A DEFENSIVE safety-net budget for a brain that ignores ``reasoning_effort:"none"``
# and reasons anyway (e.g. some community quants). Then the reasoning must complete
# before the JSON appears, so a small budget truncates it. We retry ONCE at this
# budget WITHOUT reasoning_effort:none so a reasoning model can finish its chain.
# This is NOT thinking-ness name-guessing (the prior, wrong abstraction) — it is a
# single parse-driven retry triggered only when the fast path produced no JSON.
_MAX_TOKENS = 14000


def decompose_story(
    story: str,
    num_panels: int = 4,
    api_url: str = _DEFAULT_API_URL,
    model: str | None = None,
    style_hint: str | None = None,
    timeout: int = 600,
) -> list[dict[str, Any]]:
    """Decompose a story into a ``SceneSpec[]``-shaped dict list via local gemma.

    Args:
        story: Free-form story text.
        num_panels: Number of storyboard panels to plan.
        api_url: LM Studio OpenAI-compatible base URL (default localhost:1234/v1).
        model: Explicit model id; None → ``resolve_default_model`` (the gemma brain).
            The fast path (``reasoning_effort:"none"``) is the default for ANY model,
            including gemma-4-26b; pin only to target a different loaded brain.
        style_hint: Optional look/genre anchor baked into the prompt.
        timeout: Per-request timeout (a reasoning-model retry can be slow).

    Returns:
        A list of dicts matching the SceneSpec JSON shape.

    Raises:
        RuntimeError: if the brain is unreachable / returns no usable content.
        ValueError: if the response has no parseable JSON array.
    """
    import requests

    resolved = model or resolve_default_model(api_url)
    prompt = build_decompose_prompt(story, num_panels=num_panels, style_hint=style_hint)

    # Ensure the brain is loaded (same path run.py caption uses). Best-effort:
    # if the ensure call fails, the request below surfaces the real error.
    try:
        _lmstudio_ensure_model(api_url, resolved)
    except Exception as e:  # noqa: BLE001 — ensure is best-effort; the request is the source of truth
        print(f"[storyboard] model-ensure warning ({type(e).__name__}: {e}); trying anyway.",
              file=sys.stderr)

    # Fast path first, safety net second. (attempt, max_tokens, reasoning_effort):
    #   0: small budget + reasoning_effort:"none"  — the ~9s fast path on gemma.
    #   1: large budget, NO reasoning_effort:none  — lets a reasoning model finish
    #      its chain if the fast path produced no parseable JSON.
    # No name-guessing: the retry fires only when the fast path's content+reasoning
    # both lack a JSON array.
    attempts = [
        (_NON_THINKING_MAX_TOKENS, "none"),
        (_MAX_TOKENS, None),
    ]

    url = f"{api_url}/chat/completions"
    last_err: Exception | None = None
    for attempt, (max_tokens, reasoning_effort) in enumerate(attempts):
        payload = {
            "model": resolved,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.3,
            "stream": False,
        }
        if reasoning_effort is not None:
            payload["reasoning_effort"] = reasoning_effort
        resp = requests.post(url, json=payload, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()

        try:
            message = data["choices"][0]["message"]
            content = message.get("content") or ""
        except (KeyError, IndexError, TypeError) as e:
            raise RuntimeError(
                f"gemma decomposition: response missing OpenAI chat-completion shape "
                f"({type(e).__name__}: {e}); raw excerpt: {str(data)[:300]}"
            ) from e

        # With reasoning_effort:none, reasoning_content is empty and the JSON is in
        # `content`. A reasoning model whose chain ate the small budget may still
        # surface the JSON in `reasoning_content` — parse_decomposition strips
        # <think>/preambles and pulls the JSON array from whichever holds it.
        reasoning = message.get("reasoning_content") if isinstance(message, dict) else None
        try:
            scenes = parse_decomposition(content)
        except ValueError:
            if not reasoning:
                if attempt < len(attempts) - 1:
                    last_err = ValueError(
                        f"no JSON in content at budget {max_tokens}; retrying larger budget")
                    print(f"[storyboard] no JSON at budget {max_tokens} "
                          f"(model ignored reasoning_effort:none?); retrying at {_MAX_TOKENS}.",
                          file=sys.stderr)
                    continue
                raise
            scenes = parse_decomposition(reasoning)  # raises ValueError if still no array
        # Truncate / pad to exactly num_panels: trust the model's count but defend.
        if len(scenes) > num_panels:
            scenes = scenes[:num_panels]
        return scenes
    # All budgets exhausted without a parseable array.
    raise last_err or ValueError("decomposition produced no parseable JSON array")
