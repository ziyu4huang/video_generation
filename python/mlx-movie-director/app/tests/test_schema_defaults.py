"""Regression tests for schema-defaults GUI export of self-test metadata."""

import importlib
import json

schema = importlib.import_module("app.commands.schema-defaults")


class TestBuildOutput:
    def test_build_is_json_serializable(self):
        # The whole purpose of schema-defaults is JSON export to the GUI.
        json.dumps(schema._build())

    def test_build_has_core_actions(self):
        data = schema._build()
        for action in ("t2i", "i2i", "workflow"):
            assert action in data, f"missing action {action!r}"

    def test_self_tests_is_a_list_when_present(self):
        # `self_tests` is optional (e.g. video-relay has none); when present it
        # must be a list so the GUI can always render it uniformly.
        data = schema._build()
        for action, entry in data.items():
            if "self_tests" in entry:
                assert isinstance(entry["self_tests"], list), (
                    f"action {action!r} self_tests not a list"
                )


class TestBuildSelfTests:
    def test_returns_dict_grouped_by_action(self):
        grouped = schema._build_self_tests()
        assert isinstance(grouped, dict)
        for action, tests in grouped.items():
            assert isinstance(action, str)
            assert isinstance(tests, list)
            for t in tests:
                assert "name" in t and isinstance(t["name"], str)
                assert "desc" in t and isinstance(t["desc"], str)
