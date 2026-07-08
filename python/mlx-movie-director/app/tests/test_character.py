"""CPU-pure unit tests for app/commands/image-character.py.

Covers build_identity_spec — the character-lock.v1 spec builder (the lock
fields, schema, lora/cfg handling, views extension). No generation, no SAM3,
no GPU. The end-to-end profile+cutout+spec path is exercised by
`run.py image character --self-test` under --run-gpu, not here.
"""
import argparse
import importlib

# Hyphen in the module filename prevents a normal import; mirror image.py's
# importlib.import_module path used for every app/commands/image-* module.
ch = importlib.import_module("app.commands.image-character")


def _args(**kw):
    base = dict(
        pipeline="flux2-klein", ref_count=3, ref_strength=0.8,
        style_anchor=None, lora_path=None, lora_scale=None, cfg_scale=None,
    )
    base.update(kw)
    return argparse.Namespace(**base)


class TestBuildIdentitySpec:
    def test_emits_character_lock_v1_schema_and_hero(self):
        spec = ch.build_identity_spec("/hero.png", 42, _args(), [])
        assert spec["schema"] == "character-lock.v1"
        assert spec["hero"] == "/hero.png"

    def test_lock_carries_seed_refcount_refstrength_pipeline(self):
        spec = ch.build_identity_spec("/h.png", 12345, _args(ref_count=2, ref_strength=0.5),
                                      [])
        lock = spec["lock"]
        assert lock["seed"] == 12345
        assert lock["refCount"] == 2
        assert lock["refStrength"] == 0.5
        assert lock["pipeline"] == "flux2-klein"

    def test_auto_pipeline_normalizes_to_flux2_klein(self):
        spec = ch.build_identity_spec("/h.png", 1, _args(pipeline="auto"), [])
        assert spec["lock"]["pipeline"] == "flux2-klein"

    def test_style_anchor_strips_whitespace(self):
        spec = ch.build_identity_spec("/h.png", 1, _args(style_anchor="  soft anime shading  "),
                                      [])
        assert spec["lock"]["styleAnchor"] == "soft anime shading"

    def test_lora_path_and_scale_recorded_when_lora_given(self):
        spec = ch.build_identity_spec("/h.png", 1, _args(lora_path=["/l.safetensors"],
                                      lora_scale=0.8), [])
        assert spec["lock"]["loraPath"] == "/l.safetensors"
        assert spec["lock"]["loraScale"] == 0.8

    def test_no_lora_keys_when_lora_absent(self):
        spec = ch.build_identity_spec("/h.png", 1, _args(), [])
        assert "loraPath" not in spec["lock"]
        assert "loraScale" not in spec["lock"]

    def test_cfg_scale_recorded_only_when_set(self):
        with_cfg = ch.build_identity_spec("/h.png", 1, _args(cfg_scale=3.0), [])
        without = ch.build_identity_spec("/h.png", 1, _args(cfg_scale=None), [])
        assert with_cfg["lock"]["cfgScale"] == 3.0
        assert "cfgScale" not in without["lock"]

    def test_views_extension_lists_sheet_artifacts(self):
        views = [
            {"view": "front", "image": "/o/front.png", "cutout": "/o/front_cutout.png"},
            {"view": "side", "image": "/o/side.png", "cutout": None},
        ]
        spec = ch.build_identity_spec("/h.png", 1, _args(), views)
        assert spec["views"] == views
        assert spec["shots"] == []  # the sheet is the asset; shots planned later

    def test_seed_is_int_coerced(self):
        spec = ch.build_identity_spec("/h.png", 7, _args(), [])
        assert isinstance(spec["lock"]["seed"], int)
        assert spec["lock"]["seed"] == 7
