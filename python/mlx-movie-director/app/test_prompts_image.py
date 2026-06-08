"""Built-in test prompts for image quality evaluation commands."""

_PROMPTS = {
    "portrait": {
        "prompt": (
            "photorealistic portrait of a young woman, sharp eyes with detailed irises, "
            "natural skin texture with fine pores, soft studio lighting, bokeh background, "
            "high detail, ultra sharp focus"
        ),
        "width": 640,
        "height": 960,
    },
    "landscape": {
        "prompt": (
            "photorealistic mountain landscape at golden hour, sharp rocky peaks, "
            "detailed pine forest, dramatic sky with clouds, ultra sharp, high dynamic range"
        ),
        "width": 960,
        "height": 640,
    },
    "texture": {
        "prompt": (
            "extreme close-up of weathered stone wall texture, sharp crisp edges, "
            "deep relief detail, natural moss and lichen, macro photography"
        ),
        "width": 640,
        "height": 640,
    },
}

_DEFAULT = "portrait"


def get_test_prompt(name: str) -> dict:
    """Return prompt dict with keys: prompt, width, height."""
    if name not in _PROMPTS:
        names = list(_PROMPTS.keys())
        raise ValueError(f"Unknown test prompt '{name}'. Available: {', '.join(names)}")
    return _PROMPTS[name]


def list_test_prompt_names() -> list:
    return list(_PROMPTS.keys())
