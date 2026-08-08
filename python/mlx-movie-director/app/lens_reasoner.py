"""Lens prompt reasoner — optional LLM-based prompt rewriting.

Mirrors microsoft/Lens ``lens/reasoner.py``: rewrites a user prompt into a
single, concrete, descriptive image prompt via an OpenAI-compatible chat
endpoint (the project's LM Studio by default).

OFF by default — the official reasoner is opt-in, and for prompts that are
already concise it adds little. Verify usefulness with
``scripts/test_lens_reasoner.py`` before wiring it into the CLI. (Spoiler from
that test: for the real Lens prompts in this project, truncation at the 512
token cap is minor, so a condensing reasoner rarely helps.)

Dependency-light: uses stdlib ``urllib`` for the HTTP call so it runs in the
mlx-movie-director venv without ``openai`` or ``requests``.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

# Verbatim from microsoft/Lens lens/reasoner.py — the reasoner's behavior IS
# this system prompt; do not paraphrase.
SYSTEM_PROMPT = """
You are a prompt rewriter for a text-to-image model.
Your task is to convert the user's input into a single, precise, descriptive image prompt suitable for a text-to-image model.
Follow these rules strictly:

1. The output must be a clear and accurate description of a single image scene, written in the style of a text-to-image prompt.
  - Do not include explanations, reasoning, commentary, or meta text.
  - Do not ask questions.
  - Do not output multiple options.
  - Do not use uncertain, speculative, or alternative wording such as "maybe", "possibly", "perhaps", "or", "might", or "could".

2. Preserve the user's intended scene faithfully.
  - Do not change the objects, entities, attributes, actions, relationships, or core setting explicitly described by the user.
  - You may add reasonable visual details only when they help make the image concrete and coherent.
  - Any added details must be consistent with the user's description and must not introduce new important objects or alter the meaning.

3. If the image contains many main subjects of the same kind, describe each subject in detail, including humans, animals, objects, and any other prominent elements.
  - For each subject, include its appearance, color, size, shape, material, pose, expression, and position if applicable in the scene.
  - Make sure every main subject is clearly distinguishable from the others, such as in a scene with "4 dogs," describing each dog separately.

4. The output must fully cover the scene implied by the user's input.
  - Include the main subjects, relevant attributes, actions, spatial relationships, environment, and visible details necessary to render the scene.
  - If the user input is already sufficiently detailed and already suitable for image generation, keep it unchanged or only make minimal edits for fluency and clarity.

5. Resolve content that requires simple inference into explicit visual results when the result is unambiguous and visually representable.
  - Example: if the user says "the answer to 2+2 is written on the blackboard", output should explicitly describe "the blackboard shows 2+2=4".
  - Use only direct, necessary inference that is clearly implied by the user input.
  - Do not invent hidden facts, backstory, or ambiguous details.

6. Language rule:
  - If the user input is not in English, output in the same language.
  - Otherwise, output in English.

7. Output format:
  - Output exactly one final rewritten prompt.
  - Do not use bullet points, numbering, JSON, XML, Markdown, or quotation marks unless they are part of the scene itself.

