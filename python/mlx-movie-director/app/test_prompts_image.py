"""Built-in test prompts for image quality evaluation commands."""

# ---------------------------------------------------------------------------
# Image test prompts (used by quality/review/workflow commands)
# ---------------------------------------------------------------------------

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
    "anime": {
        "prompt": (
            "anime-style close-up portrait of a young woman, highly detailed eyes with "
            "catchlights, flowing hair, soft cel-shading, pastel color palette, clean line art"
        ),
        "width": 640,
        "height": 960,
    },
    "architecture": {
        "prompt": (
            "modern glass office building exterior at dusk, dramatic angular geometry, "
            "reflective facade, city lights in background, architectural photography"
        ),
        "width": 960,
        "height": 640,
    },
    "fullbody": {
        "prompt": (
            "full body shot of a young woman standing confidently, wearing a stylish outfit, "
            "natural pose, sharp facial features, detailed hands and fingers, "
            "studio lighting with soft shadows, clean background, "
            "photorealistic, ultra sharp focus, fashion photography"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-portrait": {
        "prompt": (
            "anime girl with long pink hair, big sparkling eyes, wearing a school uniform, "
            "gentle smile, cel shading, anime art style, vibrant colors, simple background"
        ),
        "width": 640,
        "height": 960,
    },
    "street": {
        "prompt": (
            "street photography of a busy Tokyo crosswalk at night, neon signs reflected "
            "on wet pavement, people with umbrellas, cinematic, ultra sharp"
        ),
        "width": 960,
        "height": 640,
    },
    "food": {
        "prompt": (
            "food photography of a gourmet pasta dish, steam rising, fresh basil, "
            "parmesan shavings, rustic wooden table, shallow depth of field, ultra detailed"
        ),
        "width": 960,
        "height": 640,
    },
    "cyberpunk": {
        "prompt": (
            "cyberpunk woman with neon hair standing in a rain-soaked alley, holographic "
            "advertisements, purple and teal color scheme, dramatic lighting, ultra sharp"
        ),
        "width": 640,
        "height": 960,
    },
    "animal": {
        "prompt": (
            "wildlife photography of a red fox in golden autumn forest, detailed fur texture, "
            "soft bokeh background, natural lighting, ultra sharp focus"
        ),
        "width": 960,
        "height": 640,
    },
    "interior": {
        "prompt": (
            "modern minimalist living room interior, clean white walls, natural light "
            "through large windows, Scandinavian furniture, architectural photography, ultra sharp"
        ),
        "width": 960,
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


# ---------------------------------------------------------------------------
# Unified self-test registry
# ---------------------------------------------------------------------------
# Each entry has a "type" field that determines which runner handles it:
#   "vae"      → VAE variant generation + quality comparison
#   "workflow" → WorkflowOrchestrator multi-stage variations
#   "t2i"      → simple T2I A/B across seeds or params
#   "video"    → LTX-2.3 T2V generation test
#
# Adding a new test = one dict entry here, zero code changes elsewhere.

_ALL_TESTS = {

    # -----------------------------------------------------------------------
    # type=vae: VAE variant comparison
    # -----------------------------------------------------------------------

    "ultraflux": {
        "type": "vae",
        "description": "Default flux-ae vs UltraFlux VAE — sharpness and edge quality comparison",
        "test_prompt": "portrait",
        "seed": 42,
        "steps": 9,
        "variants": [
            {"label": "Default VAE",   "vae_path": None},
            {"label": "UltraFlux VAE", "vae_path": "ultraflux"},
        ],
    },

    # -----------------------------------------------------------------------
    # type=workflow: WorkflowOrchestrator variations
    # -----------------------------------------------------------------------

    "portrait-full": {
        "type": "workflow",
        "description": (
            "Full pipeline A/B/C: base only vs base+detail+post vs full pipeline "
            "with ESRGAN upscale — shows each stage's contribution"
        ),
        "test_prompt": "portrait",
        "seed": 42,
        "steps": 9,
        "variations": [
            {
                "label": "A-Base Only",
                "face_detail": False,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.0,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "B-Detail+Post",
                "face_detail": True,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.015,
                "sharpening": 0.1,
                "skin_contrast": True,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "C-Full Pipeline",
                "face_detail": True,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.015,
                "sharpening": 0.1,
                "skin_contrast": True,
                "noise_clean": False,
                "upscale": True,
                "upscale_method": "esrgan",
            },
        ],
    },

    "grain-sweep": {
        "type": "workflow",
        "description": (
            "Film grain intensity sweep: 0 / 0.008 / 0.015 / 0.025 — "
            "all with face detailer enabled, find optimal grain level"
        ),
        "test_prompt": "portrait",
        "seed": 42,
        "steps": 9,
        "variations": [
            {
                "label": "A-No Grain",
                "face_detail": True,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.0,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "B-Subtle 0.008",
                "face_detail": True,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.008,
                "sharpening": 0.0,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "C-Medium 0.015",
                "face_detail": True,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.015,
                "sharpening": 0.0,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "D-Heavy 0.025",
                "face_detail": True,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.025,
                "sharpening": 0.0,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
        ],
    },

    "face-detail-ab": {
        "type": "workflow",
        "description": (
            "Face detailer denoise strength A/B: off / 0.10 / 0.15 / 0.25 — "
            "subtle sharpening (0.1) on all, find optimal denoise level"
        ),
        "test_prompt": "portrait",
        "seed": 42,
        "steps": 9,
        "variations": [
            {
                "label": "A-No Detailer",
                "face_detail": False,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.1,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "B-Denoise 0.10",
                "face_detail": True,
                "face_detail_denoise": 0.10,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.1,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "C-Denoise 0.15",
                "face_detail": True,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.1,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "D-Denoise 0.25",
                "face_detail": True,
                "face_detail_denoise": 0.25,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.1,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
        ],
    },

    "landscape-post": {
        "type": "workflow",
        "description": (
            "Post-processing chain comparison on landscape: base / sharp+clean / "
            "grain+sharp — no face detailer (landscape has no faces)"
        ),
        "test_prompt": "landscape",
        "seed": 42,
        "steps": 9,
        "variations": [
            {
                "label": "A-Base Only",
                "face_detail": False,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.0,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "B-Sharp+Clean",
                "face_detail": False,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.0,
                "sharpening": 0.15,
                "skin_contrast": False,
                "noise_clean": True,
                "upscale": False,
                "upscale_method": "esrgan",
            },
            {
                "label": "C-Grain+Sharp",
                "face_detail": False,
                "face_detail_denoise": 0.15,
                "face_detail_steps": 9,
                "film_grain": 0.015,
                "sharpening": 0.1,
                "skin_contrast": False,
                "noise_clean": False,
                "upscale": False,
                "upscale_method": "esrgan",
            },
        ],
    },

    # -----------------------------------------------------------------------
    # type=nomodel: fast in-process smoke tests, no GPU / no model loading
    # -----------------------------------------------------------------------

    "workflow-postprocess": {
        "type": "nomodel",
        "description": "PostProcessChain on synthetic image — no model loading, <1s",
    },

    # -----------------------------------------------------------------------
    # type=t2i: simple T2I comparison across seeds or parameters
    # -----------------------------------------------------------------------

    "portrait-seeds": {
        "type": "t2i",
        "description": "Same portrait prompt, 4 different seeds — baseline diversity check",
        "test_prompt": "portrait",
        "steps": 9,
        "seeds": [42, 123, 777, 999],
    },

    "landscape-seeds": {
        "type": "t2i",
        "description": "Same landscape prompt, 4 different seeds — composition variety check",
        "test_prompt": "landscape",
        "steps": 9,
        "seeds": [42, 123, 777, 999],
    },

    # -----------------------------------------------------------------------
    # type=lora: LoRA adapter A/B comparison (multi-seed paired)
    # -----------------------------------------------------------------------

    "zit-sda-v1": {
        "type": "lora",
        "description": (
            "SDA LoKr A/B: baseline vs Z-Image-Turbo SDA diversity adapter — "
            "multi-seed paired comparison with HTML voting review"
        ),
        "test_prompt": "portrait",
        "seeds": [42, 123, 777, 999],
        "steps": 9,
        "lora_scale": 1.0,
        "variants": [
            {"label": "Baseline", "lora_path": None},
            {"label": "SDA v1",   "lora_path": "zit-sda-v1"},
        ],
    },

    "zit-sda-v1-fullbody": {
        "type": "lora",
        "description": (
            "SDA LoKr A/B: baseline vs SDA adapter — full-body fashion photography prompt, "
            "tests whether SDA helps with full-body composition and hand quality"
        ),
        "test_prompt": "fullbody",
        "seeds": [42, 123, 777, 999],
        "steps": 9,
        "lora_scale": 1.0,
        "variants": [
            {"label": "Baseline", "lora_path": None},
            {"label": "SDA v1",   "lora_path": "zit-sda-v1"},
        ],
    },

    # -----------------------------------------------------------------------
    # type=lora-sweep: LoRA across multiple prompt styles (general evaluator)
    # -----------------------------------------------------------------------

    "zit-sda-v1-sweep": {
        "type": "lora-sweep",
        "description": "SDA LoRA sweep: baseline vs SDA v1 across 8 diverse prompt styles",
        "lora_scale": 1.0,
        "seeds": [42, 777],
        "steps": 9,
        "test_prompts": [
            "portrait", "landscape", "fullbody", "street",
            "food", "cyberpunk", "animal", "interior",
        ],
        "variants": [
            {"label": "Baseline", "lora_path": None},
            {"label": "SDA v1",   "lora_path": "zit-sda-v1"},
        ],
    },

    # -----------------------------------------------------------------------
    # type=lora-i2i: T2I → I2I pipeline with LoRA (style transfer via img2img)
    # -----------------------------------------------------------------------

    "anime2real": {
        "type": "lora-i2i",
        "description": (
            "anime2real LoRA: T2I anime baseline → I2I with anything2real LoRA — "
            "anime-to-photorealistic style transfer, multi-seed comparison with "
            "caption verification and HTML voting review"
        ),
        "test_prompt": "anime-portrait",
        "i2i_prompt": (
            "Preserve the subject's features and generate a high quality "
            "realistic human photograph"
        ),
        "pipeline": "flux2-klein",
        "steps": 4,
        "width": 640,
        "height": 960,
        "seeds": [42, 123],
        "denoise_strength": 0.6,
        "lora_path": "anime-girl-turned-into-real-person",
        "lora_scale": 0.8,
    },

    # -----------------------------------------------------------------------
    # type=profile: Multi-view character profile with VLM view-angle verification
    # -----------------------------------------------------------------------

    "profile-zimage": {
        "type": "profile",
        "description": "ZImage front/back/side three-view — VLM verifies each view angle",
        "views": ["front", "back", "side"],
        "pipeline": "zimage",
        "test_prompt": "portrait",
        "steps": 6,
        "seed": 42,
        "ratio": "standing",
    },

    "profile-prompt-abc": {
        "type": "profile",
        "description": "Prompt A/B/C: v1-medium vs v2-ultrashort (CivitAI) vs angle-EN — VLM picks winner",
        "views": ["front", "back", "side"],
        "pipeline": "zimage",
        "steps": 6,
        "seed": 42,
        "ratio": "standing",
        "prompt_variants": [
            {
                "label": "v1-medium",
                "prompts": {
                    "front": "生成图中人物A-pose的正面图,人物站立，去除杂物，白色背景，完美的身体比例，头不要太大，保持人物服装一致性",
                    "back":  "生成图中人物A-pose的背面图,人物站立，去除杂物，白色背景，完美的身体比例，头不要太大，保持人物服装一致性",
                    "side":  "生成图中人物A-pose的侧面图,人物站立，去除杂物，白色背景，完美的身体比例，头不要太大，保持人物服装和人物的一致性",
                },
            },
            {
                "label": "v2-ultrashort",
                "prompts": {
                    "front": "生成图中角色全身的正视图，保持人物一致性。",
                    "back":  "生成图中角色的后视图。保持人物一致性。",
                    "side":  "生成图中角色的侧视图。",
                },
            },
            {
                "label": "angle-en",
                "prompts": None,
            },
        ],
    },

    "profile-flux2-gen": {
        "type": "profile",
        "description": (
            "ZImage T2I → Flux2-Klein 3-view profile — "
            "generates reference portrait first, then profiles it with real reference conditioning. "
            "Tests character consistency across views; VLM verifies each view angle."
        ),
        "views": ["front", "back", "side"],
        "pipeline": "flux2-klein",
        "generate_reference": True,
        "test_prompt": "portrait",
        "steps_ref": 9,
        "steps": 6,
        "seed": 42,
        "ratio": "standing",
    },

    "profile-flux2-abc": {
        "type": "profile",
        "description": (
            "Flux2-Klein A/B/C: v1-medium vs v2-ultrashort vs angle-EN — "
            "all variants use the same generated reference portrait. VLM picks the best prompt style."
        ),
        "views": ["front", "back", "side"],
        "pipeline": "flux2-klein",
        "generate_reference": True,
        "test_prompt": "portrait",
        "steps_ref": 9,
        "steps": 6,
        "seed": 42,
        "ratio": "standing",
        "prompt_variants": [
            {
                "label": "v1-medium",
                "prompts": {
                    "front": "生成图中人物A-pose的正面图,人物站立，去除杂物，白色背景，完美的身体比例，头不要太大，保持人物服装一致性",
                    "back":  "生成图中人物A-pose的背面图,人物站立，去除杂物，白色背景，完美的身体比例，头不要太大，保持人物服装一致性",
                    "side":  "生成图中人物A-pose的侧面图,人物站立，去除杂物，白色背景，完美的身体比例，头不要太大，保持人物服装和人物的一致性",
                },
            },
            {
                "label": "v2-ultrashort",
                "prompts": {
                    "front": "生成图中角色全身的正视图，保持人物一致性。",
                    "back":  "生成图中角色的后视图。保持人物一致性。",
                    "side":  "生成图中角色的侧视图。",
                },
            },
            {"label": "angle-en", "prompts": None},  # falls back to VIEW_PROMPTS_FLUX2
        ],
    },

    # -----------------------------------------------------------------------
    # type=video: LTX-2.3 T2V generation tests
    # -----------------------------------------------------------------------

    "video-rainy-street": {
        "type": "video",
        "description": "Woman walking in rain — cinematic T2V baseline",
        "prompt": (
            "young woman walking on a rainy city street at night, neon reflections on wet pavement, "
            "cinematic slow motion, shallow depth of field, atmospheric fog"
        ),
        "width": 768,
        "height": 512,
        "duration_frames": 25,
        "seed": 42,
        "steps": 30,
    },

    "video-forest-hiker": {
        "type": "video",
        "description": "Person hiking through sunlit forest — motion and nature lighting test",
        "prompt": (
            "person hiking through a sunlit forest, dappled light through tree canopy, "
            "smooth tracking shot, lush green foliage, cinematic"
        ),
        "width": 768,
        "height": 512,
        "duration_frames": 25,
        "seed": 42,
        "steps": 30,
    },
}

# ---------------------------------------------------------------------------
# Unified alias table
# ---------------------------------------------------------------------------

_ALL_TESTS_ALIASES = {
    # VAE test aliases
    "vae-ultra-flux":  "ultraflux",
    "vae-ultraflux":   "ultraflux",
    "ultra-flux":      "ultraflux",
    "ultraflux-ae":    "ultraflux",
    # Workflow test aliases
    "full":        "portrait-full",
    "portrait":    "portrait-full",
    "grain":       "grain-sweep",
    "faces":       "face-detail-ab",
    "landscape":   "landscape-post",
    "post":        "landscape-post",
    # T2I alias
    "seeds":       "portrait-seeds",
    # LoRA test aliases
    "sda":         "zit-sda-v1",
    "sda-v1":      "zit-sda-v1",
    "sda-test":    "zit-sda-v1",
    "sda-fullbody":   "zit-sda-v1-fullbody",
    "sda-v1-fullbody": "zit-sda-v1-fullbody",
    "sda-sweep":     "zit-sda-v1-sweep",
    # LoRA I2I aliases
    "anime-girl":     "anime2real",
    "anime2real-lora": "anime2real",
    "anything2real":  "anime2real",
    # Video aliases
    "rainy-street":  "video-rainy-street",
    "forest-hiker":  "video-forest-hiker",
    # Profile aliases
    "profile":          "profile-zimage",
    "profile-abc":      "profile-prompt-abc",
    "profile-ab":       "profile-prompt-abc",
    "profile-prompts":  "profile-prompt-abc",
    "profile-flux2":    "profile-flux2-gen",
}


def get_test(name: str) -> dict:
    """Unified lookup across all test types. Returns the test config dict."""
    key = _ALL_TESTS_ALIASES.get(name, name)
    if key not in _ALL_TESTS:
        available = sorted(set(list(_ALL_TESTS.keys()) + list(_ALL_TESTS_ALIASES.keys())))
        raise ValueError(f"Unknown test '{name}'. Available: {', '.join(available)}")
    return _ALL_TESTS[key]


def list_test_names() -> list:
    """Return all canonical test names."""
    return list(_ALL_TESTS.keys())


# ---------------------------------------------------------------------------
# Backward-compatible helpers (thin wrappers around get_test)
# ---------------------------------------------------------------------------

_VAE_TESTS = {k: v for k, v in _ALL_TESTS.items() if v["type"] == "vae"}
_VAE_TEST_ALIASES = {k: v for k, v in _ALL_TESTS_ALIASES.items() if _ALL_TESTS_ALIASES.get(k, k) in _VAE_TESTS or k in _VAE_TESTS}

_WORKFLOW_TESTS = {k: v for k, v in _ALL_TESTS.items() if v["type"] == "workflow"}
_WORKFLOW_TEST_ALIASES = {k: v for k, v in _ALL_TESTS_ALIASES.items() if _ALL_TESTS_ALIASES.get(k, k) in _WORKFLOW_TESTS or k in _WORKFLOW_TESTS}


def get_vae_test(name: str) -> dict:
    """Return VAE test config dict. Backward-compatible wrapper around get_test()."""
    cfg = get_test(name)
    if cfg["type"] != "vae":
        raise ValueError(f"Test '{name}' is type '{cfg['type']}', not 'vae'")
    return cfg


def list_vae_test_names() -> list:
    return list(_VAE_TESTS.keys())


def get_workflow_test(name: str) -> dict:
    """Return workflow test config dict. Backward-compatible wrapper around get_test()."""
    cfg = get_test(name)
    if cfg["type"] != "workflow":
        raise ValueError(f"Test '{name}' is type '{cfg['type']}', not 'workflow'")
    return cfg


def list_workflow_test_names() -> list:
    return list(_WORKFLOW_TESTS.keys())


_LORA_TESTS = {k: v for k, v in _ALL_TESTS.items() if v["type"] == "lora"}
_LORA_TEST_ALIASES = {k: v for k, v in _ALL_TESTS_ALIASES.items() if _ALL_TESTS_ALIASES.get(k, k) in _LORA_TESTS or k in _LORA_TESTS}


def get_lora_test(name: str) -> dict:
    """Return LoRA test config dict. Backward-compatible wrapper around get_test()."""
    cfg = get_test(name)
    if cfg["type"] != "lora":
        raise ValueError(f"Test '{name}' is type '{cfg['type']}', not 'lora'")
    return cfg


def list_lora_test_names() -> list:
    return list(_LORA_TESTS.keys())
