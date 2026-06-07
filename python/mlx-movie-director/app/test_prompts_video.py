"""Curated LTX-2.3 test prompts for video generation A/B testing.

Each prompt is optimized for LTX-2.3 best practices:
  - "Style: cinematic realism." declaration at start
  - Specific visual subject details (colors, textures, materials)
  - Present-progressive movement verbs, chronological flow
  - Concrete lighting/atmosphere (not vague terms)
  - No complex camera moves or exaggerated language

Usage:
  run.py video --test-prompt beach-walk
  run.py video --test-prompt beach-walk --variations 4 --ab-params '...'
  run.py video --test-prompt beach-walk --frames 49   # override default frames
"""

VIDEO_TEST_PROMPTS = {
    "beach-walk": {
        "name": "beach-walk",
        "description": (
            "Man walking barefoot along a beach at golden hour, "
            "lighthouse in the distance, waves rolling in"
        ),
        "prompt": (
            "Style: cinematic realism. "
            "A barefoot man in a white tank top and dark shorts, wearing a black waist pack, "
            "walks along a wide sandy beach at golden hour. He raises his right hand in a "
            "carefree wave while his left arm swings naturally. His footprints press into wet "
            "sand as gentle waves roll in, leaving white foam and receding in thin sheets. "
            "In the far left background a tall white lighthouse stands against the sky. "
            "The ocean stretches to the horizon in layered blues and teals, with rolling waves "
            "forming white crests. The sky is a warm gold-to-pale-blue gradient, with soft "
            "cumulus clouds lit from below. Warm side-light from the setting sun falls across "
            "the man and sand. The scene is calm, spacious, and full of life."
        ),
        "defaults": {
            "frames": 97,
            "width": 704,
            "height": 480,
            "fps": 24.0,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
        },
    },

    "rainy-street": {
        "name": "rainy-street",
        "description": (
            "Neon-lit city street at night in heavy rain, "
            "pedestrians with umbrellas, reflections on wet asphalt"
        ),
        "prompt": (
            "Style: cinematic realism. "
            "A narrow city street at night, illuminated by pink and teal neon shop signs "
            "reflecting off wet asphalt. Rain falls steadily in visible streaks, producing "
            "a continuous soft patter on the pavement and a gentle hiss of raindrops hitting "
            "puddles. A woman in a dark coat walks toward the camera under a clear umbrella, "
            "her boots splashing through shallow puddles with each step. Behind her a taxi "
            "passes slowly, its tires sloshing through water with a low engine hum and the "
            "distant hiss of wet brakes. Steam rises from a subway grate on the right with a "
            "faint hissing sound. The ambient soundscape is dominated by steady rainfall, "
            "occasional distant traffic rumble, and the rhythmic splash of footsteps on wet "
            "ground. The scene is moody, dark, and atmospheric with sharp reflections on "
            "every wet surface."
        ),
        "defaults": {
            "frames": 65,
            "width": 704,
            "height": 480,
            "fps": 24.0,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
        },
    },

    "forest-hiker": {
        "name": "forest-hiker",
        "description": (
            "Woman hiking through a sun-dappled forest trail, "
            "light filtering through canopy, peaceful atmosphere"
        ),
        "prompt": (
            "Style: cinematic realism. "
            "A woman in a green fleece jacket and hiking backpack walks along a narrow "
            "forest trail, stepping over exposed roots. Tall moss-covered trees line both "
            "sides, their canopy filtering golden sunlight into scattered beams that shift "
            "across the ground. Small particles of dust and pollen drift through the light "
            "shafts. Ferns and fallen leaves carpet the forest floor. The camera follows "
            "at a steady pace behind her. The atmosphere is cool, quiet, and serene."
        ),
        "defaults": {
            "frames": 97,
            "width": 704,
            "height": 480,
            "fps": 24.0,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
        },
    },

    "snowboard": {
        "name": "snowboard",
        "description": (
            "Snowboarder carving down a fresh powder slope, "
            "spray of snow, mountain backdrop"
        ),
        "prompt": (
            "Style: cinematic realism. "
            "A snowboarder in a red jacket and black helmet carves down an ungroomed "
            "mountain slope covered in fresh powder. The board cuts a clean arc, sending "
            "a fan of white snow spray to the right. Tall mountain peaks rise in the "
            "background under a clear blue sky. The rider shifts weight and transitions "
            "into a second turn, body leaning into the slope. Snow particles sparkle in "
            "bright alpine sunlight. The scene is fast, dynamic, and crisp."
        ),
        "defaults": {
            "frames": 65,
            "width": 704,
            "height": 480,
            "fps": 24.0,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
        },
    },

    "still-life": {
        "name": "still-life",
        "description": (
            "Candle-lit table with a ceramic vase and dried flowers, "
            "gentle flame flicker, warm ambient light"
        ),
        "prompt": (
            "Style: cinematic realism. "
            "A wooden table holds a matte ceramic vase with dried eucalyptus branches. "
            "A single tall candle burns to the right, its flame gently flickering and "
            "casting warm orange light across the vase and table surface. Soft shadows "
            "shift subtly on the wall behind. The background is a dark muted brown. "
            "The scene is almost motionless except for the candle flame dancing and the "
            "faint curl of smoke rising. The mood is quiet, warm, and meditative."
        ),
        "defaults": {
            "frames": 49,
            "width": 704,
            "height": 480,
            "fps": 24.0,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
        },
    },
}


def get_test_prompt(name: str) -> dict:
    """Look up a test prompt by name. Raises KeyError if not found."""
    return VIDEO_TEST_PROMPTS[name]


def list_test_prompt_names() -> list[str]:
    """Return ordered list of available test prompt names."""
    return list(VIDEO_TEST_PROMPTS.keys())
