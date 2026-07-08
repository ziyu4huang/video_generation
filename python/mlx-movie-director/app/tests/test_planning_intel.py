"""Tests for the OM lib/ intelligence layer port (playbook / scoring / pacing).

Step 4 of next-goal-20260708-230000. Pure/deterministic — no generation, no
models, no IO (playbook YAML is built inline; load_playbook's disk path is
exercised via a tmp file). Covers the playbook parse + projections, the
feature-weight rubric (incl. the inpainting capability weight + missing-feature
reporting), the scene-pacing gate (min/max/text_card/ordering), and the
plan_storyboard ←→ playbook wiring (Layer 5).
"""
from __future__ import annotations

import os
import tempfile

from app.planning.playbook import (
    DEFAULT_PACING,
    Playbook,
    PacingRules,
    load_playbook,
    playbook_to_style_context,
    style_anchor,
)
from app.planning.scoring import (
    score_frame,
    rank_frames,
)
from app.planning.scene_spec import SceneSpec, plan_storyboard
from app.planning.verify_scene_pacing import verify_scene_pacing


# ─── fixtures ─────────────────────────────────────────────────────────────────

_PLAYBOOK_YAML = """
identity:
  name: "Clean Professional"
  mood: polished, trustworthy
visual_language:
  color_palette:
    primary: ["#2563EB", "#1E40AF"]
    background: "#FFFFFF"
  composition: centered, generous whitespace
  texture: clean flat
motion:
  pacing_rules:
    min_scene_hold_seconds: 2.5
    max_scene_hold_seconds: 12
    text_card_hold_seconds: 3.5
asset_generation:
  image_prompt_prefix: "clean flat illustration, "
  image_negative_prompt: "photorealistic, dark"
  consistency_anchors:
    - "Blue (#2563EB) as primary accent"
    - "White backgrounds throughout"
"""


def _write_yaml(text: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".yaml")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    return path


# ─── playbook ─────────────────────────────────────────────────────────────────


def test_playbook_from_dict_parses_om_shape():
    import yaml
    pb = Playbook.from_dict(yaml.safe_load(_PLAYBOOK_YAML))
    assert pb.name == "Clean Professional"
    assert "polished" in pb.mood
    assert pb.image_prompt_prefix.startswith("clean flat")
    assert pb.image_negative_prompt == "photorealistic, dark"
    assert pb.consistency_anchors[0].startswith("Blue")
    # palette collects every hex across primary (list) + background (scalar)
    assert "#2563EB" in pb.palette and "#1E40AF" in pb.palette
    assert "#FFFFFF" in pb.palette
    assert pb.pacing.min_scene_hold_seconds == 2.5
    assert pb.pacing.text_card_hold_seconds == 3.5


def test_playbook_from_dict_partial_degrades_to_defaults():
    pb = Playbook.from_dict({"identity": {"name": "x"}})
    assert pb.name == "x"
    assert pb.consistency_anchors == []
    assert pb.palette == []
    # pacing falls back to the documented defaults
    assert pb.pacing.min_scene_hold_seconds == DEFAULT_PACING["min_scene_hold_seconds"]


def test_load_playbook_round_trip_and_cleanup():
    path = _write_yaml(_PLAYBOOK_YAML)
    try:
        pb = load_playbook(path)
        assert pb.name == "Clean Professional"
    finally:
        os.unlink(path)


def test_playbook_to_style_context_drives_layer5():
    pb = Playbook(mood="noir", aesthetic="centered, whitespace")
    ctx = playbook_to_style_context(pb)
    assert ctx["mood"] == "noir"
    assert ctx["visual_language"]["aesthetic"] == "centered, whitespace"


def test_playbook_to_style_context_empty_when_no_aesthetic():
    pb = Playbook()  # no mood, no aesthetic
    assert playbook_to_style_context(pb) == {}


def test_style_anchor_joins_anchors_and_palette():
    pb = Playbook(consistency_anchors=["Blue accent", "White bg"],
                  palette=["#2563EB", "#FFFFFF"])
    anchor = style_anchor(pb)
    assert "Blue accent" in anchor and "#2563EB" in anchor
    assert "palette:" in anchor


def test_style_anchor_empty_when_bare():
    assert style_anchor(Playbook()) == ""


# ─── scoring ──────────────────────────────────────────────────────────────────


def test_score_frame_weighted_aggregate_and_inpainting_weight():
    # inpainting is the capability-weighted axis (1.5); a high inpainting signal
    # lifts the score more than a same-valued standard axis would.
    signals = {"sharpness": 0.8, "inpainting": 0.9}
    report = score_frame(signals)
    # weighted = 0.8*1.0 + 0.9*1.5 = 2.15 ; total_weight = 1.0 + 1.5 = 2.5
    assert abs(report.score - (2.15 / 2.5)) < 1e-6
    assert report.passed
    # the breakdown carries the per-feature weighted contribution
    inp = next(b for b in report.breakdown if b.feature == "inpainting")
    assert inp.weight == 1.5 and abs(inp.weighted - 1.35) < 1e-6


