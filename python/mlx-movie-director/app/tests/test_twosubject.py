"""CPU-only tests for the VLM-driven single-prompt two-subject path.

Covers the helpers ``image twosubject`` relies on — the local-VLM prompt-master,
the judge, selection, and reference-image captioning. The VLM (LM Studio) is
mocked throughout: no model load, no GPU, no network.
"""

import importlib

import pytest


def _mc():
    # image-twosubject.py has a hyphen → import via importlib (like image.py).
    return importlib.import_module("app.commands.image-twosubject")


# ---------------------------------------------------------------------------
# Prompt master — composes ONE anti-bleeding two-subject prompt
# ---------------------------------------------------------------------------

class TestComposePrompt:
    def test_text_only_uses_vlm_text_and_contains_both_descs(self, monkeypatch):
        mc = _mc()
        captured = {}

        def fake_text(api_url, model, prompt, auto_load=True):
            captured["prompt"] = prompt
            return "COMPOSED PROMPT"

        monkeypatch.setattr(mc, "_vlm_text", fake_text)
        monkeypatch.setattr(mc.vlm, "_call_vlm_multi",
                            lambda *a, **k: pytest.fail("multi must not run without images"))

        out = mc.compose_two_subject_prompt(
            "url", "model", "raven-hair girl", "auburn-hair woman", "moody style")
        assert out == "COMPOSED PROMPT"
        # The instruction must name BOTH subjects. (Style is NOT embedded here —
        # compose produces scene+people only; run_twosubject appends style after.)
        assert "raven-hair girl" in captured["prompt"]
        assert "auburn-hair woman" in captured["prompt"]
        assert "moody style" not in captured["prompt"]

    def test_with_images_uses_vlm_multi(self, monkeypatch):
        mc = _mc()
        seen = {}

        def fake_multi(api_url, model, b64_images, prompt, auto_load=True):
            seen["imgs"] = b64_images
            seen["prompt"] = prompt
            return "COMPOSED FROM IMAGES"

        monkeypatch.setattr(mc.vlm, "_call_vlm_multi", fake_multi)
        monkeypatch.setattr(mc, "_vlm_text",
                            lambda *a, **k: pytest.fail("text path must not run with images"))

        out = mc.compose_two_subject_prompt(
            "url", "model", "a", "b", "style", b64_a="A64", b64_b="B64")
        assert out == "COMPOSED FROM IMAGES"
        assert seen["imgs"] == ["A64", "B64"]

    def test_revision_appends_failure_feedback(self, monkeypatch):
        mc = _mc()
        captured = {}

        monkeypatch.setattr(mc, "_vlm_text",
                            lambda api_url, model, prompt, auto_load=True: captured.setdefault("prompt", prompt))

        mc.compose_two_subject_prompt(
            "url", "model", "a", "b", "style",
            failure={"bleeding": ["black hair appeared on B"], "summary": "hair swap"})
        assert "black hair appeared on B" in captured["prompt"]
        assert "hair swap" in captured["prompt"]


# ---------------------------------------------------------------------------
# Judge — scores one generated seed on the two-subject rubric
# ---------------------------------------------------------------------------

class TestJudge:
    def _patch_call(self, monkeypatch, raw):
        mc = _mc()
        monkeypatch.setattr(mc.vlm, "_call_vlm", lambda *a, **k: raw)
        monkeypatch.setattr(mc.vlm, "_image_to_base64", lambda p: "b64")
        return mc

    def test_parses_clean_json(self, monkeypatch):
        mc = self._patch_call(monkeypatch,
            '{"both_present": true, "distinct": true, "bleeding": [], '
            '"natural": 8, "overall": 9, "summary": "good"}')
        d = mc.judge_two_subject("url", "model", "x.png", "a", "b")
        assert d["overall"] == 9.0 and isinstance(d["overall"], float)
        assert d["distinct"] is True
        assert d["bleeding"] == []

    def test_tolerates_fence_and_prose(self, monkeypatch):
        mc = self._patch_call(monkeypatch,
            'Here is my assessment:\n```json\n{"overall": 7, "distinct": false, '
            '"bleeding": ["eye color"], "natural": 6, "summary": "x"}\n```')
        d = mc.judge_two_subject("url", "model", "x.png", "a", "b")
        assert d["overall"] == 7.0
        assert d["distinct"] is False

    def test_unparseable_returns_none_overall(self, monkeypatch):
        mc = self._patch_call(monkeypatch, "the image looks nice")
        d = mc.judge_two_subject("url", "model", "x.png", "a", "b")
        assert d["overall"] is None
        assert d.get("unparsed") is True


# ---------------------------------------------------------------------------
# Selection — pick the best-scored candidate (pure)
# ---------------------------------------------------------------------------

