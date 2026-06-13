"""Regression tests for caption.py VLM-output parsing and the score contract."""

import importlib

import pytest

# caption.py imports requests + PIL.Image at module top. Skip gracefully if a
# runtime dep is absent so the rest of the suite stays green.
pytest.importorskip("requests")
caption = importlib.import_module("app.commands.caption")


class TestExtractCaptionJson:
    """`_extract_caption_json` must tolerate fenced/prose-wrapped VLM output,
    because `_call_vlm` does not set response_format=json_object. A naive parse
    silently zeroes every score in the review HTML."""

    def test_dict_passthrough(self):
        d = {"overall": 8}
        assert caption._extract_caption_json(d) == d

    def test_non_str_non_dict_returns_empty(self):
        assert caption._extract_caption_json(None) == {}
        assert caption._extract_caption_json(123) == {}
        assert caption._extract_caption_json([]) == {}

    def test_plain_json(self):
        assert caption._extract_caption_json('{"overall": 8, "detail": 7}') == {
            "overall": 8, "detail": 7,
        }

    def test_json_fence_stripped(self):
        raw = '```json\n{"overall": 8}\n```'
        assert caption._extract_caption_json(raw) == {"overall": 8}

    def test_bare_fence_stripped(self):
        raw = '```\n{"overall": 8}\n```'
        assert caption._extract_caption_json(raw) == {"overall": 8}

    def test_json_embedded_in_prose(self):
        raw = 'Sure! Here is the score: {"overall": 7, "detail": 6} hope this helps.'
        assert caption._extract_caption_json(raw) == {"overall": 7, "detail": 6}

    def test_malformed_returns_empty(self):
        assert caption._extract_caption_json("no json here at all") == {}

    def test_garbled_fence_falls_back_to_brace_search(self):
        # fence + trailing prose after the closing brace
        raw = '```json\n{"overall": 9} extra trailing words\n```'
        assert caption._extract_caption_json(raw) == {"overall": 9}


class TestScoreContract:
    """Locks the score dimension keys that SelfTestResults / CaptionScoreBar read."""

    def test_score_keys_are_six_dimensions(self):
        assert caption._SCORE_KEYS == [
            "overall", "detail", "sharpness",
            "composition", "prompt_adherence", "artifacts",
        ]

    def test_score_labels_align_with_keys(self):
        assert len(caption._SCORE_LABELS) == len(caption._SCORE_KEYS)
