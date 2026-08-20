"""playbook — read/emit the OM style playbook + surface it to the planner.

Step 4 of next-goal-20260708-230000 (the OM ``lib/`` intelligence layer, pure-
python). OpenMontage's style playbook YAML carries the art-direction the planner
must consume: ``asset_generation.image_prompt_prefix`` /
``image_negative_prompt`` / ``consistency_anchors``, the ``color_palette``, and
``motion.pacing_rules``. This module parses that shape into a typed
:class:`Playbook`, then exposes two consumers the local pipeline already speaks:

1. ``playbook_to_style_context`` → the Layer-5 ``{mood, visual_language}`` dict
   that :func:`app.planning.shot_prompt_builder.build_shot_prompt` already reads
   (so ``plan_storyboard(scenes, style_context=...)`` lights up Layer 5 with zero
   new code).
2. ``style_anchor`` → a compact string (the anchors + palette) appended as the
   character-lock's ``styleAnchor`` (Step 2's IdentitySpec) so recurring
   characters inherit the playbook's visual identity verbatim.

LOCAL ONLY: this is pure data parsing — no generation, no LLM, no cloud. The
generation runs through run.py (constraint 1). The playbook is art direction
authored up-front (constraint 2 does not apply — it is not a generation brain).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ─── Pacing defaults (when a playbook omits motion.pacing_rules) ──────────────
# Mirrors OM's clean-professional.yaml baseline so a minimal playbook still gates.
DEFAULT_PACING = {
    "min_scene_hold_seconds": 2.0,
    "max_scene_hold_seconds": 12.0,
    "text_card_hold_seconds": 3.0,
    "transition_duration_seconds": 0.4,
}


@dataclass
class PacingRules:
    """The pacing envelope one scene must fit inside (OM motion.pacing_rules)."""
    min_scene_hold_seconds: float = DEFAULT_PACING["min_scene_hold_seconds"]
    max_scene_hold_seconds: float = DEFAULT_PACING["max_scene_hold_seconds"]
    text_card_hold_seconds: float = DEFAULT_PACING["text_card_hold_seconds"]
    transition_duration_seconds: float = DEFAULT_PACING["transition_duration_seconds"]


@dataclass
class Playbook:
    """The parsed OM style playbook — art direction for the planner + character-lock.

    Fields mirror the OM playbook YAML shape (see
    ``bun-apps/s2-agent-ext-movie-director/data/styles/clean-professional.yaml``).
    Unknown playbooks fall back to neutral defaults so a partial playbook still
    drives the pipeline (never hard-fail on a missing key).
    """
    name: str = ""
    mood: str = ""
    aesthetic: str = ""                # visual_language one-liner for Layer 5
    image_prompt_prefix: str = ""      # prepended verbatim (asset_generation)
    image_negative_prompt: str = ""    # the per-shot negative prompt
    consistency_anchors: list[str] = field(default_factory=list)
    palette: list[str] = field(default_factory=list)   # hex strings
    pacing: PacingRules = field(default_factory=PacingRules)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Playbook":
        """Parse a playbook YAML dict (OM shape) into a typed Playbook.

        Tolerates a partial/unknown playbook: missing sections degrade to neutral
        defaults rather than raising. The caller (the planner) treats an empty
        Playbook as "no art direction" (Layer 5 omitted, no anchors).
        """
        identity = data.get("identity", {}) or {}
        visual = data.get("visual_language", {}) or {}
        asset = data.get("asset_generation", {}) or {}
        motion = data.get("motion", {}) or {}
        pacing_raw = motion.get("pacing_rules", {}) or {}

        # color_palette: collect every hex string under visual_language.color_palette.
        palette: list[str] = []
        cp = visual.get("color_palette", {}) or {}
        if isinstance(cp, dict):
            for v in cp.values():
                if isinstance(v, str):
                    palette.append(v)
                elif isinstance(v, list):
                    palette.extend(c for c in v if isinstance(c, str))
        elif isinstance(cp, list):
            palette = [c for c in cp if isinstance(c, str)]

        aesthetic = visual.get("composition") or visual.get("texture") or ""
        pacing = PacingRules(
            min_scene_hold_seconds=float(pacing_raw.get(
                "min_scene_hold_seconds", DEFAULT_PACING["min_scene_hold_seconds"])),
            max_scene_hold_seconds=float(pacing_raw.get(
                "max_scene_hold_seconds", DEFAULT_PACING["max_scene_hold_seconds"])),
            text_card_hold_seconds=float(pacing_raw.get(
                "text_card_hold_seconds", DEFAULT_PACING["text_card_hold_seconds"])),
            transition_duration_seconds=float(pacing_raw.get(
                "transition_duration_seconds", DEFAULT_PACING["transition_duration_seconds"])),
        )
        return cls(
            name=str(identity.get("name", "")),
            mood=str(identity.get("mood", "")),
            aesthetic=str(aesthetic),
            image_prompt_prefix=str(asset.get("image_prompt_prefix", "")),
            image_negative_prompt=str(asset.get("image_negative_prompt", "")),
            consistency_anchors=[str(a) for a in (asset.get("consistency_anchors") or [])],
            palette=palette,
            pacing=pacing,
        )


def load_playbook(path: str) -> Playbook:
    """Load a playbook YAML file from disk.

    Uses ``yaml.safe_load`` (PyYAML is already a run.py dep via config). Raises
    ``FileNotFoundError`` if absent — a playbook is an explicit input, so a
    missing file is a real error (unlike an unknown KEY inside one).
    """
    import yaml

    with open(path, "r") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"playbook YAML must be a mapping, got {type(data).__name__}: {path}")
    return Playbook.from_dict(data)


def playbook_to_style_context(playbook: Playbook) -> dict[str, Any]:
    """Project a Playbook into the Layer-5 style_context the prompt builder reads.

    ``build_shot_prompt`` reads ``style_context.mood`` and
    ``style_context.visual_language.aesthetic``. A playbook with no aesthetic
    yields an empty dict (Layer 5 omitted — the prompt builder handles None).
    """
    aesthetic = playbook.aesthetic or playbook.mood
    if not aesthetic:
        return {}
    return {
        "mood": playbook.mood,
        "visual_language": {"aesthetic": aesthetic},
    }


def style_anchor(playbook: Playbook) -> str:
    """A compact style-anchor string for the character-lock's ``styleAnchor``.

    Joins the playbook's ``consistency_anchors`` + the palette hexes so a
    recurring character inherits the playbook's visual identity verbatim across
    shots (Step 2 IdentitySpec.styleAnchor). Empty when the playbook carries no
    anchors/palette (the lock then uses the prompt's own style).
    """
    parts: list[str] = list(playbook.consistency_anchors)
    if playbook.palette:
        parts.append("palette: " + ", ".join(playbook.palette))
    return "; ".join(p for p in parts if p)
