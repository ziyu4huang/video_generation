"""Shot prompt builder — structured shot language → generation prompt (5 layers).

Ported from OpenMontage's ``lib/shot_prompt_builder.py`` and adapted to the local
run.py image stack. This is the deterministic, pure-python half of OM's
``scene_plan → shot_prompt_builder → image`` flow (Step 3a of
next-goal-20260708-210000): a gemma planning call produces structured scenes; this
module turns each scene's structured ``shot_language`` into a natural-language
prompt optimized for the local T2I/I2I pipelines.

The 5-layer framework (professional cinematography prompting research):
  Layer 1: Camera     — lens, depth of field
  Layer 2: Movement   — shot size, camera movement
  Layer 3: Subject    — description + texture keywords
  Layer 4: Lighting   — lighting key, color temperature
  Layer 5: Style      — adapted from playbook/style context (NOT a verbatim prefix)

This replaces prepending a fixed prefix to every scene (which makes every scene
look identical). LOCAL ONLY: it emits a text prompt; the generation runs through
run.py (local MLX) — never a cloud GAI.
"""
from __future__ import annotations

from typing import Any

# ─── Enum → natural-language phrase maps ──────────────────────────────────────

_SHOT_SIZE_PHRASES = {
    "extreme_wide": "extreme wide shot showing vast environment",
    "wide": "wide shot capturing full scene",
    "medium_wide": "medium-wide shot framing subject with surroundings",
    "medium": "medium shot from waist up",
    "medium_close": "medium close-up from chest up",
    "close_up": "close-up focusing on face or detail",
    "extreme_close_up": "extreme close-up on fine detail",
    "over_shoulder": "over-the-shoulder perspective",
    "insert": "insert shot of specific detail",
    "establishing": "establishing shot setting the location",
}

_MOVEMENT_PHRASES = {
    "static": "locked-off static camera",
    "pan_left": "smooth pan to the left",
    "pan_right": "smooth pan to the right",
    "tilt_up": "gentle tilt upward",
    "tilt_down": "gentle tilt downward",
    "dolly_in": "slow dolly in toward subject",
    "dolly_out": "slow dolly out from subject",
    "tracking_left": "tracking shot moving left alongside subject",
    "tracking_right": "tracking shot moving right alongside subject",
    "crane_up": "crane shot rising upward",
    "crane_down": "crane shot descending",
    "handheld": "handheld camera with natural movement",
    "steadicam": "smooth steadicam following movement",
    "whip_pan": "fast whip pan",
    "orbital": "orbital camera circling subject",
    "zoom_in": "slow zoom in",
    "zoom_out": "slow zoom out",
    "rack_focus": "rack focus shift between foreground and background",
}

_LIGHTING_PHRASES = {
    "high_key": "bright high-key lighting, minimal shadows",
    "low_key": "dramatic low-key lighting with deep shadows",
    "natural": "natural ambient lighting",
    "golden_hour": "warm golden hour sunlight",
    "blue_hour": "cool blue hour twilight",
    "tungsten_warm": "warm tungsten interior lighting",
    "neon": "neon-lit with vibrant color spill",
    "silhouette": "backlit silhouette",
    "rim_lit": "rim lighting highlighting edges",
    "volumetric": "volumetric light with visible rays",
    "overcast_soft": "soft overcast diffused light",
}

_DOF_PHRASES = {
    "shallow": "shallow depth of field with bokeh",
    "medium": "medium depth of field",
    "deep": "deep focus with everything sharp",
}

_COLOR_TEMP_PHRASES = {
    "cool": "cool blue-toned color palette",
    "neutral": "neutral balanced colors",
    "warm": "warm amber-toned color palette",
    "mixed": "mixed color temperatures for contrast",
}


