"""Built-in test prompts for image quality evaluation commands."""

import sys

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
    "anime-idol": {
        "prompt": (
            "anime girl with long wavy auburn hair, wearing a glittering idol costume "
            "with feathered wings and star accessories, holding a microphone, "
            "sparkling stage lights, confident smile, concert stage background, "
            "anime art style, dynamic pose, vibrant colors"
        ),
        "width": 640,
        "height": 960,
    },
    # --- anime2real diversity prompts (female, varied styles) ---
    "anime-chibi": {
        "prompt": (
            "anime girl in chibi super-deformed style with oversized head, huge round "
            "sparkling eyes, tiny body, pastel pink hair in twin pigtails, wearing a "
            "frilly dress with a large ribbon bow, holding a heart-shaped balloon, "
            "cute expression, pastel colors, chibi art style, simple white background"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-historic": {
        "prompt": (
            "anime girl with long straight black hair and bangs, wearing a traditional "
            "red kimono with gold crane pattern, holding a folding fan, standing under "
            "cherry blossom tree with petals falling, classic 90s anime art style, "
            "soft watercolor tones, serene expression, detailed illustration"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-fantasy-fullbody": {
        "prompt": (
            "anime girl with gradient hair from white to light purple, wearing elaborate "
            "fantasy armor with gold filigree and flowing cape, holding a crystal-tipped "
            "staff, standing in an enchanted forest with glowing mushrooms and floating "
            "particles, full body shot, detailed fantasy anime art style, dynamic pose"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-gothic": {
        "prompt": (
            "anime girl with long wavy midnight blue hair, wearing a black gothic lolita "
            "dress with lace trim and corset, holding a black rose, pale skin, red eyes, "
            "standing in a Victorian mansion doorway, candlelight, dark moody atmosphere, "
            "gothic anime art style, mysterious half-smile"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-sideprofile": {
        "prompt": (
            "anime girl with long flowing red hair seen from side profile, wearing a "
            "casual summer dress, looking out a window with soft sunlight streaming in, "
            "wind blowing her hair, side view, wistful expression, soft natural lighting, "
            "anime art style, semi-realistic rendering, gentle atmosphere"
        ),
        "width": 640,
        "height": 960,
    },
    # --- anime2real boundary prompts (male — LoRA is female-trained) ---
    "anime-male-swordsman": {
        "prompt": (
            "anime boy with messy dark green hair and sharp green eyes, wearing a dark "
            "blue samurai outfit with a white haori jacket, holding a katana at rest, "
            "serious determined expression, standing on a hilltop at sunset, wind blowing "
            "his jacket, dramatic lighting, shounen anime art style, detailed illustration"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-male-scholar": {
        "prompt": (
            "anime boy with short neat brown hair and round glasses, wearing a school "
            "uniform with a vest and tie, holding a book, sitting at a desk by a window, "
            "afternoon golden light, gentle intellectual expression, soft realistic anime "
            "art style, detailed eyes with glass reflections"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-male-cyberpunk": {
        "prompt": (
            "anime boy with short spiky white hair and a cybernetic eye implant, wearing "
            "a black techwear jacket with LED strips over a dark turtleneck, standing in "
            "a neon-lit rain-soaked alley at night, holographic screens, cyberpunk anime "
            "art style, intense gaze, cool urban atmosphere"
        ),
        "width": 640,
        "height": 960,
    },
    # --- anime2real edge case prompts (non-human features) ---
    "anime-animal-ears": {
        "prompt": (
            "anime girl with long silver hair and fluffy white cat ears, wearing a casual "
            "oversized sweater, cat tail visible, golden eyes with vertical slit pupils, "
            "sitting on a couch with a cup of hot chocolate, warm cozy room, soft ambient "
            "lighting, kemonomimi anime art style, gentle smile, relaxed pose"
        ),
        "width": 640,
        "height": 960,
    },
    "anime-mecha-pilot": {
        "prompt": (
            "anime girl with short tomboyish orange hair, wearing a form-fitting pilot "
            "plugsuit with glowing circuits, sitting in a mecha cockpit with holographic "
            "displays and control sticks, serious focused expression, mechanical interior "
            "with screens and levers, sci-fi anime art style, dramatic cockpit lighting"
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
    # --- anatomy challenge prompts (stress-test hand/pose/body quality) ---
    "anatomy-hands-complex": {
        "prompt": (
            "photorealistic close-up of a woman's hands holding a small origami crane, "
            "five fingers clearly visible on each hand with distinct knuckles and fingernails, "
            "fingers delicately folding paper with visible tension in the joints, natural skin "
            "texture with fine creases at each finger joint, even studio lighting, macro "
            "photography, ultra sharp focus on fingers"
        ),
        "width": 640,
        "height": 960,
    },
    "anatomy-ballet-action": {
        "prompt": (
            "full body shot of a female ballet dancer in mid-grand jete leap, left leg fully "
            "extended forward with pointed toes, right leg stretched back at 180 degree split, "
            "arms in fifth position with elbows slightly bent, visible muscle definition in "
            "calves and thighs, torso twisted with chest facing camera, photorealistic, detailed "
            "anatomy, dramatic stage lighting, ultra sharp focus"
        ),
        "width": 640,
        "height": 960,
    },
    "anatomy-foreshortening": {
        "prompt": (
            "photorealistic portrait of a man reaching his right hand directly toward the camera "
            "in a foreshortened perspective, hand appearing disproportionately large with clearly "
            "visible five fingers and knuckles, arm receding dramatically into the background with "
            "correct elliptical foreshortening at the elbow joint, head and shoulders smaller in "
            "the distance, natural lighting, wide-angle perspective distortion, ultra sharp focus"
        ),
        "width": 640,
        "height": 960,
    },
    "anatomy-torso-twist": {
        "prompt": (
            "full body shot of a young woman in a dramatic contrapposto pose, torso twisted 45 "
            "degrees to the right while hips face forward, visible oblique muscle engagement, right "
            "arm raised behind her head with elbow bent at a sharp angle, left hand resting on her "
            "hip with five individual fingers visible, weight on left leg with right knee slightly "
            "bent, correct spinal curve, photorealistic, detailed anatomy, studio lighting, "
            "ultra sharp focus"
        ),
        "width": 640,
        "height": 960,
    },
    "anatomy-multi-person": {
        "prompt": (
            "photorealistic image of two young women dancing salsa together, their arms "
            "intertwined with the leader's right hand holding the follower's left hand showing "
            "five fingers each, the follower's right arm draped over the leader's left shoulder, "
            "torsos close together with visible correct torso angles, their legs in mid-step with "
            "knees at different angles, natural club lighting, detailed hands and limb anatomy, "
            "ultra sharp focus"
        ),
        "width": 640,
        "height": 960,
    },
    "anatomy-low-angle": {
        "prompt": (
            "extreme low angle shot looking up at a man standing on a ledge above the camera, "
            "camera at knee height looking upward, visible perspective distortion with legs "
            "appearing large and head appearing small, hands on hips with clearly defined five "
            "fingers and knuckles, jawline and chin visible from below with correct neck anatomy, "
            "dramatic sky background, photorealistic, wide-angle lens distortion, detailed "
            "anatomy, ultra sharp focus"
        ),
        "width": 640,
        "height": 960,
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

    "vae:ultraflux": {
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

    "workflow:portrait": {
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

    "workflow:grain": {
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

    "workflow:face-detail": {
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

    "workflow:landscape": {
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

    "workflow:postprocess": {
        "type": "nomodel",
        "description": "PostProcessChain on synthetic image — no model loading, <1s",
    },

    # -----------------------------------------------------------------------
    # type=t2i: simple T2I comparison across seeds or parameters
    # -----------------------------------------------------------------------

    "t2i:portrait": {
        "type": "t2i",
        "description": "Same portrait prompt, 4 different seeds — baseline diversity check",
        "test_prompt": "portrait",
        "steps": 9,
        "seeds": [42, 123, 777, 999],
    },

    "t2i:landscape": {
        "type": "t2i",
        "description": "Same landscape prompt, 4 different seeds — composition variety check",
        "test_prompt": "landscape",
        "steps": 9,
        "seeds": [42, 123, 777, 999],
    },

    # -----------------------------------------------------------------------
    # type=lora: LoRA adapter A/B comparison (multi-seed paired)
    # -----------------------------------------------------------------------

    "lora:sda-portrait": {
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

    "lora:sda-fullbody": {
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

    "lora:sda-sweep": {
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

    "lora:anime2real": {
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

    "lora:anime2real-ref": {
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

    "lora:anime2real-review": {
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

    "lora:anime2real-pipeline": {
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

    "lora:anime2real-ab": {
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

    "lora:anime2real-ref-strength": {
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

    "lora:anime2real-civitai": {
        "type": "lora-ref",
        "description": (
            "CivitAI workflow comparison: our best (3D Game, EN) vs their Chinese prompt "
            "at various lora_scale/ref_strength combos."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior", "anime-magical", "anime-cyberpunk", "anime-idol"],
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
    # anime2real expanded tests: diversity, male boundary, steps sweep, edge cases
    # -----------------------------------------------------------------------

    "lora:anime2real-diversity": {
        "type": "lora-ref",
        "description": (
            "Diversity validation: CivitAI CN defaults (scale=1.0, str=1.0, 8 steps) "
            "across 10 diverse anime archetypes. Validates that v7 defaults generalize."
        ),
        "test_prompts": [
            "anime-portrait", "anime-warrior", "anime-magical", "anime-cyberpunk", "anime-idol",
            "anime-chibi", "anime-historic", "anime-fantasy-fullbody",
            "anime-gothic", "anime-sideprofile",
        ],
        "seeds": [42],
        "width": 640, "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "ref_count": 1,
        "ref_prompt": "转年轻的亚洲少女写实风格",
        "ref_steps": 8,
        "lora_scale": 1.0,
        "ref_strength": 1.0,
    },

    "lora:anime2real-male": {
        "type": "lora-ref",
        "description": (
            "Male character boundary test: 3 male anime prompts x 3 ref_prompt variants "
            "(CN girl prompt vs CN neutral vs EN photorealistic). "
            "Documents the LoRA's gender limitations."
        ),
        "test_prompts": ["anime-male-swordsman", "anime-male-scholar", "anime-male-cyberpunk"],
        "seeds": [42],
        "width": 640, "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "ref_count": 1,
        "ref_prompt": "转年轻的亚洲少女写实风格",
        "ref_steps": 8,
        "lora_scale": 1.0,
        "ref_strength": 1.0,
        "style_variants": [
            {
                "label": "CN neutral (person)",
                "ref_prompt": "转年轻的亚洲人写实风格",
                "lora_scale": 1.0,
                "ref_steps": 8,
            },
            {
                "label": "EN photorealistic",
                "ref_prompt": (
                    "A photorealistic portrait photograph of the same character, "
                    "detailed realistic skin texture, natural lighting, DSLR camera, "
                    "shallow depth of field, keeping the original hair color, clothing, "
                    "and all character features"
                ),
                "lora_scale": 1.0,
                "ref_steps": 8,
            },
        ],
    },

    "lora:anime2real-steps": {
        "type": "lora-ref",
        "description": (
            "Step count sweep: 4/6/8/12 steps on CivitAI CN defaults. "
            "Tests whether 8 steps is truly optimal or if 6 is sufficient."
        ),
        "test_prompts": ["anime-portrait", "anime-warrior", "anime-cyberpunk"],
        "seeds": [42],
        "width": 640, "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "ref_count": 1,
        "ref_prompt": "转年轻的亚洲少女写实风格",
        "ref_steps": 8,
        "lora_scale": 1.0,
        "ref_strength": 1.0,
        "style_variants": [
            {"label": "4 steps", "ref_steps": 4},
            {"label": "6 steps", "ref_steps": 6},
            {"label": "12 steps", "ref_steps": 12},
        ],
    },

    "lora:anime2real-edge": {
        "type": "lora-ref",
        "description": (
            "Edge case test: animal ears (kemonomimi), mecha pilot (mechanical), "
            "gothic (dark palette), chibi (exaggerated proportions). "
            "Documents how the LoRA handles non-standard anime features."
        ),
        "test_prompts": ["anime-animal-ears", "anime-mecha-pilot", "anime-gothic", "anime-chibi"],
        "seeds": [42],
        "width": 640, "height": 960,
        "lora_path": "anime-girl-turned-into-real-person",
        "ref_count": 1,
        "ref_prompt": "转年轻的亚洲少女写实风格",
        "ref_steps": 8,
        "lora_scale": 1.0,
        "ref_strength": 1.0,
    },

    # -----------------------------------------------------------------------
    # type=profile: Multi-view character profile with VLM view-angle verification
    # -----------------------------------------------------------------------

    "profile:zimage": {
        "type": "profile",
        "description": "ZImage front/back/side three-view — VLM verifies each view angle",
        "views": ["front", "back", "side"],
        "pipeline": "zimage",
        "test_prompt": "portrait",
        "steps": 6,
        "seed": 42,
        "ratio": "standing",
    },

    "profile:prompt-abc": {
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

    "profile:flux2-gen": {
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

    "profile:flux2-abc": {
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

    "controlnet:basic": {
        "type": "controlnet-i2i",
        "description": "I2I + ControlNet (canny): verify V-pose transfer; denoise=1.0 is the smoking gun",
        "mode": "debug",   # "debug" → 1 variation (~3 min); "full" → 8 variations (~25 min)
    },

    "controlnet:sweep": {
        "type": "controlnet-i2i",
        "description": "cnet_active_steps + ctrl_strength sweep to eliminate double-body while keeping V-pose",
        "mode": "controlnet:sweep",   # 6 variations: act8/10/12, str0.4/0.8, 15-20 steps
    },

    "controlnet:sweep2": {
        "type": "controlnet-i2i",
        "description": "ctrl_strength push (0.9-1.0) with fixed act=8 cutoff to achieve full V-pose",
        "mode": "controlnet:sweep2",  # 4 variations: str0.9/1.0 x 20/25 steps, plus act6
    },

    "controlnet:pose": {
        "type": "controlnet-i2i",
        "description": "OpenPose skeleton conditioning: pure pose signal, no clothing bleed",
        "mode": "controlnet:pose",    # 5 variations: openpose x medium/full denoise + canny baseline
    },

    "controlnet:pose2": {
        "type": "controlnet-i2i",
        "description": "OpenPose pose2: dn09 gap fill, act=8 cutoff for dn08/09, act=6 for dn10",
        "mode": "controlnet:pose2",   # 4 variations: tuned from cnet-pose feedback (dn08 partial/bad_hands, dn10 ghost)
    },

    "controlnet:pose3": {
        "type": "controlnet-i2i",
        "description": "OpenPose pose3: ctrl_strength 1.5/2.0 boost, dn=0.95+act10, steps=30",
        "mode": "controlnet:pose3",   # 4 variations: amplify ctrl signal to overcome source latent bias at dn=0.9
    },

    "controlnet:pose4": {
        "type": "controlnet-i2i",
        "description": "Blurred Canny: pre-blur ref before Canny to remove clothing texture edges",
        "mode": "controlnet:pose4",   # 4 variations: blur10/15/20 + str0.8/1.0; blurred Canny = pose edges only
    },

    "controlnet:seed-sweep": {
        "type": "controlnet-i2i",
        "description": "Seed sweep: best pose2 params (dn09+openpose+ALL) across 8 seeds to find fuller V-pose",
        "mode": "controlnet:seed-sweep",   # 8 seeds: 42,43,100,200,300,500,1000,2025
    },

    "controlnet:dual": {
        "type": "controlnet-i2i",
        "description": "Dual-guidance: OpenPose pose + source inpaint anchor at varying mask strengths (seed=43)",
        "mode": "controlnet:dual",   # 5 variants: inpaint_mask = 0.0, 0.2, 0.5, 0.8, 1.0
    },

    "controlnet:clothing": {
        "type": "controlnet-i2i",
        "description": "Clothing-prompt: explicit 'white t-shirt, blue jeans' in prompt — test clothing preservation at dn=0.9",
        "mode": "controlnet:clothing",   # 4 variants: cloth-s43, cloth-s200, cloth-s43-dn08, cloth-s43-base
    },
    "controlnet:spatial-mask": {
        "type": "controlnet-i2i",
        "description": "Spatial arm mask: torso/head anchored to source (mask=0, clothing preserved), arm regions free for ControlNet V-pose (mask=1)",
        "mode": "controlnet:spatial-mask",   # 4 variants: tight/med/loose padding + s200
    },

    "controlnet:arm-erase": {
        "type": "controlnet-i2i",
        "description": "Arm-erase: paint source arms white before VAE encoding inpaint_latent; uniform mask=1 preserves clothing while neutralizing arm-at-sides anchor conflict",
        "mode": "controlnet:arm-erase",      # 4 variants: radius 8/12, mask 1.0/0.7, seed 43/200
    },

    # -----------------------------------------------------------------------
    # type=video: LTX-2.3 T2V generation tests
    # -----------------------------------------------------------------------

    "video:t2v-rainy": {
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

    "video:t2v-forest": {
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

    "video:flf2v-coffee": {
        "type": "flf2v",
        "description": (
            "Man makes coffee in kitchen: standing at counter → seated at table sipping. "
            "Tests pose + location + expression change with character consistency."
        ),
        "flf2v_test": "kitchen-coffee",
    },

    "video:flf2v-turn": {
        "type": "flf2v",
        "description": (
            "Woman in studio: frontal portrait → subtle head turn with gentle smile. "
            "Tests minimal motion, expression micro-change, character fidelity."
        ),
        "flf2v_test": "studio-turn",
    },

    "video:flf2v-dusk": {
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

    "swap:face-crossgender": {
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

    "swap:face-crossgender-reverse": {
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
    "swap:sam-face": {
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
        "sam_prompt": "head",
        "ref_sam_prompt": "head",
        "sam_threshold": 0.3,
        "feather": 15,
        "source_seed": 42,
        "reference_seed": 100,
        "blend": True,
        "blend_strength": 0.75,
        "preserve_aspect_ratio": True,
        "mask_dilate": 40,
        "blend_prompt": (
            "Moody Photography, 22-year-old European woman with shoulder-length wavy "
            "blonde hair, blue eyes, light freckles across nose, in school uniform, "
            "navy blue sailor top, white collar with red ribbon, plaid skirt, "
            "kneeling at desk, warm lamp light from left, cool moonlight from window, "
            "half-body shot from above, looking at camera with confident expression, "
            "hands resting on desk, textbooks and ramune bottle on desk."
        ),
    },
    "swap:sam-outfit": {
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
        "blend_strength": 0.5,
        "preserve_aspect_ratio": True,
        "mask_dilate": 30,
        "blend_prompt": (
            "Fashion photography, young woman standing in a bright studio, "
            "wearing an elegant floor-length red evening gown, silk fabric, "
            "fitted bodice with off-shoulder neckline, flowing skirt, "
            "full body shot, neutral gray background, even studio lighting, "
            "natural pose, photorealistic."
        ),
    },
    "swap:sam-object": {
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
    "swap:sam-food": {
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
        "blend_strength": 0.65,
        "preserve_aspect_ratio": True,
        "mask_dilate": 30,
        "blend_prompt": (
            "Food photography, overhead shot of a white plate with a colorful "
            "macaron tower in pastel pink, green, and lavender, "
            "a fork beside it, dark wooden table, scattered cocoa powder, "
            "warm ambient lighting, photorealistic."
        ),
    },

    # ------------------------------------------------------------------
    # Swap variant tests — more examples per category for broader coverage
    # ------------------------------------------------------------------

    "swap:sam-face-2": {
        "type": "swap",
        "description": (
            "SAM3 face swap: replace Asian man with European man — "
            "tests cross-gender same-race head swap"
        ),
        "source_prompt": (
            "Moody Photography, 25-year-old Asian man in casual black t-shirt, "
            "short black hair, sitting at a cafe table near a window, "
            "afternoon golden light, coffee cup on table, "
            "half-body shot, looking at camera with calm expression, "
            "shallow depth of field, photorealistic."
        ),
        "reference_prompt": (
            "Moody Photography, close-up portrait of a 28-year-old European man, "
            "short brown hair, light stubble beard, strong jawline, "
            "green eyes, direct confident gaze, "
            "warm golden hour side lighting, film grain texture, "
            "shallow depth of field, neutral background."
        ),
        "sam_prompt": "head",
        "ref_sam_prompt": "head",
        "sam_threshold": 0.3,
        "feather": 15,
        "source_seed": 150,
        "reference_seed": 250,
        "blend": True,
        "blend_strength": 0.75,
        "preserve_aspect_ratio": True,
        "mask_dilate": 40,
        "blend_prompt": (
            "Moody Photography, 28-year-old European man with short brown hair, "
            "light stubble beard, strong jawline, green eyes, in casual black t-shirt, "
            "sitting at a cafe table near a window, afternoon golden light, "
            "coffee cup on table, half-body shot, looking at camera with calm expression, "
            "shallow depth of field, photorealistic."
        ),
    },

    "swap:sam-food-2": {
        "type": "swap",
        "description": (
            "SAM3 food swap: replace donut with croissant — "
            "tests small round→rectangular food swap"
        ),
        "source_prompt": (
            "Food photography, overhead shot of a white plate with a glazed "
            "chocolate donut with sprinkles, a cup of black coffee beside it, "
            "marble countertop, scattered cocoa powder, "
            "soft morning light, photorealistic."
        ),
        "reference_prompt": (
            "Food photography, overhead shot of a white plate with a freshly baked "
            "butter croissant, golden flaky layers, "
            "clean white background, soft studio lighting, photorealistic."
        ),
        "sam_prompt": "donut",
        "ref_sam_prompt": "croissant",
        "sam_threshold": 0.3,
        "feather": 15,
        "source_seed": 300,
        "reference_seed": 500,
        "source_width": 960,
        "source_height": 640,
        "reference_width": 960,
        "reference_height": 640,
        "blend": True,
        "blend_strength": 0.65,
        "preserve_aspect_ratio": True,
        "mask_dilate": 30,
        "blend_prompt": (
            "Food photography, overhead shot of a white plate with a freshly baked "
            "butter croissant with golden flaky layers, "
            "a cup of black coffee beside it, marble countertop, "
            "scattered cocoa powder, soft morning light, photorealistic."
        ),
    },

    "swap:sam-object-2": {
        "type": "swap",
        "description": (
            "SAM3 object swap: replace potted plant with desk lamp — "
            "tests organic→geometric shape swap (extreme shape difference)"
        ),
        "source_prompt": (
            "Cozy desk scene, wooden desk with an open sketchbook, colored pencils, "
            "a small potted succulent plant in a terracotta pot placed in the center, "
            "warm afternoon light from window, scattered eraser shavings, "
            "overhead view, photorealistic, detailed."
        ),
        "reference_prompt": (
            "Product photography, a vintage brass desk lamp with adjustable arm, "
            "green metal shade, warm glowing bulb, "
            "clean white background, studio lighting, photorealistic."
        ),
        "sam_prompt": "plant",
        "ref_sam_prompt": "lamp",
        "sam_threshold": 0.25,
        "feather": 15,
        "source_seed": 400,
        "reference_seed": 600,
        "source_width": 960,
        "source_height": 640,
        "reference_width": 960,
        "reference_height": 640,
        "blend": True,
        "blend_strength": 0.8,
        "preserve_aspect_ratio": True,
        "mask_dilate": 50,
        "blend_prompt": (
            "Cozy desk scene, wooden desk with an open sketchbook, colored pencils, "
            "a vintage brass desk lamp with adjustable arm and green metal shade, "
            "warm glowing bulb, placed in the center of the desk, "
            "warm afternoon light from window, scattered eraser shavings, "
            "overhead view, photorealistic, detailed."
        ),
    },

    # ── Swap meta-test ─────────────────────────────────────────────────
    "swap:sam-all": {
        "type": "swap:sam-all",
        "description": "Run ALL swap self-tests sequentially, one HTML review",
        "tests": [
            "swap-face", "swap-face-2",
            "swap-object", "swap-object-2",
            "swap-food", "swap-food-2",
            "swap-outfit",
        ],
    },

    # ------------------------------------------------------------------
    # Expansion / outpaint self-tests (Flux2 Klein latent-mask outpaint)
    # ------------------------------------------------------------------
    "expansion:basic": {
        "type": "expansion:basic",
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
        "overlap": 128,
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

    # A/B sweep: overlap × feather × steps — find optimal seam quality
    "expansion:sweep": {
        "type": "expansion:basic",
        "description": (
            "Expansion A/B sweep: overlap × feather × steps. "
            "Fixed source + expand left/right 512px — vary overlap (64/96/128), "
            "feather (96/128), steps (8/12). VLM seam review."
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
        "longest": 1024,
        "feather": 96,
        "overlap": 96,
        "steps": 8,
        "configs": [
            # Baseline (current best)
            {
                "label": "A-ov96-ft96-st8",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 96, "feather": 96, "steps": 8,
                "prompt": (
                    "Extend the alley scene sideways: more cobblestone street, "
                    "brick buildings, streetlamps and soft dusk light. "
                    "Seamless, photorealistic."
                ),
            },
            # Wider overlap
            {
                "label": "B-ov128-ft96-st8",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 128, "feather": 96, "steps": 8,
                "prompt": (
                    "Extend the alley scene sideways: more cobblestone street, "
                    "brick buildings, streetlamps and soft dusk light. "
                    "Seamless, photorealistic."
                ),
            },
            # Wider overlap + wider feather
            {
                "label": "C-ov128-ft128-st8",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 128, "feather": 128, "steps": 8,
                "prompt": (
                    "Extend the alley scene sideways: more cobblestone street, "
                    "brick buildings, streetlamps and soft dusk light. "
                    "Seamless, photorealistic."
                ),
            },
            # More steps for detail
            {
                "label": "D-ov96-ft96-st12",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 96, "feather": 96, "steps": 12,
                "prompt": (
                    "Extend the alley scene sideways: more cobblestone street, "
                    "brick buildings, streetlamps and soft dusk light. "
                    "Seamless, photorealistic."
                ),
            },
            # Best combo: wider overlap + more steps
            {
                "label": "E-ov128-ft128-st12",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 128, "feather": 128, "steps": 12,
                "prompt": (
                    "Extend the alley scene sideways: more cobblestone street, "
                    "brick buildings, streetlamps and soft dusk light. "
                    "Seamless, photorealistic."
                ),
            },
        ],
    },

    # Multi-source expansion: diverse scenes × shared configs → robust feedback
    "expansion:multi": {
        "type": "expansion:basic",
        "description": (
            "Expansion multi-scene: 4 diverse sources × 2 expansion configs. "
            "Review seam quality across landscapes, portraits, food, and abstract "
            "scenes in one session."
        ),
        "sources": [
            {
                "label": "portrait",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
            },
            {
                "label": "landscape",
                "source_prompt": (
                    "Landscape photography, misty mountain lake at dawn, golden light "
                    "reflecting on still water, pine trees silhouetted on the far shore, "
                    "dramatic cloud formations, wide-angle view, photorealistic, 8k."
                ),
                "source_seed": 100,
            },
            {
                "label": "food",
                "source_prompt": (
                    "Food photography, overhead shot of a white plate with a glazed "
                    "chocolate donut with sprinkles, a cup of black coffee beside it, "
                    "marble countertop, scattered cocoa powder, soft morning light, "
                    "photorealistic."
                ),
                "source_seed": 300,
            },
            {
                "label": "abstract",
                "source_prompt": (
                    "Abstract digital art, swirling liquid metal textures in silver and "
                    "deep blue, organic flowing shapes with iridescent highlights, "
                    "dark background, high contrast, detailed, 8k."
                ),
                "source_seed": 77,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 128,
        "steps": 8,
        "configs": [
            {
                "label": "expand-LR",
                "mode": "expand",
                "dirs": "left,right",
                "pixels": 512,
                "seed": 42,
                "prompt": (
                    "Seamlessly extend the scene beyond the original frame. Maintain "
                    "consistent lighting, color grading, perspective, and texture."
                ),
            },
            {
                "label": "ratio-16x9",
                "mode": "ratio",
                "ratio": "16:9",
                "seed": 42,
                "prompt": (
                    "Widen to a cinematic frame, extending the scene naturally with "
                    "consistent lighting and perspective. Seamless, photorealistic."
                ),
            },
        ],
    },

    # ------------------------------------------------------------------
    # Comprehensive expansion: directional + aspect + ref_strength + non-square
    # 4 sources × 8 configs = 32 runs
    # ------------------------------------------------------------------
    "expansion:full": {
        "type": "expansion:basic",
        "description": (
            "Comprehensive expansion: 4 diverse sources (square, landscape, portrait, edge-subject) "
            "× 8 configs (horizontal, vertical, all-4, single-dir, 16:9, 21:9, 9:16, ref_str=0.5). "
            "Covers directional diversity, non-square sources, diverse aspect ratios, "
            "and ref_strength variation in one review."
        ),
        "sources": [
            {
                "label": "portrait-sq",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
                "source_width": 1024,
                "source_height": 1024,
            },
            {
                "label": "landscape-hd",
                "source_prompt": (
                    "Landscape photography, misty mountain lake at dawn, golden light "
                    "reflecting on still water, pine trees silhouetted on the far shore, "
                    "dramatic cloud formations, wide-angle view, photorealistic, 8k."
                ),
                "source_seed": 100,
                "source_width": 1280,
                "source_height": 720,
            },
            {
                "label": "portrait-tall",
                "source_prompt": (
                    "Fashion photography, full-body shot of a young woman in an elegant "
                    "black evening gown, standing on a grand marble staircase, warm "
                    "chandelier light, soft shadows, sharp details, photorealistic."
                ),
                "source_seed": 200,
                "source_width": 640,
                "source_height": 960,
            },
            {
                "label": "edge-subject",
                "source_prompt": (
                    "Photograph of a cyclist leaning into a sharp right turn on a wet "
                    "mountain road, subject positioned near the right edge of frame, "
                    "green forest left side, dramatic motion blur on wheels, photorealistic."
                ),
                "source_seed": 300,
                "source_width": 1024,
                "source_height": 1024,
            },
        ],
        "longest": 1024,
        "feather": 96,
        "overlap": 128,
        "steps": 8,
        "configs": [
            # Directional diversity
            {
                "label": "expand-LR",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42,
                "prompt": (
                    "Seamlessly extend the scene horizontally. Maintain consistent "
                    "lighting, color grading, perspective, and texture."
                ),
            },
            {
                "label": "expand-UD",
                "mode": "expand", "dirs": "up,down", "pixels": 384,
                "seed": 42,
                "prompt": (
                    "Extend the scene vertically upward and downward. Maintain consistent "
                    "lighting, perspective, and atmosphere."
                ),
            },
            {
                "label": "expand-all4",
                "mode": "expand", "dirs": "left,right,up,down", "pixels": 384,
                "seed": 42,
                "prompt": (
                    "Expand the scene in all directions equally. Maintain consistent "
                    "lighting, perspective, and texture throughout."
                ),
            },
            {
                "label": "expand-right",
                "mode": "expand", "dirs": "right", "pixels": 512,
                "seed": 42,
                "prompt": (
                    "Extend the scene to the right. Continue the environment with "
                    "consistent lighting and perspective."
                ),
            },
            # Diverse target aspects
            {
                "label": "ratio-16x9",
                "mode": "ratio", "ratio": "16:9",
                "seed": 42,
                "prompt": (
                    "Widen to cinematic 16:9 frame. Extend naturally with consistent "
                    "lighting and perspective. Seamless, photorealistic."
                ),
            },
            {
                "label": "ratio-21x9",
                "mode": "ratio", "ratio": "21:9",
                "seed": 42,
                "prompt": (
                    "Expand to ultrawide 21:9 cinematic frame. Extend the environment "
                    "with consistent lighting, color, and depth."
                ),
            },
            {
                "label": "ratio-9x16",
                "mode": "ratio", "ratio": "9:16",
                "seed": 42,
                "prompt": (
                    "Convert to vertical 9:16 format. Extend upward and downward with "
                    "consistent scene content, lighting, and perspective."
                ),
            },
            # ref_strength exploration
            {
                "label": "ref-str-0.5",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "ref_strength": 0.5,
                "prompt": (
                    "Extend the scene sideways with moderate creative freedom. Maintain "
                    "overall coherence while allowing some content variation."
                ),
            },
        ],
    },

    # ------------------------------------------------------------------
    # Ref strength sweep: 2 sources × 5 strength values
    # ------------------------------------------------------------------
    "expansion:ref-strength": {
        "type": "expansion:basic",
        "description": (
            "Ref strength sweep: 1.0 (default) / 0.8 / 0.6 / 0.4 / 0.2 — "
            "fixed expand left+right 512px on 2 diverse sources. "
            "Finds the coherence-vs-creativity sweet spot."
        ),
        "sources": [
            {
                "label": "alley-portrait",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
            },
            {
                "label": "zen-garden",
                "source_prompt": (
                    "Photography of a Japanese zen garden in autumn, raked sand patterns, "
                    "maple trees with red and gold leaves, stone pathway, morning mist, "
                    "serene atmosphere, wide view, photorealistic, 8k."
                ),
                "source_seed": 150,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 128,
        "steps": 8,
        "configs": [
            {
                "label": "str-1.0",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "ref_strength": 1.0,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "str-0.8",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "ref_strength": 0.8,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "str-0.6",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "ref_strength": 0.6,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "str-0.4",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "ref_strength": 0.4,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "str-0.2",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "ref_strength": 0.2,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
        ],
    },

    # ------------------------------------------------------------------
    # Edge-case content: stress-test seam quality on difficult boundaries
    # 4 sources × 3 configs = 12 runs
    # ------------------------------------------------------------------
    "expansion:edge": {
        "type": "expansion:basic",
        "description": (
            "Content edge-case expansion: subject at frame edge, repeating brick pattern, "
            "tree silhouette against sunset, neon sign text — stress-tests seam quality "
            "on the hardest possible content boundaries."
        ),
        "sources": [
            {
                "label": "subject-right-edge",
                "source_prompt": (
                    "Photograph of a skateboarder mid-air doing an ollie, subject "
                    "positioned at the extreme right edge of the frame with only a sliver "
                    "of background visible on the right, empty skatepark on the left, "
                    "golden hour backlight, motion freeze, photorealistic."
                ),
                "source_seed": 600,
            },
            {
                "label": "brick-pattern",
                "source_prompt": (
                    "Close-up photograph of an old red brick wall with uniform mortar "
                    "lines, some bricks chipped and weathered, consistent repeating "
                    "geometric pattern, sharp detail, architectural texture, photorealistic."
                ),
                "source_seed": 700,
            },
            {
                "label": "silhouette-sunset",
                "source_prompt": (
                    "Photograph of a lone tree silhouette against a vivid orange and "
                    "magenta sunset sky, extreme contrast between the completely black "
                    "tree shape and bright saturated sky, water reflection below, "
                    "photorealistic, dramatic."
                ),
                "source_seed": 800,
            },
            {
                "label": "neon-sign",
                "source_prompt": (
                    "Night photography of a glowing neon sign reading 'OPEN' in bright "
                    "pink and blue tubes, mounted on a dark brick wall, reflections on "
                    "wet pavement below, sharp detail on letter edges, high contrast, "
                    "photorealistic."
                ),
                "source_seed": 900,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 128,
        "steps": 8,
        "configs": [
            {
                "label": "expand-right",
                "mode": "expand", "dirs": "right", "pixels": 512,
                "seed": 42,
                "prompt": (
                    "Extend the scene to the right. Continue the environment naturally "
                    "with consistent lighting and texture."
                ),
            },
            {
                "label": "expand-all4",
                "mode": "expand", "dirs": "left,right,up,down", "pixels": 384,
                "seed": 42,
                "prompt": (
                    "Expand the scene in all directions. Continue all patterns, textures, "
                    "and environment consistently."
                ),
            },
            {
                "label": "ratio-16x9",
                "mode": "ratio", "ratio": "16:9",
                "seed": 42,
                "prompt": (
                    "Convert to 16:9 cinematic frame. Extend naturally with consistent "
                    "lighting, color, and texture."
                ),
            },
        ],
    },

    # ===================================================================
    # Expansion parameter finetuning sweeps (single-variable isolation)
    # ===================================================================

    "expansion:overlap": {
        "type": "expansion:basic",
        "description": (
            "Overlap sweep: 32/64/96/128/160/192 — "
            "fixed feather=96, steps=8, expand left+right 512px on 2 sources. "
            "Finds the optimal re-injection width for seamless seams."
        ),
        "sources": [
            {
                "label": "alley-portrait",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
            },
            {
                "label": "zen-garden",
                "source_prompt": (
                    "Photography of a Japanese zen garden in autumn, raked sand patterns, "
                    "maple trees with red and gold leaves, stone pathway, morning mist, "
                    "serene atmosphere, wide view, photorealistic, 8k."
                ),
                "source_seed": 150,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 96,
        "steps": 8,
        "configs": [
            {
                "label": "ov32",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 32,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ov64",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 64,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ov96",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 96,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ov128",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 128,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ov160",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 160,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ov192",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 192,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
        ],
    },

    "expansion:feather": {
        "type": "expansion:basic",
        "description": (
            "Feather sweep: 0/32/64/96/128/192 — "
            "fixed overlap=192, steps=8, expand left+right 512px on 2 sources. "
            "Finds the optimal mask softness for seamless transitions. "
            "overlap=192 ensures feather values up to 192 stay within the re-gen zone."
        ),
        "sources": [
            {
                "label": "alley-portrait",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
            },
            {
                "label": "zen-garden",
                "source_prompt": (
                    "Photography of a Japanese zen garden in autumn, raked sand patterns, "
                    "maple trees with red and gold leaves, stone pathway, morning mist, "
                    "serene atmosphere, wide view, photorealistic, 8k."
                ),
                "source_seed": 150,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 192,
        "steps": 8,
        "configs": [
            {
                "label": "ft0",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "feather": 0,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ft32",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "feather": 32,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ft64",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "feather": 64,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ft96",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "feather": 96,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ft128",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "feather": 128,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "ft192",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "feather": 192,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
        ],
    },

    "expansion:steps": {
        "type": "expansion:basic",
        "description": (
            "Steps sweep: 4/6/8/12/16 — "
            "fixed overlap=128, feather=96, expand left+right 512px on 2 sources. "
            "Finds the quality/speed sweet spot for denoising steps."
        ),
        "sources": [
            {
                "label": "alley-portrait",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
            },
            {
                "label": "zen-garden",
                "source_prompt": (
                    "Photography of a Japanese zen garden in autumn, raked sand patterns, "
                    "maple trees with red and gold leaves, stone pathway, morning mist, "
                    "serene atmosphere, wide view, photorealistic, 8k."
                ),
                "source_seed": 150,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 128,
        "steps": 8,
        "configs": [
            {
                "label": "st4",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "steps": 4,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "st6",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "steps": 6,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "st8",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "steps": 8,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "st12",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "steps": 12,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "st16",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "steps": 16,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
        ],
    },

    "expansion:pixels": {
        "type": "expansion:basic",
        "description": (
            "Pixels sweep: 256/384/512/768/1024 — "
            "fixed overlap=128, feather=96, steps=8, expand left+right on 2 sources. "
            "Finds the maximum safe expansion per pass before quality degrades."
        ),
        "sources": [
            {
                "label": "alley-portrait",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
            },
            {
                "label": "zen-garden",
                "source_prompt": (
                    "Photography of a Japanese zen garden in autumn, raked sand patterns, "
                    "maple trees with red and gold leaves, stone pathway, morning mist, "
                    "serene atmosphere, wide view, photorealistic, 8k."
                ),
                "source_seed": 150,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 128,
        "steps": 8,
        "configs": [
            {
                "label": "px256",
                "mode": "expand", "dirs": "left,right", "pixels": 256,
                "seed": 42,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "px384",
                "mode": "expand", "dirs": "left,right", "pixels": 384,
                "seed": 42,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "px512",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "px768",
                "mode": "expand", "dirs": "left,right", "pixels": 768,
                "seed": 42,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "px1024",
                "mode": "expand", "dirs": "left,right", "pixels": 1024,
                "seed": 42,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
        ],
    },

    "expansion:defaults-ab": {
        "type": "expansion:basic",
        "description": (
            "Expansion defaults A/B: current defaults vs proposed optimal set. "
            "Run AFTER the individual sweeps to validate the final tuning. "
            "Column A: overlap=128, feather=96, steps=8, pixels=512 (current). "
            "Column B: TBD — fill in optimal values from sweep results."
        ),
        "sources": [
            {
                "label": "alley-portrait",
                "source_prompt": (
                    "Moody Photography, a young woman in a red coat standing in a narrow "
                    "cobblestone alley at dusk, warm streetlamp glow, wet reflections, "
                    "half-body shot, looking toward camera, cinematic, photorealistic, "
                    "shallow depth of field."
                ),
                "source_seed": 42,
            },
            {
                "label": "zen-garden",
                "source_prompt": (
                    "Photography of a Japanese zen garden in autumn, raked sand patterns, "
                    "maple trees with red and gold leaves, stone pathway, morning mist, "
                    "serene atmosphere, wide view, photorealistic, 8k."
                ),
                "source_seed": 150,
            },
        ],
        "source_width": 1024,
        "source_height": 1024,
        "longest": 1024,
        "feather": 96,
        "overlap": 128,
        "steps": 8,
        "configs": [
            {
                "label": "A-current-defaults",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42, "overlap": 128, "feather": 96, "steps": 8,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
            {
                "label": "B-proposed-optimal",
                "mode": "expand", "dirs": "left,right", "pixels": 512,
                "seed": 42,
                # TODO: Fill in optimal values from sweep results
                "overlap": 128, "feather": 96, "steps": 8,
                "prompt": (
                    "Extend the scene sideways. Maintain consistent lighting, "
                    "color grading, perspective, and texture. Seamless, photorealistic."
                ),
            },
        ],
    },

    # -----------------------------------------------------------------------
    # type=lora-sweep: Anatomy challenge — stress-test anatomy/pose quality
    # -----------------------------------------------------------------------

    "lora:anatomy": {
        "type": "lora-sweep",
        "description": (
            "Anatomy challenge: baseline vs klein-slider-anatomy across 6 stress-test "
            "prompts targeting hand detail, dynamic poses, foreshortening, torso rotation, "
            "multi-person interaction, and unusual camera angles"
        ),
        "pipeline": "flux2-klein",
        "lora_scale": 1.0,
        "seeds": [42, 777],
        "steps": 4,
        "test_prompts": [
            "anatomy-hands-complex",
            "anatomy-ballet-action",
            "anatomy-foreshortening",
            "anatomy-torso-twist",
            "anatomy-multi-person",
            "anatomy-low-angle",
        ],
        "variants": [
            {"label": "Baseline", "lora_path": None},
            {"label": "Anatomy Fix", "lora_path": "klein-slider-anatomy"},
        ],
    },
}

# ---------------------------------------------------------------------------
# Deprecated test names (old canonical names kept as aliases)
# ---------------------------------------------------------------------------
_DEPRECATED_NAMES = {
    "anatomy-challenge",
    "anime2real",
    "anime2real-ab",
    "anime2real-civitai-compare",
    "anime2real-diversity",
    "anime2real-edge-cases",
    "anime2real-male-boundary",
    "anime2real-pipeline",
    "anime2real-ref",
    "anime2real-ref-strength",
    "anime2real-review",
    "anime2real-steps-sweep",
    "arm-erase",
    "basic-controlnet",
    "clothing-prompt",
    "cnet-pose",
    "cnet-pose2",
    "cnet-pose3",
    "cnet-pose4",
    "cnet-sweep",
    "cnet-sweep2",
    "dual-guidance",
    "expansion",
    "expansion-comprehensive",
    "expansion-defaults-ab",
    "expansion-edge-cases",
    "expansion-feather-sweep",
    "expansion-multi",
    "expansion-overlap-sweep",
    "expansion-pixels-sweep",
    "expansion-ref-strength",
    "expansion-steps-sweep",
    "expansion-sweep",
    "face-detail-ab",
    "faceswap-crossgender",
    "faceswap-crossgender-reverse",
    "flf2v-kitchen-coffee",
    "flf2v-landscape-dusk",
    "flf2v-studio-turn",
    "grain-sweep",
    "landscape-post",
    "landscape-seeds",
    "portrait-full",
    "portrait-seeds",
    "profile-flux2-abc",
    "profile-flux2-gen",
    "profile-prompt-abc",
    "profile-zimage",
    "seed-sweep",
    "spatial-mask",
    "swap-all",
    "swap-face",
    "swap-face-2",
    "swap-food",
    "swap-food-2",
    "swap-object",
    "swap-object-2",
    "swap-outfit",
    "ultraflux",
    "video-forest-hiker",
    "video-rainy-street",
    "workflow-postprocess",
    "zit-sda-v1",
    "zit-sda-v1-fullbody",
    "zit-sda-v1-sweep",
}
# ---------------------------------------------------------------------------
# Unified alias table
# ---------------------------------------------------------------------------

_ALL_TESTS_ALIASES = {
    # Deprecated canonical names (moved to namespace:name format)
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

    # VAE test aliases
    "vae-ultra-flux": "vae:ultraflux",
    "vae-ultraflux": "vae:ultraflux",
    "ultra-flux": "vae:ultraflux",
    "ultraflux-ae": "vae:ultraflux",
    # Workflow test aliases
    "full": "workflow:portrait",
    "portrait": "workflow:portrait",
    "grain": "workflow:grain",
    "faces": "workflow:face-detail",
    "landscape": "workflow:landscape",
    "post": "workflow:landscape",
    # T2I alias
    "seeds": "t2i:portrait",
    # LoRA test aliases
    "sda": "lora:sda-portrait",
    "sda-v1": "lora:sda-portrait",
    "sda-test": "lora:sda-portrait",
    "sda-fullbody": "lora:sda-fullbody",
    "sda-v1-fullbody": "lora:sda-fullbody",
    "sda-sweep": "lora:sda-sweep",
    # LoRA I2I aliases
    "anime-girl": "lora:anime2real",
    "anime2real-lora": "lora:anime2real",
    "anything2real": "lora:anime2real",
    # LoRA Ref aliases
    "anime2real-v2": "lora:anime2real-ref",
    "a2r-ref": "lora:anime2real-ref",
    "ref-lora": "lora:anime2real-ref",
    "anime2real-v3": "lora:anime2real-pipeline",
    "a2r-pipe": "lora:anime2real-pipeline",
    "a2r-review": "lora:anime2real-review",
    "a2r-ab": "lora:anime2real-ab",
    "a2r-str": "lora:anime2real-ref-strength",
    # anime2real expanded test aliases
    "a2r-diversity": "lora:anime2real-diversity",
    "a2r-male": "lora:anime2real-male",
    "a2r-steps": "lora:anime2real-steps",
    "a2r-edges": "lora:anime2real-edge",
    # Video aliases
    "rainy-street": "video:t2v-rainy",
    "forest-hiker": "video:t2v-forest",
    # FLF2V aliases
    "kitchen-coffee": "video:flf2v-coffee",
    "flf2v-kitchen": "video:flf2v-coffee",
    "coffee": "video:flf2v-coffee",
    "studio-turn": "video:flf2v-turn",
    "flf2v-portrait": "video:flf2v-turn",
    "landscape-dusk": "video:flf2v-dusk",
    "flf2v-landscape": "video:flf2v-dusk",
    "dusk": "video:flf2v-dusk",
    # Profile aliases
    "profile": "profile:zimage",
    "profile-abc": "profile:prompt-abc",
    "profile-ab": "profile:prompt-abc",
    "profile-prompts": "profile:prompt-abc",
    "profile-flux2": "profile:flux2-gen",
    # Faceswap aliases
    "crossgender": "swap:face-crossgender",
    "faceswap-xgender": "swap:face-crossgender",
    "xgender": "swap:face-crossgender",
    "crossgender-reverse": "swap:face-crossgender-reverse",
    "xgender-reverse": "swap:face-crossgender-reverse",
    # Swap aliases
    "face-swap-sam": "swap:sam-face",
    "face-swap-sam-2": "swap:sam-face-2",
    "outfit-swap-sam": "swap:sam-outfit",
    "object-swap-sam": "swap:sam-object",
    "object-swap-sam-2": "swap:sam-object-2",
    "food-swap-sam": "swap:sam-food",
    "food-swap-sam-2": "swap:sam-food-2",
    # Expansion aliases
    "outpaint": "expansion:basic",
    "image-expansion": "expansion:basic",
    "image-expand": "expansion:basic",
    "expand": "expansion:basic",
    "expansion-sweep": "expansion:sweep",
    "expand-sweep": "expansion:sweep",
    "sweep": "expansion:sweep",
    "expansion-multi": "expansion:multi",
    "expand-multi": "expansion:multi",
    "multi": "expansion:multi",
    # Comprehensive expansion aliases
    "comprehensive": "expansion:full",
    "expand-full": "expansion:full",
    "expansion-full": "expansion:full",
    # Ref strength sweep aliases
    "expansion-ref": "expansion:ref-strength",
    "expand-ref": "expansion:ref-strength",
    "ref-sweep": "expansion:ref-strength",
    # Edge cases aliases
    "expansion-edges": "expansion:edge",
    "expand-edges": "expansion:edge",
    "edges": "expansion:edge",
    # Parameter finetuning sweep aliases
    "expand-overlap": "expansion:overlap",
    "overlap-sweep": "expansion:overlap",
    "expand-feather": "expansion:feather",
    "feather-sweep": "expansion:feather",
    "expand-steps": "expansion:steps",
    "steps-sweep": "expansion:steps",
    "expand-pixels": "expansion:pixels",
    "pixels-sweep": "expansion:pixels",
    # Defaults A/B validation
    "expand-ab": "expansion:defaults-ab",
    "defaults-ab": "expansion:defaults-ab",
    # Anatomy challenge aliases
    "anatomy": "lora:anatomy",
    "anatomy-test": "lora:anatomy",
    "klein-anatomy": "lora:anatomy",
}


def get_test(name: str) -> dict:
    """Unified lookup across all test types. Returns the test config dict."""
    # Deprecation warning for old-style test names
    if name in _DEPRECATED_NAMES:
        new_name = _ALL_TESTS_ALIASES.get(name, name)
        print(f"\u26a0  DEPRECATED: self-test '{name}' is deprecated. "
              f"Use '{new_name}' instead.", file=sys.stderr)
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
