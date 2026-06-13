#!/usr/bin/env python3
"""Rename _ALL_TESTS keys to namespace:name convention + add deprecation infra."""
import re

RENAME = {
    "ultraflux": "vae:ultraflux",
    "portrait-full": "workflow:portrait",
    "grain-sweep": "workflow:grain",
    "face-detail-ab": "workflow:face-detail",
    "landscape-post": "workflow:landscape",
    "workflow-postprocess": "workflow:postprocess",
    "portrait-seeds": "t2i:portrait",
    "landscape-seeds": "t2i:landscape",
    "zit-sda-v1": "lora:sda-portrait",
    "zit-sda-v1-fullbody": "lora:sda-fullbody",
    "zit-sda-v1-sweep": "lora:sda-sweep",
    "anime2real": "lora:anime2real",
    "anime2real-ref": "lora:anime2real-ref",
    "anime2real-review": "lora:anime2real-review",
    "anime2real-pipeline": "lora:anime2real-pipeline",
    "anime2real-ab": "lora:anime2real-ab",
    "anime2real-ref-strength": "lora:anime2real-ref-strength",
    "anime2real-civitai-compare": "lora:anime2real-civitai",
    "anime2real-diversity": "lora:anime2real-diversity",
    "anime2real-male-boundary": "lora:anime2real-male",
    "anime2real-steps-sweep": "lora:anime2real-steps",
    "anime2real-edge-cases": "lora:anime2real-edge",
    "anatomy-challenge": "lora:anatomy",
    "profile-zimage": "profile:zimage",
    "profile-prompt-abc": "profile:prompt-abc",
    "profile-flux2-gen": "profile:flux2-gen",
    "profile-flux2-abc": "profile:flux2-abc",
    "basic-controlnet": "controlnet:basic",
    "cnet-sweep": "controlnet:sweep",
    "cnet-sweep2": "controlnet:sweep2",
    "cnet-pose": "controlnet:pose",
    "cnet-pose2": "controlnet:pose2",
    "cnet-pose3": "controlnet:pose3",
    "cnet-pose4": "controlnet:pose4",
    "seed-sweep": "controlnet:seed-sweep",
    "dual-guidance": "controlnet:dual",
    "clothing-prompt": "controlnet:clothing",
    "spatial-mask": "controlnet:spatial-mask",
    "arm-erase": "controlnet:arm-erase",
    "video-rainy-street": "video:t2v-rainy",
    "video-forest-hiker": "video:t2v-forest",
    "flf2v-kitchen-coffee": "video:flf2v-coffee",
    "flf2v-studio-turn": "video:flf2v-turn",
    "flf2v-landscape-dusk": "video:flf2v-dusk",
    "faceswap-crossgender": "swap:face-crossgender",
    "faceswap-crossgender-reverse": "swap:face-crossgender-reverse",
    "swap-face": "swap:sam-face",
    "swap-outfit": "swap:sam-outfit",
    "swap-object": "swap:sam-object",
    "swap-food": "swap:sam-food",
    "swap-face-2": "swap:sam-face-2",
    "swap-food-2": "swap:sam-food-2",
    "swap-object-2": "swap:sam-object-2",
    "swap-all": "swap:sam-all",
    "expansion": "expansion:basic",
    "expansion-sweep": "expansion:sweep",
    "expansion-multi": "expansion:multi",
    "expansion-comprehensive": "expansion:full",
    "expansion-ref-strength": "expansion:ref-strength",
    "expansion-edge-cases": "expansion:edge",
    "expansion-overlap-sweep": "expansion:overlap",
    "expansion-feather-sweep": "expansion:feather",
    "expansion-steps-sweep": "expansion:steps",
    "expansion-pixels-sweep": "expansion:pixels",
    "expansion-defaults-ab": "expansion:defaults-ab",
}