def _phrase(phrase_map: dict[str, str], key: Any, fallback: str | None = None) -> str:
    """Look up a phrase; fall back to the raw key (or ``fallback``) when unknown.

    Unknown keys pass through verbatim (rather than silently dropping) so a gemma
    plan using a value outside the enum still produces a usable prompt.
    """
    if key is None:
        return ""
    return phrase_map.get(str(key), fallback if fallback is not None else str(key))


def build_shot_prompt(
    scene: dict[str, Any],
    style_context: dict[str, Any] | None = None,
) -> str:
    """Convert a scene with structured ``shot_language`` into a generation prompt.

    Args:
        scene: Scene dict from the planner (keys: ``description``,
            ``texture_keywords``, ``shot_language`` with ``lens_mm``,
            ``depth_of_field``, ``shot_size``, ``camera_movement``,
            ``lighting_key``, ``color_temperature``).
        style_context: Optional playbook/style info with ``mood`` and
            ``visual_language.aesthetic`` (Layer 5). NOT a verbatim prefix.

    Returns:
        A natural-language prompt optimized for the local T2I/I2I pipelines.
    """
    sl = scene.get("shot_language", {}) or {}
    layers: list[str] = []

    # Layer 1: Camera — lens and depth of field
    camera_parts: list[str] = []
    if sl.get("lens_mm"):
        camera_parts.append(f"{sl['lens_mm']}mm lens")
    if sl.get("depth_of_field"):
        camera_parts.append(_phrase(_DOF_PHRASES, sl.get("depth_of_field")))
    if camera_parts:
        layers.append(", ".join(p for p in camera_parts if p))

    # Layer 2: Movement — shot size and camera movement
    movement_parts: list[str] = []
    if sl.get("shot_size"):
        movement_parts.append(_phrase(_SHOT_SIZE_PHRASES, sl.get("shot_size")))
    # "static" movement contributes nothing (a locked camera is the default feel).
    if sl.get("camera_movement") and sl["camera_movement"] != "static":
        movement_parts.append(_phrase(_MOVEMENT_PHRASES, sl.get("camera_movement")))
    if movement_parts:
        layers.append(", ".join(p for p in movement_parts if p))

    # Layer 3: Subject — the scene description + texture keywords
    description = scene.get("description", "") or ""
    texture = scene.get("texture_keywords", []) or []
    subject_parts = [description]
    if texture:
        subject_parts.append(", ".join(texture))
    subject = ". ".join(p for p in subject_parts if p)
    if subject:
        layers.append(subject)

    # Layer 4: Lighting — lighting key and color temperature
    lighting_parts: list[str] = []
    if sl.get("lighting_key"):
        lighting_parts.append(_phrase(_LIGHTING_PHRASES, sl.get("lighting_key")))
    if sl.get("color_temperature"):
        lighting_parts.append(_phrase(_COLOR_TEMP_PHRASES, sl.get("color_temperature")))
    if lighting_parts:
        layers.append(", ".join(p for p in lighting_parts if p))

    # Layer 5: Style — adapted from playbook (NOT a verbatim prefix)
    if style_context:
        mood = style_context.get("mood", "") or ""
        visual_lang = style_context.get("visual_language", {}) or {}
        style_hint = visual_lang.get("aesthetic", "") or mood
        if style_hint:
            layers.append(f"Style: {style_hint}")

    return ". ".join(l for l in layers if l)


def build_batch_prompts(
    scenes: list[dict[str, Any]],
    style_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build prompts for all VISUAL scenes in a scene plan.

    Skips ``transition`` scenes (non-visual). Returns a list of
    ``{scene_id, prompt, hero_moment}`` dicts — the per-shot input the batch
    image-gen flow consumes.
    """
    results: list[dict[str, Any]] = []
    for scene in scenes:
        if scene.get("type", "") == "transition":
            continue
        results.append({
            "scene_id": scene.get("id", "unknown"),
            "prompt": build_shot_prompt(scene, style_context),
            "hero_moment": scene.get("hero_moment", False),
        })
    return results
