"""CPU-pure unit tests for app/planning/story_angles.py.

Covers the prompt builders (angles + proposal), the JSON parsers (think-block
+ fence tolerance, array extraction), YAML serialization, and the
concept→storyboard handoff fold. No IO, no gemma, no GPU. The end-to-end
angles→propose→shots path is exercised by `run.py story` against the local
gemma brain (certify), not here.
"""
from app.planning import story_angles


# --- prompt builders --------------------------------------------------------

def test_angles_prompt_embeds_topic_count_and_schema():
    p = story_angles.build_angles_prompt("a barista's first day", count=4)
    assert "a barista's first day" in p
    assert "exactly 4" in p
    # The JSON schema is embedded so the model returns parseable output.
    assert '"angle"' in p and '"logline"' in p and '"why_different"' in p
    assert p.rstrip().endswith("JSON array:")


def test_angles_prompt_count_clamped_to_min_one():
    p = story_angles.build_angles_prompt("x", count=0)
    assert "exactly 1" in p


def test_propose_prompt_embeds_topic_count_and_om_shape():
    p = story_angles.build_propose_prompt("renewable energy for kids", count=2)
    assert "renewable energy for kids" in p
    assert "exactly 2" in p
    # OM proposal_packet shape: concept options with scene_list + visual_language + est_shot_count.
    assert '"scene_list"' in p and '"visual_language"' in p
    assert '"est_shot_count"' in p and '"estimated_cost"' in p


# --- parsers ----------------------------------------------------------------

def test_parse_angles_clean_json():
    raw = '[{"angle":"the heist","logline":"beans go missing","tone":"tense","why_different":"crime","target_audience":"adults"}]'
    out = story_angles.parse_angles(raw)
    assert len(out) == 1
    assert out[0]["angle"] == "the heist"


def test_parse_angles_strips_think_block_and_fences():
    raw = '<think>let me think</think>\n```json\n[{"angle":"a","logline":"b","tone":"c","why_different":"d","target_audience":"e"}]\n```'
    out = story_angles.parse_angles(raw)
    assert out == [{"angle": "a", "logline": "b", "tone": "c",
                    "why_different": "d", "target_audience": "e"}]


def test_parse_angles_extracts_array_from_prose():
    raw = 'Here are the angles:\n[{"angle":"a","logline":"b"}]\nHope that helps.'
    out = story_angles.parse_angles(raw)
    assert len(out) == 1 and out[0]["angle"] == "a"


def test_parse_angles_raises_on_no_array():
    import pytest
    with pytest.raises(ValueError):
        story_angles.parse_angles("no json here at all")


def test_parse_proposal_clean_json():
    raw = '[{"title":"Sunrise","angle":"hopeful","logline":"a town wakes","scene_list":["dawn","town"],"visual_language":"warm golden","est_shot_count":2,"estimated_cost":"low"}]'
    out = story_angles.parse_proposal(raw)
    assert len(out) == 1
    assert out[0]["title"] == "Sunrise"
    assert out[0]["scene_list"] == ["dawn", "town"]


def test_parse_proposal_strips_think_block():
    raw = '<think>reasoning</think>[{"title":"T","angle":"a","logline":"l","scene_list":[],"visual_language":"v","est_shot_count":1,"estimated_cost":"low"}]'
    out = story_angles.parse_proposal(raw)
    assert out[0]["title"] == "T"


# --- serialization + handoff -----------------------------------------------

def test_proposal_to_yaml_list_and_single():
    packet = [{"title": "T", "angle": "a", "scene_list": ["b1", "b2"]}]
    y = story_angles.proposal_to_yaml(packet)
    assert "title: T" in y and "b1" in y
    # Single concept (dict) is normalized to a one-element list.
    y2 = story_angles.proposal_to_yaml(packet[0])
    assert "title: T" in y2


def test_concept_to_story_folds_beats_and_style():
    concept = {
        "title": "The Last Cup",
        "logline": "A barista's final shift.",
        "scene_list": ["arrives at dawn", "brews quietly", "locks up"],
        "visual_language": "warm amber, 35mm film grain",
        "est_shot_count": 3,
    }
    story, style_hint, num_panels = story_angles.concept_to_story(concept)
    assert "The Last Cup" in story
    assert "A barista's final shift." in story
    assert "arrives at dawn" in story and "locks up" in story
    assert style_hint == "warm amber, 35mm film grain"
    assert num_panels == 3


def test_concept_to_story_defaults_when_fields_missing():
    story, style_hint, num_panels = story_angles.concept_to_story({})
    assert num_panels == 4  # the safe default
    assert style_hint == ""


def test_concept_to_story_scene_list_count_overrides_bad_est_shot_count():
    concept = {"title": "T", "scene_list": ["a", "b", "c", "d"], "est_shot_count": "garbage"}
    _, _, num_panels = story_angles.concept_to_story(concept)
    assert num_panels == 4  # falls back to len(scene_list)
