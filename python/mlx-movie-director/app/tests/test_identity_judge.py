"""Tests for the multi-image identity judge JSON hardening (Step 1b,
next-goal-20260709-000000).

``_parse_identity_json`` (in the hyphenated ``image-profile`` module) is the core of
the #366 multi-image flakiness fix: strict ``json.loads`` with a balanced-object
fallback that strips prose / ```json fences. The LM Studio HTTP call is NOT
exercised here — only the parser.
"""
from __future__ import annotations

import importlib

# image-profile.py has a hyphen → not importable as a bare name; use importlib
# (same pattern image.py uses).
_profile = importlib.import_module("app.commands.image-profile")
_parse_identity_json = _profile._parse_identity_json


def test_parse_clean_json():
    raw = '{"same_identity": true, "face_match": true, "identity_score": 9}'
    res = _parse_identity_json(raw)
    assert res is not None and res["same_identity"] is True


def test_parse_dict_passthrough():
    d = {"same_identity": False, "issues": ["hair color differs"]}
    assert _parse_identity_json(d) == d


def test_parse_strips_prose_around_object():
    raw = (
        "Here is my analysis of the two images.\n\n"
        "```json\n"
        '{"same_identity": true, "face_match": true, "hair_match": true, '
        '"skin_match": true, "outfit_match": true, "accessories_match": false, '
        '"identity_score": 8, "issues": [], "summary": "same person"}\n'
        "```\n"
    )
    res = _parse_identity_json(raw)
    assert res is not None
    assert res["same_identity"] is True
    assert res["identity_score"] == 8


def test_parse_rejects_object_without_same_identity():
    # a valid JSON object that lacks the gate key → None (don't trust a partial parse)
    assert _parse_identity_json('{"face_match": true, "score": 7}') is None


def test_parse_rejects_unparseable():
    assert _parse_identity_json("I cannot determine identity from these images.") is None
    assert _parse_identity_json("") is None
