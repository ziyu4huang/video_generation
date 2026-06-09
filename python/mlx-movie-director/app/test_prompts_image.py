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
    "anime-warrior": {
        "prompt": (
            "anime girl with silver hair and red eyes, wearing dark armor, holding a katana, "
            "determined expression, standing in a misty battlefield, dramatic lighting, "
            "anime art style, detailed illustration"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-magical": {
        "prompt": (
            "anime girl with twin-tail blonde hair, wearing a frilly magical girl outfit "
            "with ribbons and lace, holding a star-tipped wand, sparkling magical effects, "
            "pastel colors, cheerful expression, anime art style"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-cyberpunk": {
        "prompt": (
            "anime girl with short blue hair and cybernetic implants, wearing a neon jacket "
            "over a crop top, futuristic city at night, holographic displays, "
            "cyberpunk anime art style, cool expression, vibrant neon lighting"
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
#   "vae"       → VAE variant generation + quality comparison
#   "workflow"  → WorkflowOrchestrator multi-stage variations
#   "t2i"       → simple T2I A/B across seeds or params
#   "video"     → LTX-2.3 T2V generation test
#   "faceswap"  → BFS face/head swap with auto-generated body + face sources
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
    # type=lora-ref: Flux2KleinEdit reference conditioning + LoRA (identity-preserving)
    # -----------------------------------------------------------------------

    "anime2real-ref": {
        "type": "lora-ref",
        "description": (
            "anime2real Ref+LoRA: Flux2KleinEdit reference conditioning preserves identity "
            "while anime2real LoRA converts anime→realistic. Tests across 4 diverse anime "
            "prompts with caption + quality + HTML voting review. "
            "Includes old I2I approach for comparison."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior", "anime-magical", "anime-cyberpunk"],
        "seeds": [42],
        "ref_steps": 8,         # steps for Ref+LoRA approach (8 = photographic)
        "i2i_steps": 4,         # steps for old I2I approach
        "width": 640,
        "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "lora_scale": 1.0,
        "ref_count": 1,
        "denoise_strength": 0.6,  # for old I2I comparison
        "ref_prompt": (
            "A photorealistic portrait photograph of the same character, "
            "detailed realistic skin texture, natural lighting, DSLR camera, "
            "shallow depth of field, keeping the original hair color, clothing, "
            "and all character features"
        ),
        "i2i_prompt": (
            "Preserve the subject's features and generate a high quality "
            "realistic human photograph"
        ),
    },

    # -----------------------------------------------------------------------
    # type=lora-ref: Simple review — original anime vs anime2real result
    # -----------------------------------------------------------------------

    "anime2real-review": {
        "type": "lora-ref",
        "review_only": True,
        "description": (
            "anime2real review: original anime vs Ref+LoRA result side-by-side. "
            "2 columns with 👍👎 feedback + text comments."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior", "anime-magical", "anime-cyberpunk"],
        "seeds": [42],
        "ref_steps": 8,
        "ref_count": 1,
        "width": 640,
        "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "lora_scale": 1.0,
        "ref_prompt": (
            "A photorealistic portrait photograph of the same character, "
            "detailed realistic skin texture, natural lighting, DSLR camera, "
            "shallow depth of field, keeping the original hair color, clothing, "
            "and all character features"
        ),
    },

    # -----------------------------------------------------------------------
    # type=lora-ref: Cross-pipeline anime2real comparison (flux2-klein vs zimage)
    # -----------------------------------------------------------------------

    "anime2real-pipeline": {
        "type": "lora-ref",
        "description": (
            "anime2real cross-pipeline: flux2-klein Ref+LoRA vs zimage I2I+LoRA. "
            "4 columns: T2I baseline, flux2-klein Ref+LoRA, flux2-klein I2I+LoRA (old), "
            "zimage I2I+jib-mix LoRA. Caption + quality + HTML voting review."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior", "anime-magical", "anime-cyberpunk"],
        "seeds": [42],
        "ref_steps": 8,
        "i2i_steps": 4,
        "width": 640,
        "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "lora_scale": 1.0,
        "ref_count": 1,
        "denoise_strength": 0.6,
        "ref_prompt": (
            "A photorealistic portrait photograph of the same character, "
            "detailed realistic skin texture, natural lighting, DSLR camera, "
            "shallow depth of field, keeping the original hair color, clothing, "
            "and all character features"
        ),
        "i2i_prompt": (
            "Preserve the subject's features and generate a high quality "
            "realistic human photograph"
        ),
        # Optional 4th column: pipeline comparison with zimage + jib-mix LoRA
        "pipeline_compare": {
            "pipeline": "zimage",
            "lora_path": "jib-mix-realistic-z-image-lora",
            "lora_scale": 0.8,
            "denoise_strength": 0.4,
            "steps": 9,
            "prompt": (
                "A photorealistic portrait photograph of the same character, "
                "detailed realistic skin texture, natural lighting, DSLR camera, "
                "keeping the original hair color, clothing, and all character features"
            ),
        },
    },

    # -----------------------------------------------------------------------
    # type=lora-ref: A/B test — photorealistic vs 3D game vs semi-realistic
    # -----------------------------------------------------------------------

    "anime2real-ab": {
        "type": "lora-ref",
        "description": (
            "anime2real A/B test: photorealistic vs 3D game vs semi-realistic. "
            "4 columns: anime baseline + 3 style variants. Vote to pick best default."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior", "anime-magical", "anime-cyberpunk"],
        "seeds": [42],
        "width": 640, "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "ref_count": 1,
        # Column B: Photorealistic
        "ref_prompt": (
            "A photorealistic portrait photograph of the same character, detailed realistic "
            "skin texture, natural lighting, DSLR camera, shallow depth of field, "
            "keeping the original hair color, clothing, and all character features"
        ),
        "ref_steps": 8,
        "lora_scale": 1.0,
        # Additional style variants (columns C, D)
        "style_variants": [
            {
                "label": "3D Game",
                "ref_prompt": (
                    "A high-quality 3D game character render of the same character, "
                    "Unreal Engine 5, subsurface scattering skin, natural-looking eyes with "
                    "realistic iris detail and reflections, cinematic rim lighting, "
                    "game asset style, keeping the original hair color, clothing, "
                    "and all character features"
                ),
                "lora_scale": 0.7,
                "ref_steps": 8,
            },
            {
                "label": "Semi-Realistic",
                "ref_prompt": (
                    "A semi-realistic digital illustration of the same character, "
                    "detailed but slightly stylized, smooth skin, soft ambient lighting, "
                    "blend of realistic and stylized aesthetics, keeping the original "
                    "hair color, clothing, and all character features"
                ),
                "lora_scale": 0.85,
                "ref_steps": 6,
            },
        ],
    },

    # -----------------------------------------------------------------------
    # type=lora-ref: A/B test — ref_strength sweep for body proportion freedom
    # -----------------------------------------------------------------------

    "anime2real-ref-strength": {
        "type": "lora-ref",
        "description": (
            "Ref strength v3: 0.2 vs 0.25 vs 0.15 vs 0.1 — "
            "find exact identity-break floor between 0.2 (safe) and 0.1 (breaks)."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior"],
        "seeds": [42],
        "width": 640, "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "ref_count": 1,
        # Column B: 3D Game at ref_strength=0.2 (current default, v2 safe minimum)
        "ref_prompt": (
            "A high-quality 3D game character render of the same character, "
            "Unreal Engine 5, subsurface scattering skin, natural-looking eyes with "
            "realistic iris detail and reflections, cinematic rim lighting, "
            "game asset style, keeping the original hair color, clothing, "
            "and all character features"
        ),
        "ref_steps": 8,
        "lora_scale": 0.7,
        "ref_strength": 0.2,
        # Columns C, D, E: test around the break point
        "style_variants": [
            {"label": "str=0.25", "ref_strength": 0.25},
            {"label": "str=0.15", "ref_strength": 0.15},
            {"label": "str=0.1", "ref_strength": 0.1},
        ],
    },

    # -----------------------------------------------------------------------
    # type=lora-ref: CivitAI workflow comparison — Chinese vs English prompt
    # -----------------------------------------------------------------------

    "anime2real-civitai-compare": {
        "type": "lora-ref",
        "description": (
            "CivitAI workflow comparison: our best (3D Game, EN) vs their Chinese prompt "
            "at various lora_scale/ref_strength combos."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior"],
        "seeds": [42],
        "width": 640, "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "ref_count": 1,
        # Column B: our current best (3D Game English prompt, lora_scale=0.7, ref_strength=0.2)
        "ref_prompt": (
            "A high-quality 3D game character render of the same character, "
            "Unreal Engine 5, subsurface scattering skin, natural-looking eyes with "
            "realistic iris detail and reflections, cinematic rim lighting, "
            "game asset style, keeping the original hair color, clothing, "
            "and all character features"
        ),
        "ref_steps": 8,
        "lora_scale": 0.7,
        "ref_strength": 0.2,
        # Columns C, D, E: CivitAI Chinese prompt at different param combos
        "style_variants": [
            {
                "label": "civitai scale=1.0 str=1.0",
                "ref_strength": 1.0,
                "lora_scale": 1.0,
                "ref_prompt": "转年轻的亚洲少女写实风格",
            },
            {
                "label": "civitai scale=1.0 str=0.2",
                "ref_strength": 0.2,
                "lora_scale": 1.0,
                "ref_prompt": "转年轻的亚洲少女写实风格",
            },
            {
                "label": "civitai scale=0.7 str=0.2",
                "ref_strength": 0.2,
                "lora_scale": 0.7,
                "ref_prompt": "转年轻的亚洲少女写实风格",
            },
        ],
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
    # type=controlnet-i2i: I2I + ControlNet verification
    # -----------------------------------------------------------------------

    "basic-controlnet": {
        "type": "controlnet-i2i",
        "description": "I2I + ControlNet (canny): verify V-pose transfer; denoise=1.0 is the smoking gun",
        "mode": "debug",   # "debug" → 1 variation (~3 min); "full" → 8 variations (~25 min)
    },

    "cnet-sweep": {
        "type": "controlnet-i2i",
        "description": "cnet_active_steps + ctrl_strength sweep to eliminate double-body while keeping V-pose",
        "mode": "cnet-sweep",   # 6 variations: act8/10/12, str0.4/0.8, 15-20 steps
    },

    "cnet-sweep2": {
        "type": "controlnet-i2i",
        "description": "ctrl_strength push (0.9-1.0) with fixed act=8 cutoff to achieve full V-pose",
        "mode": "cnet-sweep2",  # 4 variations: str0.9/1.0 x 20/25 steps, plus act6
    },

    "cnet-pose": {
        "type": "controlnet-i2i",
        "description": "OpenPose skeleton conditioning: pure pose signal, no clothing bleed",
        "mode": "cnet-pose",    # 5 variations: openpose x medium/full denoise + canny baseline
    },

    "cnet-pose2": {
        "type": "controlnet-i2i",
        "description": "OpenPose pose2: dn09 gap fill, act=8 cutoff for dn08/09, act=6 for dn10",
        "mode": "cnet-pose2",   # 4 variations: tuned from cnet-pose feedback (dn08 partial/bad_hands, dn10 ghost)
    },

    "cnet-pose3": {
        "type": "controlnet-i2i",
        "description": "OpenPose pose3: ctrl_strength 1.5/2.0 boost, dn=0.95+act10, steps=30",
        "mode": "cnet-pose3",   # 4 variations: amplify ctrl signal to overcome source latent bias at dn=0.9
    },

    "cnet-pose4": {
        "type": "controlnet-i2i",
        "description": "Blurred Canny: pre-blur ref before Canny to remove clothing texture edges",
        "mode": "cnet-pose4",   # 4 variations: blur10/15/20 + str0.8/1.0; blurred Canny = pose edges only
    },

    "seed-sweep": {
        "type": "controlnet-i2i",
        "description": "Seed sweep: best pose2 params (dn09+openpose+ALL) across 8 seeds to find fuller V-pose",
        "mode": "seed-sweep",   # 8 seeds: 42,43,100,200,300,500,1000,2025
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

    # -----------------------------------------------------------------------
    # type=flf2v: First-Last Frame to Video — 3-step pipeline self-test
    # -----------------------------------------------------------------------
    # Requires: begin/end keyframe generation (T2I) + FLF2V interpolation.
    # Best practice: same seed for both keyframes, different prompts, cfg_scale=3.0.
    # See app/test_prompts_flf2v.py for the full prompt definitions.

    "flf2v-kitchen-coffee": {
        "type": "flf2v",
        "description": (
            "Man makes coffee in kitchen: standing at counter → seated at table sipping. "
            "Tests pose + location + expression change with character consistency."
        ),
        "flf2v_test": "kitchen-coffee",
    },

    "flf2v-studio-turn": {
        "type": "flf2v",
        "description": (
            "Woman in studio: frontal portrait → subtle head turn with gentle smile. "
            "Tests minimal motion, expression micro-change, character fidelity."
        ),
        "flf2v_test": "studio-turn",
    },

    "flf2v-landscape-dusk": {
        "type": "flf2v",
        "description": (
            "Open meadow: golden hour → dusk. Tests FLF2V on non-character scenes "
            "with lighting and time transition."
        ),
        "flf2v_test": "landscape-dusk",
    },

    # -----------------------------------------------------------------------
    # type=faceswap: BFS face/head swap self-tests
    # -----------------------------------------------------------------------
    # 3-phase pipeline: ZImage body → Flux2 T2I face → Flux2 Klein Edit + BFS LoRA swap.
    # Uses "head" mode for cross-gender swaps (full head replacement including hair).

    "faceswap-crossgender": {
        "type": "faceswap",
        "description": (
            "Cross-gender faceswap: woman body + man head (head mode) — "
            "tests BFS swap quality with gender mismatch, full head replacement"
        ),
        "body_prompt": (
            "Moody Photography, 25-year-old Japanese woman in elegant black evening dress, "
            "off-shoulder neckline, standing in a dimly lit ballroom, warm chandelier light, "
            "cool blue ambient from windows, half-body shot, looking at camera, "
            "hands clasped in front, marble floor reflections."
        ),
        "face_prompt": (
            "Moody Photography, close-up portrait of a 30-year-old European man, "
            "short dark brown hair, clean-shaven, strong jawline, brown eyes, "
            "confident direct gaze, warm golden hour side lighting, "
            "shallow depth of field, film grain texture, neutral background."
        ),
        "mode": "head",
        "body_seed": 42,
        "face_seed": 200,
    },

    "faceswap-crossgender-reverse": {
        "type": "faceswap",
        "description": (
            "Reverse cross-gender faceswap: man body + woman head (head mode) — "
            "tests BFS swap quality with opposite gender mismatch"
        ),
        "body_prompt": (
            "Moody Photography, 28-year-old European man in navy blue business suit, "
            "white shirt, no tie, standing in a modern office lobby, "
            "warm interior lighting from left, cool fluorescent from ceiling, "
            "half-body shot from slightly below, looking at camera with neutral expression, "
            "arms crossed."
        ),
        "face_prompt": (
            "Moody Photography, close-up portrait of a 22-year-old East Asian woman, "
            "long straight black hair, dark brown eyes, light makeup, "
            "gentle smile, warm golden hour side lighting, "
            "shallow depth of field, film grain texture, neutral background."
        ),
        "mode": "head",
        "body_seed": 55,
        "face_seed": 300,
    },

    # ── SAM3 Swap self-tests ──────────────────────────────────────────────
    "swap-face": {
        "type": "swap",
        "description": (
            "SAM3 face swap: replace JK girl's face with European woman — "
            "tests face segmentation + composite quality"
        ),
        "source_prompt": (
            "Moody Photography, 18-year-old Japanese girl in school uniform, "
            "navy blue sailor top, white collar with red ribbon, plaid skirt, "
            "kneeling at desk, warm lamp light from left, cool moonlight from window, "
            "half-body shot from above, looking at camera with pensive expression, "
            "hands resting on desk, textbooks and ramune bottle on desk."
        ),
        "reference_prompt": (
            "Moody Photography, close-up portrait of a 22-year-old European woman, "
            "shoulder-length wavy blonde hair, blue eyes, light freckles across nose, "
            "confident direct gaze, warm golden hour side lighting, "
            "shallow depth of field, film grain texture, neutral background."
        ),
        "sam_prompt": "woman's face",
        "ref_sam_prompt": "woman's face",
        "sam_threshold": 0.3,
        "feather": 15,
        "source_seed": 42,
        "reference_seed": 100,
        "blend": True,
        "blend_strength": 0.35,
    },
    "swap-outfit": {
        "type": "swap",
        "description": (
            "SAM3 outfit swap: replace casual clothes with elegant dress — "
            "tests clothing segmentation + large mask composite"
        ),
        "source_prompt": (
            "Fashion photography, young woman standing in a bright studio, "
            "wearing casual blue jeans and a white t-shirt, arms at sides, "
            "full body shot, neutral gray background, even studio lighting, "
            "natural pose, photorealistic."
        ),
        "reference_prompt": (
            "Fashion photography, close-up of an elegant floor-length red evening gown, "
            "silk fabric with subtle shimmer, fitted bodice with off-shoulder neckline, "
            "flowing skirt, detailed fabric texture, studio lighting, "
            "displayed on mannequin, photorealistic."
        ),
        "sam_prompt": "clothing",
        "ref_sam_prompt": "dress",
        "sam_threshold": 0.25,
        "feather": 20,
        "source_seed": 55,
        "reference_seed": 200,
        "blend": True,
        "blend_strength": 0.35,
    },
    "swap-object": {
        "type": "swap",
        "description": (
            "SAM3 object swap: replace ramune bottle with coffee cup on a desk — "
            "composite + Flux Klein I2I refinement (position-preserving)"
        ),
        "source_prompt": (
            "Cozy desk scene, wooden desk surface with an open laptop, "
            "stacked books, a ramune soda bottle with blue glass and marble, "
            "warm desk lamp light, scattered pens and notebook, "
            "overhead view, photorealistic, detailed."
        ),
        "reference_prompt": (
            "Product photography, a ceramic coffee cup with latte art on a wooden saucer, "
            "steam rising, warm lighting, shallow depth of field, "
            "clean white background, photorealistic."
        ),
        "sam_prompt": "bottle",
        "ref_sam_prompt": "coffee cup",
        "sam_threshold": 0.25,
        "feather": 15,
        "source_seed": 77,
        "reference_seed": 300,
        "source_width": 960,
        "source_height": 640,
        "reference_width": 960,
        "reference_height": 640,
        "blend": True,
        "blend_strength": 0.5,
        "preserve_aspect_ratio": True,
        "mask_dilate": 40,
        "blend_prompt": (
            "Cozy desk scene, wooden desk surface with an open laptop, "
            "stacked books, a ceramic coffee cup with latte art on a wooden saucer, "
            "steam rising from the cup, warm desk lamp light, scattered pens and notebook, "
            "overhead view, photorealistic, detailed."
        ),
    },
    "swap-food": {
        "type": "swap",
        "description": (
            "SAM3 food swap: replace chocolate cake with macaron tower — "
            "composite + Flux Klein I2I refinement (position-preserving)"
        ),
        "source_prompt": (
            "Food photography, overhead shot of a white plate with a slice of chocolate "
            "layer cake with ganache frosting, a fork beside it, dark wooden table, "
            "scattered cocoa powder, warm ambient lighting, photorealistic."
        ),
        "reference_prompt": (
            "Food photography, overhead shot of a white plate with a colorful "
            "macaron tower in pastel pink, green, and lavender, "
            "clean white background, soft studio lighting, photorealistic."
        ),
        "sam_prompt": "cake",
        "ref_sam_prompt": "plate",
        "sam_threshold": 0.3,
        "feather": 20,
        "source_seed": 88,
        "reference_seed": 400,
        "source_width": 960,
        "source_height": 640,
        "reference_width": 960,
        "reference_height": 640,
        "blend": True,
        "blend_strength": 0.5,
        "preserve_aspect_ratio": True,
        "mask_dilate": 15,
        "blend_prompt": (
            "Food photography, overhead shot of a white plate with a colorful "
            "macaron tower in pastel pink, green, and lavender, "
            "a fork beside it, dark wooden table, scattered cocoa powder, "
            "warm ambient lighting, photorealistic."
        ),
    },

    # ------------------------------------------------------------------
    # Expansion / outpaint self-tests (Flux2 Klein latent-mask outpaint)
    # ------------------------------------------------------------------
    "expansion": {
        "type": "expansion",
        "description": (
            "Flux2 Klein outpaint: generate a square source, then expand two ways "
            "(directional widen + 16:9 aspect) — side-by-side + VLM seam/quality review"
        ),
        "source_prompt": (
            "Moody Photography, a young woman in a red coat standing in a narrow "
            "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
            "half-body shot, looking toward camera, cinematic, photorealistic, "
            "shallow depth of field."
        ),
        "source_seed": 42,
        "source_width": 1024,
        "source_height": 1024,
        "feather": 96,
        "overlap": 96,
        "steps": 8,
        "longest": 1024,
        "configs": [
            {
                "label": "expand-left-right",
                "mode": "expand",
                "dirs": "left,right",
                "pixels": 512,
                "seed": 42,
                "prompt": (
                    "Extend the alley scene sideways: more cobblestone street, "
                    "brick buildings, streetlamps and soft dusk light consistent "
                    "with the centre. Seamless, photorealistic, no visible seam."
                ),
            },
            {
                "label": "ratio-16x9",
                "mode": "ratio",
                "ratio": "16:9",
                "seed": 42,
                "prompt": (
                    "Widen to a cinematic 16:9 frame: extend the alley, buildings, "
                    "and atmospheric dusk lighting outward. Maintain the subject "
                    "and style. Seamless, photorealistic."
                ),
            },
        ],
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
    # LoRA Ref aliases
    "anime2real-v2":  "anime2real-ref",
    "a2r-ref":        "anime2real-ref",
    "ref-lora":       "anime2real-ref",
    "anime2real-v3":  "anime2real-pipeline",
    "a2r-pipe":       "anime2real-pipeline",
    "a2r-review":     "anime2real-review",
    "a2r-ab":         "anime2real-ab",
    "a2r-str":        "anime2real-ref-strength",
    # Video aliases
    "rainy-street":  "video-rainy-street",
    "forest-hiker":  "video-forest-hiker",
    # FLF2V aliases
    "kitchen-coffee":   "flf2v-kitchen-coffee",
    "flf2v-kitchen":    "flf2v-kitchen-coffee",
    "coffee":           "flf2v-kitchen-coffee",
    "studio-turn":      "flf2v-studio-turn",
    "flf2v-portrait":   "flf2v-studio-turn",
    "landscape-dusk":   "flf2v-landscape-dusk",
    "flf2v-landscape":  "flf2v-landscape-dusk",
    "dusk":             "flf2v-landscape-dusk",
    # Profile aliases
    "profile":          "profile-zimage",
    "profile-abc":      "profile-prompt-abc",
    "profile-ab":       "profile-prompt-abc",
    "profile-prompts":  "profile-prompt-abc",
    "profile-flux2":    "profile-flux2-gen",
    # Faceswap aliases
    "crossgender":          "faceswap-crossgender",
    "faceswap-xgender":     "faceswap-crossgender",
    "xgender":              "faceswap-crossgender",
    "crossgender-reverse":  "faceswap-crossgender-reverse",
    "xgender-reverse":      "faceswap-crossgender-reverse",
    # Swap aliases
    "face-swap-sam":        "swap-face",
    "outfit-swap-sam":      "swap-outfit",
    "object-swap-sam":      "swap-object",
    "food-swap-sam":        "swap-food",
    # Expansion aliases
    "outpaint":             "expansion",
    "image-expansion":      "expansion",
    "image-expand":         "expansion",
    "expand":               "expansion",
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
