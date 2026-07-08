"""Tests for the planning layer (shot_prompt_builder + scene_spec / plan_storyboard).

Pure/deterministic — no generation, no models. Covers the 5-layer prompt build,
enum phrase mapping + unknown-key pass-through, transition-scene skipping,
texture-keyword joining, style-context Layer 5, and the storyboard recurring-
character detection that drives the character-lock.
"""
from __future__ import annotations

from app.planning.scene_spec import (
    SceneSpec,
    ShotLanguage,
    plan_storyboard,
)
from app.planning.shot_prompt_builder import build_shot_prompt, build_batch_prompts


# ─── shot_prompt_builder ──────────────────────────────────────────────────────


def test_build_shot_prompt_full_5_layers():
    scene = {
        "description": "a detective in a rain-soaked alley",
        "texture_keywords": ["trench coat", "neon reflections"],
        "shot_language": {
            "lens_mm": 50,
            "depth_of_field": "shallow",
            "shot_size": "medium",
            "camera_movement": "dolly_in",
            "lighting_key": "neon",
            "color_temperature": "cool",
        },
    }
    prompt = build_shot_prompt(scene)
    # Layer 1 (camera)
    assert "50mm lens" in prompt
    assert "shallow depth of field" in prompt
    # Layer 2 (movement) — static omitted, dolly_in expanded
    assert "medium shot from waist up" in prompt
    assert "slow dolly in toward subject" in prompt
    # Layer 3 (subject) — description + texture keywords joined
    assert "a detective in a rain-soaked alley" in prompt
    assert "trench coat" in prompt and "neon reflections" in prompt
    # Layer 4 (lighting)
    assert "neon-lit with vibrant color spill" in prompt
    assert "cool blue-toned color palette" in prompt


def test_static_camera_movement_is_omitted():
    scene = {"description": "x", "shot_language": {"camera_movement": "static", "shot_size": "wide"}}
    prompt = build_shot_prompt(scene)
    assert "static" not in prompt
    assert "wide shot capturing full scene" in prompt


def test_unknown_enum_passes_through_verbatim():
    # A gemma plan may use a value outside the enum; it must NOT silently drop.
    scene = {"description": "x", "shot_language": {"shot_size": "dutch_tilt_macro"}}
    prompt = build_shot_prompt(scene)
    assert "dutch_tilt_macro" in prompt


def test_minimal_scene_description_only():
    scene = {"description": "a lone figure on a hill"}
    prompt = build_shot_prompt(scene)
    assert prompt == "a lone figure on a hill"


def test_style_context_adds_layer5_not_a_prefix():
    scene = {"description": "x"}
    style = {"mood": "melancholic", "visual_language": {"aesthetic": "35mm film grain"}}
    prompt = build_shot_prompt(scene, style)
    # aesthetic wins over mood; appears as a "Style:" layer at the END, not prepended.
    assert prompt.endswith("Style: 35mm film grain")
    assert not prompt.startswith("Style:")


def test_build_batch_prompts_skips_transitions_and_keeps_hero():
    scenes = [
        {"id": "s1", "type": "visual", "description": "a", "hero_moment": True},
        {"id": "s2", "type": "transition", "description": "b"},
        {"id": "s3", "type": "visual", "description": "c"},
    ]
    built = build_batch_prompts(scenes)
    assert [b["scene_id"] for b in built] == ["s1", "s3"]
    assert built[0]["hero_moment"] is True


# ─── scene_spec + plan_storyboard ─────────────────────────────────────────────


def _scene(sid: str, character_id: str | None = None, **kw) -> SceneSpec:
    return SceneSpec(
        id=sid,
        subject=kw.get("subject", "a hero"),
        scene=kw.get("scene", "a rooftop at dusk"),
        motion=kw.get("motion", "standing still"),
        character_id=character_id,
        shot_language=ShotLanguage(
            shot_size=kw.get("shot_size", "medium"),
            lighting_key=kw.get("lighting_key", "golden_hour"),
        ),
    )


def test_plan_storyboard_builds_prompt_per_scene():
    scenes = [_scene("s1"), _scene("s2")]
    sb = plan_storyboard(scenes)
    assert len(sb.shots) == 2
    assert sb.shots[0].scene_id == "s1"
    # subject + motion + scene all land in Layer 3
    assert "a hero" in sb.shots[0].prompt
    assert "a rooftop at dusk" in sb.shots[0].prompt


def test_plan_storyboard_detects_recurring_characters():
    scenes = [
        _scene("s1", character_id="alice"),
        _scene("s2", character_id="bob"),
        _scene("s3", character_id="alice"),   # alice recurs
    ]
    sb = plan_storyboard(scenes)
    assert sb.recurring_characters == ["alice"]
    # bob appears once → not recurring
    assert "bob" not in sb.recurring_characters


def test_plan_storyboard_no_recurring_when_all_unique():
    scenes = [_scene("s1", character_id="a"), _scene("s2", character_id="b")]
    sb = plan_storyboard(scenes)
    assert sb.recurring_characters == []


def test_plan_storyboard_skips_transitions():
    scenes = [
        _scene("s1"),
        SceneSpec(id="s2", subject="", scene="", type="transition"),
        _scene("s3"),
    ]
    sb = plan_storyboard(scenes)
    assert [s.scene_id for s in sb.shots] == ["s1", "s3"]


def test_storyboard_to_dict_roundtrips():
    sb = plan_storyboard([_scene("s1", character_id="a"), _scene("s2", character_id="a")])
    d = sb.to_dict()
    assert d["recurring_characters"] == ["a"]
    assert d["shots"][0]["prompt"] == sb.shots[0].prompt


# ─── image-storyboard command helpers ─────────────────────────────────────────

import argparse as _argparse
import importlib as _importlib

# image-storyboard.py has a hyphen → must load via importlib (not a bare import).
_sb = _importlib.import_module("app.commands.image-storyboard")


def test_deterministic_fixture_has_one_recurring_character():
    scenes = _sb._deterministic_fixture()
    assert len(scenes) == 3
    # All three beats are the same detective → recurring.
    sbs = plan_storyboard(scenes)
    assert sbs.recurring_characters == ["detective"]


def test_scene_from_dict_roundtrips_json_shape():
    raw = {
        "id": "x1", "subject": "a runner", "scene": "a bridge", "motion": "sprinting",
        "texture_keywords": ["motion blur", "rain"],
        "shot_language": {"shot_size": "wide", "lighting_key": "blue_hour", "lens_mm": 24},
        "character_id": "runner", "hero_moment": True,
    }
    spec = _sb._scene_from_dict(raw)
    assert spec.id == "x1"
    assert spec.subject == "a runner"
    assert spec.shot_language.shot_size == "wide"
    assert spec.shot_language.lens_mm == 24
    assert spec.character_id == "runner"


def test_build_run_config_locks_seed_and_applies_character_lock():
    args = _argparse.Namespace(
        seed=42, width=640, height=960, steps=8, pipeline="zimage",
        lora_path=None, lora_scale=None,
    )
    # With a hero + character lock → flux2-klein + hero as input_image + high denoise.
    rc = _sb._build_run_config("a prompt", args, hero="/h.png", use_character_lock=True)
    assert rc.seed == 42          # locked
    assert rc.pipeline == "flux2-klein"
    assert rc.input_image == "/h.png"
    assert rc.denoise_strength == 0.85
    # Without character lock → independent T2I, no input image.
    rc2 = _sb._build_run_config("a prompt", args, hero="/h.png", use_character_lock=False)
    assert rc2.input_image is None
    assert rc2.denoise_strength == 1.0