Your goal is to produce a prompt that is concrete, visual, faithful to the user intent, and directly usable as input to a text-to-image model.
""".strip()


# Cleaning regexes (verbatim from microsoft/Lens lens/reasoner.py).
THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
HARMONY_FINAL_RE = re.compile(
    r"<\|start\|>assistant(?:<\|channel\|>final)?<\|message\|>(.*?)(?:<\|return\|>|<\|end\|>|$)",
    re.DOTALL,
)
HARMONY_DIRECT_FINAL_RE = re.compile(
    r"<\|channel\|>final<\|message\|>(.*?)(?:<\|return\|>|<\|end\|>|$)",
    re.DOTALL,
)
PLAIN_HARMONY_FINAL_MARKER_RE = re.compile(r"assistant\s*final\s*", re.IGNORECASE)
PLAIN_HARMONY_DIRECT_FINAL_RE = re.compile(r"(?:^|\n)\s*final\s*", re.IGNORECASE)

_DEFAULT_API_URL = "http://localhost:1234/v1"
# Best text model in the project LM Studio (qwen3-vl-4b over-praises images; for
# TEXT prompt-rewriting gemma is the stronger instruction follower). Gemma-4
# reasoning variants emit <think> tokens before the answer, so max_tokens must
# leave room for BOTH reasoning and the final prompt. Default is the 12b variant
# (aligned with caption.py + the Bun VLM stack).
_DEFAULT_MODEL = "google/gemma-4-12b-qat"
_DEFAULT_MAX_TOKENS = 1024
_DEFAULT_TEMPERATURE = 0.7
_DEFAULT_TIMEOUT = 180.0


def _extract_plain_harmony_final(text: str) -> str | None:
    matches = list(PLAIN_HARMONY_FINAL_MARKER_RE.finditer(text))
    if matches:
        final_text = text[matches[-1].end():].strip()
        return final_text or None
    if text.lstrip().lower().startswith("analysis"):
        matches = list(PLAIN_HARMONY_DIRECT_FINAL_RE.finditer(text))
        if matches:
            final_text = text[matches[-1].end():].strip()
            return final_text or None
    return None


def clean_reasoner_output(text: str) -> str:
    """Strip reasoning, chat-template markers, fences, and wrapping quotes.

    Verbatim logic from microsoft/Lens (handles GPT-OSS Harmony markers and
    <think> blocks, in case the endpoint is pointed at gpt-oss; harmless for
    plain-instruction models like gemma).
    """
    text = text.strip()
    final_match = None
    for match in HARMONY_FINAL_RE.finditer(text):
        final_match = match
    if final_match is not None:
        text = final_match.group(1).strip()
    else:
        direct_final_match = None
        for match in HARMONY_DIRECT_FINAL_RE.finditer(text):
            direct_final_match = match
        if direct_final_match is not None:
            text = direct_final_match.group(1).strip()
        else:
            plain_final = _extract_plain_harmony_final(text)
            if plain_final is not None:
                text = plain_final

    text = THINK_BLOCK_RE.sub("", text).strip()
    if "</think>" in text.lower():
        text = re.split(r"</think>", text, flags=re.IGNORECASE)[-1].strip()
    plain_final = _extract_plain_harmony_final(text)
    if plain_final is not None:
        text = plain_final
    for token in (
        "<|channel|>analysis<|message|>",
        "<|start|>assistant<|channel|>analysis<|message|>",
        "<|channel|>final<|message|>",
        "<|start|>assistant<|channel|>final<|message|>",
        "<|start|>assistant<|message|>",
        "<|return|>",
        "<|end|>",
        "<|endoftext|>",
        "<|im_end|>",
    ):
        text = text.replace(token, "")

    text = text.strip()
    if re.match(r"^(?:analysis|assistant\s*analysis)(?:\b|[A-Z])", text, flags=re.IGNORECASE | re.DOTALL):
        return ""
    if text.startswith("```") and text.endswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            text = "\n".join(lines[1:-1]).strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].strip()
    return " ".join(text.split())


def _chat_completion(
    api_url: str,
    api_key: str | None,
    model: str,
    user_prompt: str,
    max_tokens: int,
    temperature: float,
    timeout: float,
) -> tuple[str | None, str | None]:
    """POST to an OpenAI-compatible /chat/completions. Returns (text, error)."""
    url = api_url.rstrip("/") + "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
        # gemma-4-26b is a reasoning model: without this it burns the whole
        # token budget on <think> and never emits the answer. "none" makes it
        # answer directly (0 reasoning tokens). Harmless for non-thinking models.
        "reasoning_effort": "none",
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
    except urllib.error.URLError as exc:
        return None, f"connection failed: {exc.reason}"
    except Exception as exc:  # noqa: BLE001 — never raise to the caller
        return None, f"{type(exc).__name__}: {exc}"
    try:
        choices = data.get("choices") or []
        if not choices:
            return None, f"no choices in response: {str(data)[:200]}"
        ch0 = choices[0]
        text = (ch0.get("message", {}) or {}).get("content") or ""
        finish = ch0.get("finish_reason")
        usage = data.get("usage") or {}
        reason_tok = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
        # Reasoning models (gemma-4-26b) can spend the whole budget on <think>
        # and never emit the answer. Surface that distinctly.
        if not text.strip():
            if finish == "length":
                return None, (f"model spent all {max_tokens} tokens on reasoning "
                              f"({reason_tok} reasoning tok) and emitted no answer — "
                              f"raise --max-tokens")
            return None, f"empty content (finish={finish})"
        return text, None
    except Exception as exc:  # noqa: BLE001
        return None, f"parse error: {exc}"


def refine(
    prompts: list[str],
    *,
    api_url: str = _DEFAULT_API_URL,
    api_key: str | None = None,
    model: str = _DEFAULT_MODEL,
    max_tokens: int = _DEFAULT_MAX_TOKENS,
    temperature: float = _DEFAULT_TEMPERATURE,
    timeout: float = _DEFAULT_TIMEOUT,
) -> list[tuple[str, str | None]]:
    """Refine each prompt via the OpenAI-compatible endpoint.

    Returns a list of ``(refined_text, error)`` tuples, one per input prompt.
    On any failure (endpoint down, parse error) ``refined_text`` is the ORIGINAL
    prompt and ``error`` describes the problem. Never raises.
    """
    out: list[tuple[str, str | None]] = []
    for prompt in prompts:
        raw, err = _chat_completion(
            api_url, api_key, model, prompt, max_tokens, temperature, timeout,
        )
        if err is not None:
            out.append((prompt, err))
            continue
        cleaned = clean_reasoner_output(raw)
        out.append((cleaned or prompt, None if cleaned else "empty-after-clean"))
    return out
