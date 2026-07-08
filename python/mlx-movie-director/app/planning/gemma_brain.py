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

# Gemma-4-26b-a4b-qat is a THINKING model: it ignores `enable_thinking:false` and
# emits a large <think>/reasoning_content before the final JSON. For a 4-6 panel
# decomposition the reasoning alone is ~8-12k tokens, so a small budget truncates
# BEFORE the JSON lands (content empty, reasoning cut off). 14000 lets the reasoning
# complete (the JSON then appears in `content` AND/OR `reasoning_content` — the
# parser checks both). At ~20 tok/s this is a one-time ~8-10 min planning call per
# storyboard, consistent with the local-gemma brain constraint. The deterministic
# fallback catches a still-truncated response.
_MAX_TOKENS = 14000

# A NON-THINKING instruct model emits the JSON directly (no <think> preamble), so
# a 4-6 panel decomposition fits in a small budget and runs in seconds. Used when
# the caller pins a fast brain via --decompose-model (Step 1a of the hardening
# goal): a 7-12B instruct model lands <60s vs gemma-4-26b's 3-5min.
_NON_THINKING_MAX_TOKENS = 2048

# Model ids known to be thinking models (emit reasoning_content that eats the
# budget). A pinned --decompose-model NOT in this set gets the small non-thinking
# budget. Gemma-4 / Qwen3 (thinking variants) match here.
_THINKING_MODEL_HINTS = ("gemma-4", "gemma-3", "thinking", "qwen3", "reasoner")


def _is_thinking_model(model_id: str) -> bool:
    mid = (model_id or "").lower()
    return any(h in mid for h in _THINKING_MODEL_HINTS)


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
            Pin a FAST NON-THINKING instruct model here (Step 1a) to skip the 3-5min
            gemma reasoning pass — a 7-12B instruct lands <60s at the small budget.
        style_hint: Optional look/genre anchor baked into the prompt.
        timeout: Per-request timeout (thinking models can be slow on first call).

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

    # Step 1a hardening: try the SMALL budget first (a non-thinking instruct model
    # emits the JSON directly → fast path, <60s). If no JSON parses (the model is a
    # reasoning/thinking model whose chain-of-thought ate the small budget), retry
    # ONCE with the large budget so the reasoning completes and the JSON lands.
    # This makes --decompose-model robust on BOTH model families without guessing
    # thinking-ness from the name (ornith-1.0-35b reasons too, despite the id).
    pinned_nonthinking = model is not None and not _is_thinking_model(model)
    budgets = [_NON_THINKING_MAX_TOKENS, _MAX_TOKENS] if pinned_nonthinking else [_MAX_TOKENS]

    url = f"{api_url}/chat/completions"
    last_err: Exception | None = None
    for attempt, max_tokens in enumerate(budgets):
        payload = {
            "model": resolved,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.3,
            "stream": False,
        }
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

        # Thinking models: LM Studio returns reasoning in a separate
        # `reasoning_content` field (and the final answer may live ONLY there when
        # the token budget ran out mid-content). Try `content` first, then
        # `reasoning_content` — parse_decomposition strips <think>/preambles and
        # pulls the JSON array from whichever holds it.
        reasoning = message.get("reasoning_content") if isinstance(message, dict) else None
        try:
            scenes = parse_decomposition(content)
        except ValueError:
            if not reasoning:
                if attempt < len(budgets) - 1:
                    last_err = ValueError(
                        f"no JSON in content at budget {max_tokens}; retrying larger budget")
                    print(f"[storyboard] no JSON at budget {max_tokens} "
                          f"(thinking model?); retrying at {_MAX_TOKENS}.", file=sys.stderr)
                    continue
                raise
            scenes = parse_decomposition(reasoning)  # raises ValueError if still no array
        # Truncate / pad to exactly num_panels: trust the model's count but defend.
        if len(scenes) > num_panels:
            scenes = scenes[:num_panels]
        return scenes
    # All budgets exhausted without a parseable array.
    raise last_err or ValueError("decomposition produced no parseable JSON array")