def main():
    path = "python/mlx-movie-director/app/test_prompts_image.py"
    with open(path) as f:
        content = f.read()

    # Phase 1: Rename keys in _ALL_TESTS dict
    for old, new in RENAME.items():
        content = re.sub(
            rf'^(\s+)"{re.escape(old)}": ({{)',
            rf'\1"{new}": \2',
            content,
            flags=re.MULTILINE,
        )

    # Phase 2: Update _ALL_TESTS_ALIASES values that pointed to old keys
    for old, new in RENAME.items():
        content = re.sub(
            rf'^(\s+)"([^"]+)"\s*:\s*"{re.escape(old)}"(,?)',
            rf'\1"\2": "{new}"\3',
            content,
            flags=re.MULTILINE,
        )

    # Phase 2b: Add old canonical names as aliases pointing to new names
    old_canonical_aliases = []
    for old, new in RENAME.items():
        old_canonical_aliases.append(f'    "{old}": "{new}",')
    old_alias_block = "\n".join(old_canonical_aliases)

    # Insert after "_ALL_TESTS_ALIASES = {" line
    content = content.replace(
        "_ALL_TESTS_ALIASES = {",
        "_ALL_TESTS_ALIASES = {\n"
        "    # Deprecated canonical names (moved to namespace:name format)\n"
        + old_alias_block + "\n",
    )

    # Phase 3: Add _DEPRECATED_NAMES set before _ALL_TESTS_ALIASES
    old_keys = sorted(RENAME.keys())
    deprecated_set_lines = [
        "# ---------------------------------------------------------------------------",
        "# Deprecated test names (old canonical names kept as aliases)",
        "# ---------------------------------------------------------------------------",
        "_DEPRECATED_NAMES = {",
    ]
    for k in old_keys:
        deprecated_set_lines.append(f'    "{k}",')
    deprecated_set_lines.append("}")
    deprecated_set_lines.append("")

    deprecated_set_text = "\n".join(deprecated_set_lines)

    content = content.replace(
        "# ---------------------------------------------------------------------------\n# Unified alias table\n# ---------------------------------------------------------------------------\n\n_ALL_TESTS_ALIASES = {",
        deprecated_set_text + "# ---------------------------------------------------------------------------\n# Unified alias table\n# ---------------------------------------------------------------------------\n\n_ALL_TESTS_ALIASES = {",
    )

    # Phase 4: Update get_test() with deprecation warning
    old_get_test = '''def get_test(name: str) -> dict:
    """Unified lookup across all test types. Returns the test config dict."""
    key = _ALL_TESTS_ALIASES.get(name, name)
    if key not in _ALL_TESTS:
        available = sorted(set(list(_ALL_TESTS.keys()) + list(_ALL_TESTS_ALIASES.keys())))
        raise ValueError(f"Unknown test '{name}'. Available: {', '.join(available)}")
    return _ALL_TESTS[key]'''

    new_get_test = '''def get_test(name: str) -> dict:
    """Unified lookup across all test types. Returns the test config dict."""
    # Deprecation warning for old-style test names
    if name in _DEPRECATED_NAMES:
        new_name = _ALL_TESTS_ALIASES.get(name, name)
        print(f"\\u26a0  DEPRECATED: self-test '{name}' is deprecated. "
              f"Use '{new_name}' instead.", file=sys.stderr)
    key = _ALL_TESTS_ALIASES.get(name, name)
    if key not in _ALL_TESTS:
        available = sorted(set(list(_ALL_TESTS.keys()) + list(_ALL_TESTS_ALIASES.keys())))
        raise ValueError(f"Unknown test '{name}'. Available: {', '.join(available)}")
    return _ALL_TESTS[key]'''

    content = content.replace(old_get_test, new_get_test)

    with open(path, "w") as f:
        f.write(content)

    print(f"✅ Renamed {len(RENAME)} keys in _ALL_TESTS")
    print(f"✅ Updated _ALL_TESTS_ALIASES values")
    print(f"✅ Added _DEPRECATED_NAMES with {len(old_keys)} entries")
    print(f"✅ Updated get_test() with deprecation warning")


if __name__ == "__main__":
    main()
