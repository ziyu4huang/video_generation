"""Scene spec + storyboard planner — the deterministic backbone for the storyline path.

OpenMontage's scene-director emits a 5-aspect spec per scene
(Subject/Motion/Scene/Framing/Camera) and a planner turns a story into a shot
list. This module is the LOCAL, deterministic half (Step 3a of
next-goal-20260708-210000): pure data structures + a planner that maps a gemma-
produced scene list onto per-shot generation specs. The gemma brain does the
story→scene DECOMPOSITION (constraint 2: never a cloud LLM); this module does the
deterministic scene→shot MAPPING — no generation, fully pytest-able.

Each shot carries an optional ``character_id``: when the same character recurs
across shots, the batch driver applies the character-lock
(``app.planning`` ↔ the TS ``character_lock.ts`` IdentitySpec) so identity holds
across the storyboard (Step 2 mechanism).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class ShotLanguage:
    """Structured cinematography language for one shot (the 5-layer prompt input).

    Consumed by :func:`app.planning.shot_prompt_builder.build_shot_prompt`. Fields
    mirror OM's shot_language enum set; unknown values pass through verbatim.
    """
    lens_mm: int | None = None
    depth_of_field: str | None = None        # shallow | medium | deep
    shot_size: str | None = None             # extreme_wide | wide | medium | close_up | ...
    camera_movement: str | None = None       # static | dolly_in | pan_left | orbital | ...
    lighting_key: str | None = None          # high_key | low_key | golden_hour | neon | ...
    color_temperature: str | None = None     # cool | neutral | warm | mixed

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SceneSpec:
    """The 5-aspect scene spec (OM scene-director shape), one per storyboard beat.

    Aspects: Subject / Motion / Scene / Framing / Camera. ``shot_language`` is the
    Camera+Framing layer refined into structured prompt input.
    """
    id: str
    subject: str                             # WHO/WHAT is in frame (Layer 3 core)
    scene: str                               # WHERE (setting, environment)
    motion: str = ""                         # WHAT is happening (action/beat)
    framing: str = ""                        # composition note (e.g. "subject left, lead room right")
    shot_language: ShotLanguage = field(default_factory=ShotLanguage)
    texture_keywords: list[str] = field(default_factory=list)
    # When set, this shot features a recurring character → the batch driver locks identity.
    character_id: str | None = None
    hero_moment: bool = False
    # transition scenes are skipped by build_batch_prompts (non-visual).
    type: str = "visual"

    def to_planner_scene(self) -> dict[str, Any]:
        """Flatten to the dict shape ``build_shot_prompt`` expects."""
        description = ". ".join(p for p in (self.subject, self.motion, self.scene) if p)
        return {
            "id": self.id,
            "type": self.type,
            "description": description,
            "texture_keywords": list(self.texture_keywords),
            "shot_language": self.shot_language.to_dict(),
            "hero_moment": self.hero_moment,
        }


@dataclass
class StoryboardShot:
    """One planned storyboard shot: the generation prompt + the character anchor."""
    scene_id: str
    prompt: str
    character_id: str | None
    hero_moment: bool


@dataclass
class Storyboard:
    """A planned storyboard: the shot list + which characters recur."""
    shots: list[StoryboardShot] = field(default_factory=list)
    # The set of character_ids that appear in >1 shot → need the character-lock applied.
    recurring_characters: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "shots": [asdict(s) for s in self.shots],
            "recurring_characters": list(self.recurring_characters),
        }


def plan_storyboard(
    scenes: list[SceneSpec],
    style_context: dict[str, Any] | None = None,
) -> Storyboard:
    """Map a gemma-produced scene list onto a storyboard of generation prompts.

    Deterministic: same scenes → same storyboard (no LLM, no generation). Each
    scene becomes one :class:`StoryboardShot` via the 5-layer prompt builder;
    ``transition`` scenes are dropped. Characters appearing in ≥2 shots are listed
    in ``recurring_characters`` so the batch driver knows to apply the
    character-lock (Step 2) to those shots.

    Args:
        scenes: The scene list (gemma decomposed the story into these).
        style_context: Optional playbook/style context (Layer 5 of the prompt).

    Returns:
        A :class:`Storyboard` ready for batch image-gen.
    """
    # Local import avoids a circular dependency at module load.
    from app.planning.shot_prompt_builder import build_batch_prompts

    planner_scenes = [s.to_planner_scene() for s in scenes]
    built = build_batch_prompts(planner_scenes, style_context)

    # Index character_id by scene_id to re-attach after the prompt build.
    char_by_id = {s.id: s.character_id for s in scenes}
    shots: list[StoryboardShot] = []
    char_counts: dict[str, int] = {}
    for entry in built:
        cid = char_by_id.get(entry["scene_id"])
        shots.append(StoryboardShot(
            scene_id=entry["scene_id"],
            prompt=entry["prompt"],
            character_id=cid,
            hero_moment=bool(entry["hero_moment"]),
        ))
        if cid:
            char_counts[cid] = char_counts.get(cid, 0) + 1

    recurring = sorted(c for c, n in char_counts.items() if n >= 2)
    return Storyboard(shots=shots, recurring_characters=recurring)
