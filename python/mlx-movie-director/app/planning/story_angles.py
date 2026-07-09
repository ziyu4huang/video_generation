"""story_angles — the gemma storyline ANGLES + PROPOSAL prompt builders.

The planning layer for ``run.py story`` (Step 1 of next-goal-20260709-050000).
OM opens every image-heavy pipeline with research → proposal → approval; MLX
previously only decomposed a *given* prompt (``image storyboard``). This module
fills the upstream gap: from a bare TOPIC, the local gemma brain emits
differentiated creative ANGLES and an OM-shaped PROPOSAL_PACKET (concept options
for a human/agent approval gate), and ``story shots`` then hands the approved
concept to the existing storyboard decompose→generate path.

Pure functions only — no IO, fully pytest-able. The actual gemma call reuses
``gemma_brain`` (the ``reasoning_effort:"none"`` fast path, ~9s on
gemma-4-26b — see [[lmstudio-reasoning-effort-none-gemma-knob]]). LOCAL ONLY:
brain = local gemma on LM Studio, never a cloud LLM (constraint 2).

Inspiration: Story2Board (arXiv 2508.09983) — a training-free LLM decomposes a
topic into a reference/character prompt + per-scene prompts. Here we add the
PRE-decomposition step (angles → proposal) OM's research stage demands.

Public API:
  build_angles_prompt(topic, count)   — angles-generation prompt (pytest target)
  parse_angles(raw)                   — extract Angle[] JSON from a gemma reply
  build_propose_prompt(topic, count)  — proposal-packet prompt (pytest target)
  parse_proposal(raw)                 — extract ProposalPacket from a gemma reply
  proposal_to_yaml(packet)            — serialize a proposal_packet to YAML
  concept_to_story(concept)           — fold a concept's scene_list → storyboard --story
"""
from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# ANGLES — N differentiated creative angles from a topic
# ---------------------------------------------------------------------------

_ANGLES_SCHEMA = """[
  {
    "angle": "the creative angle / hook (a short noun phrase)",
    "logline": "one-sentence synopsis of the story this angle produces",
    "tone": "emotional tone, e.g. 'whimsical', 'tense', 'melancholic'",
    "why_different": "one phrase on how this angle differs from the others",
    "target_audience": "who this resonates with (short)"
  }
]"""


def build_angles_prompt(topic: str, count: int = 3) -> str:
    """Build the gemma angles-generation prompt for a topic.

    Args:
      topic:  the subject/theme to brainstorm angles for.
      count:  how many DIFFERENTIATED angles to emit (default 3).

    Returns: the full prompt string. The model is told to emit exactly ``count``
    MAXIMALLY differentiated angles (different tone/audience/hook each), as a
    JSON array matching ``_ANGLES_SCHEMA``.
    """
    n = max(1, int(count))
    return f"""You are a creative director brainstorming story CONCEPTS. Given a topic, \
generate exactly {n} DISTINCT creative angles for a short visual story (a storyboard \
of a few images). The angles must be MAXIMALLY differentiated — different tone, \
audience, hook, and emotional register. Do NOT produce variations of the same idea.

Rules:
- Exactly {n} angles. Each is a genuinely different take on the topic.
- "angle" is a concrete creative hook (not a restatement of the topic).
- "logline" is one sentence — the actual story this angle would tell.
- Each angle must be filmable as a short sequence of images.

Return ONLY a JSON array (no prose, no markdown fences) of exactly {n} objects, \
each matching this shape:

{_ANGLES_SCHEMA}

Topic:
\"\"\"{topic}\"\"\"

JSON array:"""


def parse_angles(raw: str) -> list[dict[str, Any]]:
    """Extract the ``Angle[]`` JSON array from a gemma response.

    Tolerates ``<think>`` blocks + ```json fences; pulls the first ``[ … ]``.
    Raises ``Value``Error`` when no parseable array is found. Pure — no IO.
    Mirrors ``decompose_prompt.parse_decomposition``.
    """
    import json
    import re

    cleaned = re.sub(r"<think.*?</think\s*>", "", raw, flags=re.DOTALL).strip()
    if not cleaned and "<think" in raw:
        cleaned = re.sub(r"</?think\s*>", "", raw, flags=re.DOTALL).strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start:end + 1])
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass

    raise ValueError(
        f"angles response had no parseable JSON array (first 200 chars: "
        f"{cleaned[:200]!r})"
    )


# ---------------------------------------------------------------------------
# PROPOSAL — an OM-shaped proposal_packet (concept options)
# ---------------------------------------------------------------------------

