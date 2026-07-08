"""decompose_prompt — the gemma story→scene decomposition prompt builder.

The "brain" half of the storyline path (Step 1a of next-goal-20260708-220000).
A pure function that builds the prompt sent to the local gemma brain (LM Studio)
to decompose a free-form story into a strict ``SceneSpec[]`` JSON list — the
Story2Board shape (arXiv 2508.09983): narrative text → N panels with consistent
character identity across panels and diverse layout/camera.

This is the LLM planning layer over T2I (constraint 2: brain = local gemma, never
a cloud LLM). The deterministic backbone (``scene_spec.plan_storyboard``) consumes
the gemma-produced scenes; this module only BUILDS the prompt — no IO, fully
pytest-able. The actual brain call lives in ``gemma_brain.decompose_story``.

The prompt embeds OM's 5-aspect self-review (Subject / Subject Motion / Scene /
Spatial Framing / Camera — ``cinematic/asset-director.md:106``, the CHAI critique
loop) as an in-prompt quality gate, and the exact JSON schema so gemma returns
parseable output on the first try.
"""
from __future__ import annotations

from typing import Any

# The JSON schema spelled out in the prompt so the model returns parseable output.
# Mirrors SceneSpec/ShotLanguage (app/planning/scene_spec.py). Unknown enum values
# pass through verbatim downstream (shot_prompt_builder._phrase), so the model is
# NOT constrained to the example vocabulary.
_SCENE_SPEC_SCHEMA = """[
  {
    "id": "beat-1",
    "subject": "WHO/WHAT is in frame (the character/object in focus)",
    "scene": "WHERE — the setting, environment, time of day",
    "motion": "WHAT is happening — the action/beat of this panel",
    "framing": "composition note, e.g. 'subject left, lead-room right' (optional)",
    "character_id": "a stable id for any recurring character (null if none)",
    "hero_moment": false,
    "texture_keywords": ["concrete visual texture words", "e.g. wet pavement, neon"],
    "shot_language": {
      "shot_size": "extreme_wide|wide|medium_wide|medium|medium_close|close_up|extreme_close_up|over_shoulder|establishing",
      "camera_movement": "static|dolly_in|dolly_out|pan_left|pan_right|tilt_up|tilt_down|tracking_left|tracking_right|crane_up|crane_down|handheld|steadicam|orbital|zoom_in|zoom_out|rack_focus",
      "lens_mm": 35,
      "depth_of_field": "shallow|medium|deep",
      "lighting_key": "high_key|low_key|natural|golden_hour|blue_hour|tungsten_warm|neon|silhouette|rim_lit|volumetric|overcast_soft",
      "color_temperature": "cool|neutral|warm|mixed"
    }
  }
]"""

# OM's 5-aspect self-review (the CHAI critique loop), condensed into the prompt as
# an in-prompt quality gate so the model self-critiques BEFORE emitting JSON.
_5ASPECT_GATE = """Before emitting JSON, silently self-review each planned panel against the \
5-aspect checklist (Subject / Subject Motion / Scene / Spatial Framing / Camera). \
For each aspect: is it concrete and filmable? For multi-panel stories with a \
recurring character: is the character's identity anchored verbatim across panels \
(same person, same key visual attributes), even as scene/camera/framing vary? \
DIVERSITY requirement: vary shot_size, camera_movement, and lens across panels — \
do NOT repeat the same framing. Revise silently, then emit."""


def build_decompose_prompt(
    story: str,
    num_panels: int = 4,
    style_hint: str | None = None,
) -> str:
    """Build the gemma decomposition prompt (system + user, as one string).

    Args:
        story: The free-form story text to decompose.
        num_panels: How many storyboard panels to plan (default 4).
        style_hint: Optional look/genre anchor appended to each panel's feel
            (e.g. "noir, 35mm film grain, teal-and-orange grade").

    Returns:
        The full prompt string to send to the local gemma brain.
    """
    style_line = f"\nStyle/palette anchor (apply to every panel): {style_hint}" if style_hint else ""
    return f"""You are a film storyboard director. Decompose the story into exactly {num_panels} \
sequential storyboard panels. Each panel is one image to generate.{style_line}

Rules:
- Cover the story's narrative arc across the {num_panels} panels (beginning → middle → end).
- When a character appears in more than one panel, give them ONE stable "character_id" \
and keep their identity anchored verbatim across panels (same person, same key visual \
attributes) — only the scene/camera/action changes.
- Vary the cinematography across panels: mix shot sizes, camera movements, lenses, and \
lighting. Avoid repeating the same framing.
- "subject" is concrete and visual (not abstract). "texture_keywords" are real surface \
details the image model can render.
- {num_panels} panels EXACTLY.

{_5ASPECT_GATE}

Return ONLY a JSON array (no prose, no markdown fences) of {num_panels} objects, \
each matching this shape (omit a field rather than invent values; null is allowed for \
character_id/framing when not applicable):

{_SCENE_SPEC_SCHEMA}

Story:
\"\"\"{story}\"\"\"

JSON array:"""


def parse_decomposition(raw: str) -> list[dict[str, Any]]:
    """Extract the ``SceneSpec[]`` JSON array from a gemma response.

    Strips ``<think>…</think>`` reasoning blocks, tolerates ```json fences, and
    pulls the first ``[ … ]`` array. Raises ``ValueError`` when no parseable array
    is found (the caller falls back to the deterministic fixture). Pure — no IO.
    """
    import json
    import re

    # Strip Gemma-4 / Qwen3 <think> reasoning blocks.
    cleaned = re.sub(r"<think.*?</think\s*>", "", raw, flags=re.DOTALL).strip()
    # If the answer was inside the <think> block, recover its inner text.
    if not cleaned and "<think" in raw:
        cleaned = re.sub(r"</?think\s*>", "", raw, flags=re.DOTALL).strip()
    # Strip ```json … ``` fences if the model wrapped the array.
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)

    # Fast path: the whole thing is the array.
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    # Fallback: pull the first [...] span (greedy-enough for a single array).
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start != -1 and end != -1 and end > start:
        snippet = cleaned[start:end + 1]
        try:
            parsed = json.loads(snippet)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass

    raise ValueError(
        f"decomposition response had no parseable JSON array (first 200 chars: "
        f"{cleaned[:200]!r})"
    )
