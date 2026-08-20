"""CPU-pure unit tests for app/commands/image-styletransfer.py.

Covers the style-source resolution (build_style_prompt) — playbook → preset →
prompt precedence, amplification, dedup, and the error paths. No pipeline, no
model, no GPU. The end-to-end Flux2 Klein img2img path is exercised by
`run.py image styletransfer --self-test` under --run-gpu, not here.
"""
import argparse
import importlib
import os

import pytest

# Hyphen in the module filename prevents a normal import; mirror image.py's
# importlib.import_module path used for every app/commands/image-* module.
st = importlib.import_module("app.commands.image-styletransfer")

# Playbook shipped in the repo (OM baseline) — a real, parseable YAML.
_PLAYBOOK = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "..", "..", "bun-apps", "s2-agent-ext-movie-director", "data", "styles",
    "clean-professional.yaml",
)
_PLAYBOOK = os.path.normpath(_PLAYBOOK)


def _args(**kw):
    base = dict(style_preset=None, playbook=None, prompt=None)
    base.update(kw)
    return argparse.Namespace(**base)


# ---------------------------------------------------------------------------
# preset source
# ---------------------------------------------------------------------------


class TestPresetSource:
    def test_known_preset_emits_its_prompt_fragment(self):
        p = st.build_style_prompt(_args(style_preset="watercolor"))
        assert "watercolor" in p.lower()

    def test_unknown_preset_exits_with_error(self):
        with pytest.raises(SystemExit):
            st.build_style_prompt(_args(style_preset="nonexistent-style"))

    def test_preset_is_case_insensitive(self):
        p = st.build_style_prompt(_args(style_preset="OIL-PAINTING"))
        assert "oil painting" in p.lower()


# ---------------------------------------------------------------------------
# prompt source
# ---------------------------------------------------------------------------


class TestPromptSource:
    def test_freeform_prompt_passes_through(self):
        p = st.build_style_prompt(_args(prompt="neon synthwave, 80s retro grids"))
        assert "synthwave" in p and "retro" in p


# ---------------------------------------------------------------------------
# playbook source
# ---------------------------------------------------------------------------


class TestPlaybookSource:
    @pytest.mark.skipif(not os.path.exists(_PLAYBOOK),
                        reason="clean-professional.yaml not present")
    def test_playbook_emits_image_prompt_prefix(self):
        p = st.build_style_prompt(_args(playbook=_PLAYBOOK))
        # the shipped prefix starts with "clean professional flat illustration"
        assert "flat illustration" in p.lower()

    def test_missing_playbook_exits_with_error(self, tmp_path):
        with pytest.raises(SystemExit):
            st.build_style_prompt(_args(playbook=str(tmp_path / "nope.yaml")))


# ---------------------------------------------------------------------------
# precedence + amplification + dedup
# ---------------------------------------------------------------------------


class TestPrecedenceAndAmplify:
    def test_prompt_amplifies_a_preset(self):
        p = st.build_style_prompt(
            _args(style_preset="cinematic", prompt="add heavy rain")
        )
        assert "cinematic" in p.lower()
        assert "heavy rain" in p

    def test_prompt_amplifies_a_playbook(self):
        if not os.path.exists(_PLAYBOOK):
            pytest.skip("playbook not present")
        p = st.build_style_prompt(_args(playbook=_PLAYBOOK, prompt="isometric view"))
        assert "flat illustration" in p.lower()
        assert "isometric view" in p

    def test_no_source_at_all_exits_with_error(self):
        with pytest.raises(SystemExit):
            st.build_style_prompt(_args())

    def test_duplicate_fragments_are_deduplicated(self):
        # the SAME fragment passed twice (via an identical preset repeat in the
        # prompt) collapses to one occurrence. The preset fragment as a whole
        # appears exactly once.
        preset_frag = st._STYLE_PRESETS["watercolor"]
        p = st.build_style_prompt(
            _args(style_preset="watercolor", prompt=preset_frag)
        )
        assert p.count(preset_frag) == 1
