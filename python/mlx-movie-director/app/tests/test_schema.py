"""Regression tests for `run.py schema` — the argparse-derived CLI contract.

schema is the single source of truth for the run.py CLI surface (unlike
schema-defaults, which is a hand-written defaults dict). These tests pin the
introspection contract so GUI/workflow consumers can rely on its shape.
"""

import importlib

schema = importlib.import_module("app.commands.schema")


class TestBuildOutput:
    def test_build_is_json_serializable(self):
        import json
        json.dumps(schema.build())

    def test_build_has_core_commands(self):
        data = schema.build()
        commands = data["commands"]
        # The real subcommands (deprecated aliases are deliberately excluded).
        for cmd in ("image", "video", "caption", "replay", "upscale", "check-model"):
            assert cmd in commands, f"missing command {cmd!r}"

    def test_deprecated_aliases_excluded(self):
        data = schema.build()
        commands = data["commands"]
        for alias in ("generate", "t2i", "check-manifests", "import-lora-image"):
            assert alias not in commands, f"deprecated alias {alias!r} should be excluded"

    def test_schema_command_self_registers(self):
        # `schema` must register itself so it appears in its own output.
        assert "schema" in schema.build()["commands"]


class TestArgShape:
    def _image_args(self):
        return schema.build()["commands"]["image"]["args"]

    def test_args_have_required_keys(self):
        for a in self._image_args():
            for key in ("flags", "dest", "action", "required", "default", "help"):
                assert key in a, f"arg missing {key!r}: {a}"

    def test_positionals_present_for_image(self):
        data = schema.build()["commands"]["image"]
        dests = [p["dest"] for p in data["positionals"]]
        assert "action" in dests
        assert "sub_action" in dests

    def test_known_flag_metadata(self):
        by_flag = {}
        for a in self._image_args():
            for f in a["flags"]:
                by_flag[f] = a
        # --pipeline: store, default zimage, 3 choices
        assert by_flag["--pipeline"]["default"] == "zimage"
        assert set(by_flag["--pipeline"]["choices"]) == {"zimage", "flux2-klein", "auto"}
        # --ab-test: store_true → default false
        assert by_flag["--ab-test"]["action"] == "_StoreTrueAction"
        assert by_flag["--ab-test"]["default"] is False
        # --lora-scale: float, default 1.0
        assert by_flag["--lora-scale"]["type"] == "float"
        assert by_flag["--lora-scale"]["default"] == 1.0

    def test_help_action_filtered_out(self):
        # -h/--help is auto-added by argparse; not a real value flag for consumers.
        for a in self._image_args():
            assert a["dest"] != "help"
