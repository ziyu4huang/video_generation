"""Regression tests for LTX-2.3 transformer variant resolution."""

import pytest

from app.ltx_variants import LTX_VARIANTS, LTXVariant, get_variant


class TestVariantRegistry:
    def test_known_variants_present(self):
        assert {"dev", "distilled", "dasiwa"} <= set(LTX_VARIANTS)

    def test_entries_are_instances(self):
        for v in LTX_VARIANTS.values():
            assert isinstance(v, LTXVariant)


class TestGetVariant:
    def test_returns_instance(self):
        assert isinstance(get_variant("dev"), LTXVariant)

    def test_none_defaults_to_dev(self):
        assert get_variant(None) is LTX_VARIANTS["dev"]

    def test_none_with_distilled_flag(self):
        assert get_variant(None, distilled=True) is LTX_VARIANTS["distilled"]

    def test_explicit_distilled_flag(self):
        assert get_variant("distilled").is_distilled is True

    def test_dev_not_distilled(self):
        assert get_variant("dev").is_distilled is False

    def test_unknown_raises_value_error(self):
        with pytest.raises(ValueError):
            get_variant("bogus")
