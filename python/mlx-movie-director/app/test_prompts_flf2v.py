"""Built-in FLF2V (First-Last Frame to Video) test configurations.

Each test defines three prompts:
  - begin_prompt:  T2I prompt for the first keyframe (free generation)
  - end_prompt:    T2I prompt for the last keyframe (uses begin frame as --input)
  - motion_prompt: text describing the transition for FLF2V interpolation

Best practice (proven across 6 experiments):
  1. Generate begin frame: same seed, free T2I generation
  2. Generate end frame:   same seed, DIFFERENT prompt, --input <begin_frame>
     for background consistency
  3. Run FLF2V:            cfg_scale=3.0, stage1_steps=20

Usage:
  run.py image review --self-test kitchen-coffee
  run.py image review --self-test flf2v-studio-turn
"""

FLF2V_TEST_PROMPTS = {
    "kitchen-coffee": {
        "name": "kitchen-coffee",
        "description": (
            "Man in sunlit kitchen makes coffee, moves to table, sits, savours "
            "first sip. Tests: pose change (standing to seated), location change "
            "(counter to table), expression change (neutral to enjoyment)."
        ),
        "begin_prompt": (
            "photorealistic full body shot of a man in his early 30s with short "
            "brown hair, wearing a white linen shirt, standing at a wooden kitchen "
            "counter on the left side of the frame, holding a white ceramic coffee "
            "cup with both hands at mid-chest height, morning sunlight streaming "
            "through a window on the right casting soft shadows, on the counter a "
            "French press and a small potted basil plant and scattered coffee beans, "
            "warm colour palette, shallow depth of field, sharp focus on the man, "
            "eye-level front-facing medium shot, DSLR photograph"
        ),
        "end_prompt": (
            "photorealistic medium shot of a man in his early 30s with short brown "
            "hair, wearing a white linen shirt, seated at a wooden dining table on "
            "the left side of the frame, holding a white ceramic coffee cup in his "
            "right hand raised to his lips, left hand resting on his thigh, leaning "
            "slightly back in the chair, morning sunlight streaming through a window "
            "on the right casting soft shadows, on the table a French press and a "
            "small potted basil plant and scattered coffee beans, warm colour palette, "
            "shallow depth of field, sharp focus on the man, three-quarter profile "
            "from the right camera slightly above eye-level, DSLR photograph"
        ),
        "motion_prompt": (
            "Style: cinematic realism. "
            "A man turns from the kitchen counter and walks to a nearby dining table, "
            "pulling out a chair and sitting down smoothly. He raises the white ceramic "
            "coffee cup to his lips and takes a slow first sip, his expression shifting "
            "from neutral to a warm smile of enjoyment. Morning sunlight shifts gently "
            "across the room. The ceramic cup clinks softly as he briefly sets it on the "
            "table before raising it. His shirt folds shift naturally with the movement. "
            "Smooth, natural human motion with subtle secondary motion throughout."
        ),
        "width": 704,
        "height": 480,
        "seed": 42,
        "frames": 97,
        "fps": 24.0,
        "stage1_steps": 20,
        "stage2_steps": 3,
        "cfg_scale": 3.0,
        "stg_scale": 1.0,
        "t2i_pipeline": "zimage",
        "t2i_steps": 9,
    },

    "studio-turn": {
        "name": "studio-turn",
        "description": (
            "Woman in studio, subtle head turn from frontal to three-quarter profile "
            "with a gentle smile. Tests: minimal motion, character consistency, "
            "expression micro-change."
        ),
        "begin_prompt": (
            "photorealistic portrait of a young woman facing the camera directly, "
            "neutral calm expression, even studio lighting with soft key light from "
            "the left and fill light from the right, dark grey backdrop, shoulders "
            "visible, detailed skin texture, sharp focus on eyes with visible irises, "
            "shallow depth of field, fashion photography, DSLR 85mm"
        ),
        "end_prompt": (
            "photorealistic portrait of a young woman, head turned slightly to her "
            "left showing a three-quarter profile, a gentle warm smile forming on her "
            "lips, even studio lighting with soft key light from the left and fill "
            "light from the right, dark grey backdrop, shoulders visible, detailed "
            "skin texture, sharp focus, shallow depth of field, fashion photography, "
            "DSLR 85mm"
        ),
        "motion_prompt": (
            "Style: cinematic realism. "
            "The woman turns her head slowly from facing the camera to a three-quarter "
            "profile looking to her left. As she turns, a subtle warm smile gradually "
            "appears on her face. Her hair shifts slightly with the movement. The studio "
            "lighting catches a gentle highlight on her cheek as the angle changes. "
            "Slow, deliberate, graceful motion with natural hair secondary motion."
        ),
        "width": 704,
        "height": 480,
        "seed": 42,
        "frames": 65,
        "fps": 24.0,
        "stage1_steps": 20,
        "stage2_steps": 3,
        "cfg_scale": 3.0,
        "stg_scale": 1.0,
        "t2i_pipeline": "zimage",
        "t2i_steps": 9,
    },

    "landscape-dusk": {
        "name": "landscape-dusk",
        "description": (
            "Open wildflower meadow transitioning from golden hour to dusk. Tests: "
            "FLF2V on non-character scenes, lighting and time transition, sky change."
        ),
        "begin_prompt": (
            "photorealistic wide landscape photograph of an open wildflower meadow at "
            "golden hour, warm amber sunlight streaming from the right, tall grass "
            "glowing gold, scattered white and yellow wildflowers in sharp detail, "
            "distant tree line silhouetted against a golden sky, dramatic cumulus "
            "clouds lit gold and orange, deep depth of field, ultra detailed, "
            "DSR landscape photography"
        ),
        "end_prompt": (
            "photorealistic wide landscape photograph of the same meadow at dusk, deep "
            "purple and indigo sky with the last orange glow on the horizon, silhouetted "
            "tree line, wildflowers now soft dark shapes in the blue twilight, stars "
            "beginning to appear in the upper sky, cool blue-purple ambient light, long "
            "exposure feel with subtle star trails, deep depth of field, ultra detailed, "
            "DSLR landscape photography"
        ),
        "motion_prompt": (
            "Style: cinematic realism. "
            "The sun descends toward the horizon, golden light gradually fading to deep "
            "amber and then purple. Shadows lengthen across the meadow as warm tones "
            "shift to cool blues. Wildflower colours dim and soften. The sky transitions "
            "from golden cumulus clouds through a brief pink-coral phase to deep indigo. "
            "First stars appear. A gentle breeze ripples through the tall grass throughout. "
            "Time-lapse feel but smooth and continuous."
        ),
        "width": 704,
        "height": 480,
        "seed": 42,
        "frames": 97,
        "fps": 24.0,
        "stage1_steps": 20,
        "stage2_steps": 3,
        "cfg_scale": 3.0,
        "stg_scale": 1.0,
        "t2i_pipeline": "zimage",
        "t2i_steps": 9,
    },
}


def get_flf2v_test(name: str) -> dict:
    """Look up an FLF2V test config by name. Raises KeyError if not found."""
    return FLF2V_TEST_PROMPTS[name]


def list_flf2v_test_names() -> list[str]:
    """Return ordered list of available FLF2V test names."""
    return list(FLF2V_TEST_PROMPTS.keys())