def test_score_frame_missing_features_reported():
    # a frame judged only on sharpness is missing the rest of the rubric
    report = score_frame({"sharpness": 0.9})
    assert "inpainting" in report.missing
    assert "composition" in report.missing


def test_score_frame_none_signals_fails_not_passes():
    report = score_frame(None)
    assert report.score == 0.0
    assert report.passed is False  # no judge → fail, never silently pass


def test_score_frame_clamps_and_skips_meta_keys():
    report = score_frame({"sharpness": 5.0, "exposure": -1.0,
                          "score": 0.99, "summary": "ok"})
    sharp = next(b for b in report.breakdown if b.feature == "sharpness")
    exp = next(b for b in report.breakdown if b.feature == "exposure")
    assert sharp.value == 1.0      # clamped down
    assert exp.value == 0.0        # clamped up
    assert all(b.feature not in ("score", "summary") for b in report.breakdown)


def test_score_frame_unknown_feature_counts_at_weight_one():
    report = score_frame({"brand_new_signal": 1.0})
    b = report.breakdown[0]
    assert b.feature == "brand_new_signal" and b.weight == 1.0
    assert report.score == 1.0


def test_rank_frames_best_first_and_missing_last():
    frames = [
        {"id": "a", "signals": {"sharpness": 0.3}},
        {"id": "b", "signals": {"sharpness": 0.9}},
        {"id": "c"},  # no signals → score 0, sorts last
    ]
    ranked = rank_frames(frames)
    assert ranked[0][0]["id"] == "b"
    assert ranked[-1][0]["id"] == "c"
    assert ranked[-1][1].score == 0.0


# ─── pacing ───────────────────────────────────────────────────────────────────


def test_pacing_ok_when_in_envelope():
    scenes = [
        {"id": "s1", "type": "broll", "start_seconds": 0, "end_seconds": 5},
        {"id": "s2", "type": "broll", "start_seconds": 5, "end_seconds": 10},
    ]
    report = verify_scene_pacing(scenes, PacingRules(min_scene_hold_seconds=2,
                                                     max_scene_hold_seconds=12))
    assert report.ok
    assert report.violations == []


def test_pacing_flags_under_and_over_hold():
    scenes = [
        {"id": "short", "type": "broll", "start_seconds": 0, "end_seconds": 1},   # < 2s min
        {"id": "long", "type": "broll", "start_seconds": 1, "end_seconds": 20},   # > 12s max
    ]
    report = verify_scene_pacing(scenes, PacingRules(min_scene_hold_seconds=2,
                                                     max_scene_hold_seconds=12))
    assert not report.ok
    rules = {v.rule for v in report.violations}
    assert "min_hold" in rules and "max_hold" in rules


def test_pacing_text_card_uses_stricter_floor():
    # a text_card at 2.6s passes the generic min (2.0) but fails the text_card floor (3.0)
    scenes = [{"id": "t", "type": "text_card", "start_seconds": 0, "end_seconds": 2.6}]
    report = verify_scene_pacing(scenes, PacingRules(min_scene_hold_seconds=2,
                                                     max_scene_hold_seconds=12,
                                                     text_card_hold_seconds=3.0))
    assert not report.ok
    assert report.violations[0].rule == "text_card_hold"


def test_pacing_flags_overlap_and_negative_hold():
    scenes = [
        {"id": "a", "type": "broll", "start_seconds": 0, "end_seconds": 5},
        # starts before a ended → ordering; also negative hold on this one
        {"id": "b", "type": "broll", "start_seconds": 3, "end_seconds": 2},
    ]
    report = verify_scene_pacing(scenes)
    rules = {v.rule for v in report.violations}
    assert "ordering" in rules


def test_pacing_skips_scenes_without_timing():
    scenes = [{"id": "n", "type": "broll"}]  # no start/end
    report = verify_scene_pacing(scenes)
    assert report.ok  # nothing to gate → not a violation


# ─── plan_storyboard ←→ playbook wiring ───────────────────────────────────────


def test_plan_storyboard_uses_playbook_for_layer5():
    scenes = [SceneSpec(id="s1", subject="a detective", scene="an alley",
                        motion="walking")]
    pb = Playbook(mood="noir", aesthetic="moody low-key, 35mm grain")
    board = plan_storyboard(scenes, playbook=pb)
    # Layer 5 surfaces the playbook aesthetic on the built prompt
    assert "moody low-key" in board.shots[0].prompt or "noir" in board.shots[0].prompt


def test_plan_storyboard_explicit_style_context_overrides_playbook():
    scenes = [SceneSpec(id="s1", subject="x", scene="y")]
    pb = Playbook(mood="noir")
    board = plan_storyboard(scenes, style_context={"mood": "bright",
                            "visual_language": {"aesthetic": "high-key sunny"}}, playbook=pb)
    assert "high-key sunny" in board.shots[0].prompt
    assert "noir" not in board.shots[0].prompt
