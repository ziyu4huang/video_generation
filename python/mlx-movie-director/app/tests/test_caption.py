"""Regression tests for caption.py VLM-output parsing and the score contract."""

import importlib
import json
import os
from unittest.mock import MagicMock, patch

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


def _make_model_config(path: str, enabled: bool = True, with_kv: bool = True) -> None:
    """Write a sample LM Studio per-model default load-config into `path`."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fields = [{"key": "llm.load.contextLength", "value": 8192}]
    if with_kv:
        fields.append({
            "key": "llm.load.mlx.kvCacheQuantization",
            "value": {"enabled": enabled, "bits": 8, "groupSize": 64, "quantizedStart": 5000},
        })
    json.dump({"preset": "", "load": {"fields": fields}}, open(path, "w"))


class TestDisableKvCacheQuant:
    """`_disable_kv_cache_quant` flips MLX KV-cache quantization off in LM
    Studio's per-model default config — the root cause of mlx-vlm VLM load
    failures. Must be idempotent, safe, and back up the original."""

    def test_path_derivation(self):
        p = caption._lmstudio_default_config_path("qwen/qwen3-vl-4b")
        assert p.endswith(
            ".internal/user-concrete-model-default-config/qwen/qwen3-vl-4b.json"
        )

    def test_missing_config_returns_false(self, tmp_path, monkeypatch):
        monkeypatch.setattr(caption, "_lmstudio_home", lambda: str(tmp_path))
        assert caption._disable_kv_cache_quant("qwen/qwen3-vl-4b") is False

    def test_no_kv_field_returns_false(self, tmp_path, monkeypatch):
        monkeypatch.setattr(caption, "_lmstudio_home", lambda: str(tmp_path))
        cfg = caption._lmstudio_default_config_path("pub/model")
        _make_model_config(cfg, with_kv=False)
        assert caption._disable_kv_cache_quant("pub/model") is False

    def test_already_disabled_returns_false(self, tmp_path, monkeypatch):
        monkeypatch.setattr(caption, "_lmstudio_home", lambda: str(tmp_path))
        cfg = caption._lmstudio_default_config_path("pub/model")
        _make_model_config(cfg, enabled=False)
        assert caption._disable_kv_cache_quant("pub/model") is False
        kv = [f for f in json.load(open(cfg))["load"]["fields"] if "kvCache" in f["key"]][0]
        assert kv["value"]["enabled"] is False  # unchanged

    def test_disables_and_backs_up(self, tmp_path, monkeypatch):
        monkeypatch.setattr(caption, "_lmstudio_home", lambda: str(tmp_path))
        cfg = caption._lmstudio_default_config_path("pub/model")
        _make_model_config(cfg, enabled=True)
        assert caption._disable_kv_cache_quant("pub/model") is True
        kv = [f for f in json.load(open(cfg))["load"]["fields"] if "kvCache" in f["key"]][0]
        assert kv["value"]["enabled"] is False
        # backup created, preserving the original enabled=True
        d = os.path.dirname(cfg)
        backups = [f for f in os.listdir(d) if f.startswith("model.json.bak")]
        assert len(backups) == 1
        bak = json.load(open(os.path.join(d, backups[0])))
        bak_kv = [f for f in bak["load"]["fields"] if "kvCache" in f["key"]][0]
        assert bak_kv["value"]["enabled"] is True


class TestEnsureModelFlow:
    """`_lmstudio_ensure_model`: loaded short-circuit; load-fail -> KV-fix -> retry."""

    @staticmethod
    def _resp(status_code: int, body: dict) -> MagicMock:
        r = MagicMock()
        r.status_code = status_code
        r.json.return_value = body
        r.text = json.dumps(body)
        return r

    def test_already_loaded_short_circuits(self):
        with patch.object(caption.requests, "get") as g, \
             patch.object(caption.requests, "post") as p:
            g.return_value = self._resp(200, {"models": [
                {"key": "qwen/qwen3-vl-4b", "loaded_instances": [{"id": "x"}]}]})
            assert caption._lmstudio_ensure_model(
                "http://localhost:1234/v1", "qwen/qwen3-vl-4b") is True
            p.assert_not_called()

    def test_load_fail_then_kvfix_then_retry_succeeds(self):
        get_resps = [self._resp(200, {"models": [
            {"key": "qwen/qwen3-vl-4b", "loaded_instances": []}]}),
            # after successful retry-load, ensure re-checks loaded state
            self._resp(200, {"models": [
                {"key": "qwen/qwen3-vl-4b", "loaded_instances": [{"id": "x"}]}]}),
        ]
        post_resps = [
            self._resp(200, {"error": {"type": "model_load_failed"}}),
            self._resp(200, {"status": "loaded", "instance_id": "x"}),
        ]
        with patch.object(caption.requests, "get", side_effect=get_resps), \
             patch.object(caption.requests, "post", side_effect=post_resps), \
             patch.object(caption, "_disable_kv_cache_quant", return_value=True) as fix, \
             patch.object(caption.time, "sleep"):
            assert caption._lmstudio_ensure_model(
                "http://localhost:1234/v1", "qwen/qwen3-vl-4b") is True
            fix.assert_called_once_with("qwen/qwen3-vl-4b")

    def test_load_fail_no_fix_returns_false(self):
        with patch.object(caption.requests, "get") as g, \
             patch.object(caption.requests, "post") as p, \
             patch.object(caption, "_disable_kv_cache_quant", return_value=False):
            g.return_value = self._resp(200, {"models": [
                {"key": "m", "loaded_instances": []}]})
            p.return_value = self._resp(200, {"error": {"type": "model_load_failed"}})
            assert caption._lmstudio_ensure_model("http://localhost:1234/v1", "m") is False
