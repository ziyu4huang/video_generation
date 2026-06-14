"""Regression tests for the multi-LoRA self-test wiring (lora:multi-zimage).

This self-test exists to verify the multi-LoRA feature end-to-end: the
`--lora-path`/`--lora-scale` `action="append"` plumbing, the `lora_paths`/
`lora_scales` list fields on RunConfig/pipeline, and the pipeline looping
`apply_lora` per adapter. These tests pin the wiring WITHOUT running any GPU
pipeline — registry inspection + AST checks on the dispatcher/runner.

The GPU reproducibility run itself is exercised manually via:
    python/venv/bin/python run.py image t2i --self-test lora:multi-zimage
"""

import ast
import importlib
from pathlib import Path

test_prompts = importlib.import_module("app.test_prompts_image")
image_review = importlib.import_module("app.commands.image-review")
schema_defaults = importlib.import_module("app.commands.schema-defaults")
_shared = importlib.import_module("app.commands._shared")

TEST_NAME = "lora:multi-zimage"
TEST_TYPE = "multi-lora"


class TestRegistryEntry:
    def test_entry_exists(self):
        assert TEST_NAME in test_prompts._ALL_TESTS, (
            f"{TEST_NAME!r} missing from _ALL_TESTS")

    def test_entry_has_multi_lora_type(self):
        assert test_prompts._ALL_TESTS[TEST_NAME]["type"] == TEST_TYPE

    def test_entry_has_four_variants(self):
        variants = test_prompts._ALL_TESTS[TEST_NAME]["variants"]
        assert len(variants) == 4, f"expected 4 variants, got {len(variants)}"

    def test_has_baseline_single_and_stacked_variants(self):
        """baseline (0 LoRA) + 2 singles (1 each) + 1 stacked (≥2)."""
        variants = test_prompts._ALL_TESTS[TEST_NAME]["variants"]
        counts = sorted(len(v.get("lora_paths") or []) for v in variants)
        assert counts == [0, 1, 1, 2], f"lora_path counts {counts} != [0,1,1,2]"

    def test_stacked_variant_scales_pair_with_paths(self):
        variants = test_prompts._ALL_TESTS[TEST_NAME]["variants"]
        stacked = [v for v in variants if len(v.get("lora_paths") or []) >= 2][0]
        assert len(stacked["lora_paths"]) == len(stacked["lora_scales"]), (
            "stacked variant paths/scales must pair 1:1")


class TestDispatchWiring:
    def test_type_maps_to_t2i_action(self):
        """multi-lora must appear under t2i in the GUI self-test catalog."""
        assert schema_defaults._TEST_TYPE_TO_ACTION.get(TEST_TYPE) == "t2i"

    def test_dispatcher_routes_multi_lora_to_runner(self):
        """`_run_one_test` must call _run_selftest_multi_lora for type 'multi-lora'."""
        src = Path(image_review.__file__).read_text()
        tree = ast.parse(src)
        fn = next(
            n for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name == "_run_one_test"
        )
        # Collect every `test_type == "<X>"` string compared inside the dispatcher.
        dispatched = set()
        for n in ast.walk(fn):
            if isinstance(n, ast.Compare):
                for comp in n.comparators:
                    if isinstance(comp, ast.Constant) and comp.value == TEST_TYPE:
                        dispatched.add(TEST_TYPE)
        assert TEST_TYPE in dispatched, (
            f"_run_one_test does not dispatch type {TEST_TYPE!r}")

    def test_runner_function_exists(self):
        assert hasattr(image_review, "_run_selftest_multi_lora")


class TestRunnerPlumbing:
    """The runner must exercise the actual multi-LoRA plumbing: pass lora_paths/
    lora_scales lists into pipeline.generate, and resolve names via the list helper."""

    def _runner_src(self) -> str:
        src = Path(image_review.__file__).read_text()
        tree = ast.parse(src)
        fn = next(
            n for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name == "_run_selftest_multi_lora"
        )
        # ast.get_source_segment needs the full source; re-derive via line range.
        return "\n".join(src.splitlines()[fn.lineno - 1:fn.end_lineno])

    def test_runner_passes_lora_paths_to_generate(self):
        body = self._runner_src()
        assert "lora_paths=" in body, "runner does not pass lora_paths to generate()"
        assert "lora_scales=" in body, "runner does not pass lora_scales to generate()"

    def test_runner_uses_resolve_lora_paths(self):
        body = self._runner_src()
        assert "resolve_lora_paths" in body, (
            "runner must resolve names via resolve_lora_paths (warn+skip on missing)")

    def test_runner_verifies_applied_count(self):
        """The whole point: assert the stacked variant actually applied ≥2 LoRAs."""
        body = self._runner_src()
        assert "lora_applied" in body, (
            "runner must inspect lora_applied events to verify stacking worked")
        assert "stacked_applied" in body


class TestStackedLorasAreInstalled:
    """The stacked variant references real installed LoRAs so the GPU run applies
    both (resolve_lora_paths warns+skips missing ones, which would make the test
    meaningless). This catches a rename/move breaking the self-test."""

    def test_stacked_loras_resolve_to_real_files(self):
        variants = test_prompts._ALL_TESTS[TEST_NAME]["variants"]
        stacked = [v for v in variants if len(v.get("lora_paths") or []) >= 2][0]
        resolved = _shared.resolve_lora_paths(stacked["lora_paths"])
        assert len(resolved) == len(stacked["lora_paths"]), (
            f"stacked LoRAs did not all resolve: "
            f"{stacked['lora_paths']} → {resolved}")
        for p in resolved:
            assert Path(p).exists(), f"resolved LoRA missing on disk: {p}"
