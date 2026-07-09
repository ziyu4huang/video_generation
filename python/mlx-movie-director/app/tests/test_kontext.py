"""CPU-pure unit tests for app/commands/image-kontext.py.

Covers the in-context scene builder (build_incontext_scenes) — subject splicing,
template cycling, count clamping, and the empty-subject path. No pipeline, no
mflux, no GPU. The end-to-end FLUX.1-Kontext-dev render is exercised by
`run.py image kontext --self-test` under --run-gpu (gated HF download), not here.
"""
import importlib

# Hyphen in the module filename prevents a normal import; mirror image.py's
# importlib.import_module path used for every app/commands/image-* module.
kc = importlib.import_module("app.commands.image-kontext")


def test_subject_spliced_into_every_template():
    scenes = kc.build_incontext_scenes("a woman with red hair", count=3)
    assert len(scenes) == 3
    # The SAME subject must appear in every scene — that is the whole point of
    # in-context identity consistency (capability E).
    for s in scenes:
        assert "a woman with red hair" in s
    # Scenes must be differentiated (different settings), not identical.
    assert len(set(scenes)) == 3


def test_count_clamped_to_minimum_one():
    scenes = kc.build_incontext_scenes("subject", count=0)
    assert len(scenes) == 1
    scenes_neg = kc.build_incontext_scenes("subject", count=-3)
    assert len(scenes_neg) == 1


def test_count_exceeding_pool_cycles_templates():
    # Default pool has 6 templates; ask for 8 → templates cycle, all carry subject.
    scenes = kc.build_incontext_scenes("the hero", count=8)
    assert len(scenes) == 8
    assert all("the hero" in s for s in scenes)


def test_empty_subject_strips_placeholder():
    # With no subject, the <SUBJECT> token + its trailing ", " must not survive
    # as a dangling comma / placeholder in the rendered prompt.
    scenes = kc.build_incontext_scenes("", count=2)
    assert len(scenes) == 2
    for s in scenes:
        assert "<SUBJECT>" not in s
        assert not s.strip().startswith(",")


def test_custom_templates_with_token():
    scenes = kc.build_incontext_scenes(
        "alice", count=2, templates=["<SUBJECT> at the beach", "<SUBJECT> at the office"],
    )
    assert scenes == ["alice at the beach", "alice at the office"]


def test_custom_templates_without_token_appends_subject():
    scenes = kc.build_incontext_scenes(
        "alice", count=1, templates=["a rainy street"],
    )
    assert scenes == ["a rainy street, alice"]


def test_custom_templates_without_token_no_subject_passthrough():
    scenes = kc.build_incontext_scenes(
        "", count=1, templates=["a self-contained prompt"],
    )
    assert scenes == ["a self-contained prompt"]


def test_constants_match_mflux_kontext_defaults():
    # Guard against drift: these mirror mflux's own Kontext constants. If they
    # change upstream, the wiring defaults should be revisited deliberately.
    assert kc.KONTEXT_MODEL_ID == "black-forest-labs/FLUX.1-Kontext-dev"
    assert kc.DEFAULT_KONTEXT_GUIDANCE == 2.5
    # Kontext-dev is non-distilled — a real step budget, not Flux2 Klein's 4.
    assert kc.DEFAULT_KONTEXT_STEPS >= 12