# The proposal_packet: a list of CONCEPT OPTIONS, each a self-contained pitch a
# human/agent can approve. This is the OM "proposal" stage output shape
# (concept options + est_shot_count for the approval gate). `story shots` later
# folds the approved concept's scene_list into a storyboard.
_PROPOSAL_SCHEMA = """[
  {
    "title": "a short evocative title",
    "angle": "the creative angle this concept pursues",
    "logline": "one-sentence story synopsis",
    "scene_list": ["beat 1 — one concrete filmable moment", "beat 2 — ...", "beat 3 — ..."],
    "visual_language": "the look: palette, lighting, film stock / illustration style",
    "est_shot_count": 4,
    "estimated_cost": "low|medium|high (relative render budget)"
  }
]"""


def build_propose_prompt(topic: str, count: int = 2) -> str:
    """Build the gemma proposal-packet prompt for a topic.

    Each concept option is a full pitch (title, angle, scene_list of concrete
    filmable beats, visual_language, est_shot_count, cost) — the OM approval-gate
    shape. ``count`` concept options are emitted so a human/agent can pick.

    Args:
      topic:  the subject/theme.
      count:  how many concept options to propose (default 2).

    Returns: the full prompt string.
    """
    n = max(1, int(count))
    return f"""You are a creative director producing a STORY PROPOSAL. Given a topic, \
propose exactly {n} distinct CONCEPT OPTIONS for a short visual story (a storyboard). \
Each concept is a complete, approval-ready pitch with a concrete scene_list of \
filmable beats and a defined visual language.

Rules:
- Exactly {n} concept options, each a genuinely different approach.
- "scene_list" is {3}-6 concrete, filmable beats (one image each) covering a \
beginning → middle → end arc.
- "visual_language" is a concrete look the image model can render (palette + \
lighting + style).
- "est_shot_count" equals the number of beats in scene_list.
- "estimated_cost" reflects relative render budget (more shots + higher detail = higher).

Return ONLY a JSON array (no prose, no markdown fences) of exactly {n} objects, \
each matching this shape:

{_PROPOSAL_SCHEMA}

Topic:
\"\"\"{topic}\"\"\"

JSON array:"""


def parse_proposal(raw: str) -> list[dict[str, Any]]:
    """Extract the proposal_packet (concept options list) from a gemma reply.

    Same tolerance/parse discipline as ``parse_angles``. Raises ``ValueError``
    when no parseable array is found.
    """
    import json
    import re

    cleaned = re.sub(r"<think.*?</think\s*>", "", raw, flags=re.DOTALL).strip()
    if not cleaned and "<think" in raw:
        cleaned = re.sub(r"</?think\s*>", "", raw, flags=re.DOTALL).strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start:end + 1])
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass

    raise ValueError(
        f"proposal response had no parseable JSON array (first 200 chars: "
        f"{cleaned[:200]!r})"
    )


# ---------------------------------------------------------------------------
# Serialization + storyboard handoff (pure)
# ---------------------------------------------------------------------------

def proposal_to_yaml(packet: list[dict[str, Any]] | dict[str, Any]) -> str:
    """Serialize a proposal_packet (concept list or single concept) to YAML.

    Uses PyYAML if available (flowstyle off for readability); falls back to a
    deterministic JSON-as-YAML dump (YAML is a JSON superset) so the output is
    always valid YAML even without PyYAML. Pure — no IO.
    """
    import json

    data = packet if isinstance(packet, list) else [packet]
    try:
        import yaml  # type: ignore[import-untyped]
        return yaml.safe_dump(data, sort_keys=False, allow_unicode=True,
                              default_flow_style=False)
    except ImportError:
        return json.dumps(data, indent=2, ensure_ascii=False)


def concept_to_story(concept: dict[str, Any]) -> tuple[str, str, int]:
    """Fold an approved concept into the inputs ``image storyboard`` needs.

    Returns ``(story, style_hint, num_panels)``:
      - story: a narrative string built from title + logline + the scene beats
        (the gemma decompose brain re-plans this into SceneSpec panels).
      - style_hint: the concept's visual_language (palette/lighting anchor).
      - num_panels: the concept's est_shot_count (or len(scene_list)).

    Pure — no IO. Used by ``story shots`` to hand off to the existing storyboard.
    """
    title = str(concept.get("title", "")).strip()
    logline = str(concept.get("logline", "")).strip()
    beats = concept.get("scene_list") or []
    if not isinstance(beats, list):
        beats = [str(beats)]
    beats = [str(b).strip() for b in beats if str(b).strip()]

    parts: list[str] = []
    if title:
        parts.append(f"Title: {title}")
    if logline:
        parts.append(f"Logline: {logline}")
    if beats:
        parts.append("Story beats:")
        for i, b in enumerate(beats, 1):
            parts.append(f"  {i}. {b}")
    story = "\n".join(parts)

    style_hint = str(concept.get("visual_language", "") or "").strip()
    try:
        num_panels = int(concept.get("est_shot_count") or len(beats) or 4)
    except (TypeError, ValueError):
        num_panels = len(beats) or 4
    num_panels = max(1, num_panels)
    return story, style_hint, num_panels