class TestPickBest:
    def test_ranks_by_overall(self):
        mc = _mc()
        scored = [
            {"overall": 6.0, "natural": 8, "distinct": True, "seed": 1},
            {"overall": 9.0, "natural": 5, "distinct": False, "seed": 2},
            {"overall": 7.0, "natural": 7, "distinct": True, "seed": 3},
        ]
        assert mc.pick_best(scored)["seed"] == 2

    def test_tiebreak_natural_then_distinct(self):
        mc = _mc()
        scored = [
            {"overall": 8.0, "natural": 6, "distinct": True, "seed": 1},
            {"overall": 8.0, "natural": 9, "distinct": False, "seed": 2},  # higher natural
            {"overall": 8.0, "natural": 9, "distinct": True, "seed": 3},   # same natural, distinct
        ]
        assert mc.pick_best(scored)["seed"] == 3

    def test_tiebreak_prefers_lower_bg_split(self):
        # Real case from the 12-candidate run: s43 and s50 tie on overall/natural/
        # distinct, but s50 has a far more unified background. The split tiebreak
        # must pick s50.
        mc = _mc()
        scored = [
            {"overall": 8.0, "natural": 9.0, "distinct": True, "bg_edge_split": 62.8, "seed": 43},
            {"overall": 8.0, "natural": 9.0, "distinct": True, "bg_edge_split": 2.0, "seed": 50},
        ]
        assert mc.pick_best(scored)["seed"] == 50

    def test_missing_split_loses_tie(self):
        # A candidate without a measured split must lose a tie to one that has it.
        mc = _mc()
        scored = [
            {"overall": 8.0, "natural": 9.0, "distinct": True, "seed": 1},
            {"overall": 8.0, "natural": 9.0, "distinct": True, "bg_edge_split": 5.0, "seed": 2},
        ]
        assert mc.pick_best(scored)["seed"] == 2

    def test_excludes_unparseable(self):
        mc = _mc()
        scored = [
            {"overall": None, "seed": 1},
            {"overall": 5.0, "seed": 2},
        ]
        assert mc.pick_best(scored)["seed"] == 2

    def test_empty_returns_none(self):
        mc = _mc()
        assert mc.pick_best([]) is None
        assert mc.pick_best([{"overall": None}]) is None


# ---------------------------------------------------------------------------
# Geometry resolution — --detail preset vs fast default (pure)
# ---------------------------------------------------------------------------

class TestResolveGeometry:
    def _ns(self, **k):
        import argparse
        return argparse.Namespace(**k)

    def test_fast_default(self):
        assert _mc()._resolve_geometry(self._ns()) == (640, 960, 9)

    def test_detail_preset(self):
        assert _mc()._resolve_geometry(self._ns(detail=True)) == (768, 1152, 20)

    def test_explicit_overrides_detail(self):
        # explicit --width/--height/--steps win even with --detail
        r = _mc()._resolve_geometry(
            self._ns(detail=True, width=1024, height=1536, steps=28))
        assert r == (1024, 1536, 28)

    def test_explicit_without_detail(self):
        r = _mc()._resolve_geometry(self._ns(width=512, height=512, steps=12))
        assert r == (512, 512, 12)


# ---------------------------------------------------------------------------
# Reference-image captioning (the i2t "refine prompts" path)
# ---------------------------------------------------------------------------

class TestResolveRefs:
    def test_captions_given_images(self, monkeypatch, tmp_path):
        mc = _mc()
        from PIL import Image
        ra = tmp_path / "a.png"; Image.new("RGB", (8, 8)).save(ra)
        rb = tmp_path / "b.png"; Image.new("RGB", (8, 8)).save(rb)

        monkeypatch.setattr(mc.vlm, "caption_image",
                            lambda path, **k: f"CAP({path})")
        monkeypatch.setattr(mc.vlm, "_image_to_base64", lambda p: f"B64({p})")

        da, db, ba, bb = mc._resolve_refs(
            "orig-a", "orig-b", str(ra), str(rb), "url", "model")
        assert da == f"CAP({str(ra)})" and db == f"CAP({str(rb)})"
        assert ba == f"B64({str(ra)})" and bb == f"B64({str(rb)})"

    def test_text_only_passes_through(self):
        mc = _mc()
        da, db, ba, bb = mc._resolve_refs("a-desc", "b-desc", None, None, "url", "model")
        assert (da, db, ba, bb) == ("a-desc", "b-desc", None, None)

    def test_missing_ref_raises(self):
        mc = _mc()
        with pytest.raises(FileNotFoundError):
            mc._resolve_refs("a", "b", "/no/such/a.png", None, "url", "model")
