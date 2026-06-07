"""Curated LTX-2.3 test prompts for video generation A/B testing.

Each prompt is optimized for LTX-2.3 best practices:
  - "Style: cinematic realism." declaration at start
  - Specific visual subject details (colors, textures, materials)
  - Present-progressive movement verbs, chronological flow
  - Concrete lighting/atmosphere (not vague terms)
  - No complex camera moves or exaggerated language
  - **Interleaved audio descriptions** — sound cues embedded alongside
    visual events (per official LTX guidance), not appended at the end.
    Include material + acoustic descriptors ("echoing footsteps on stone",
    "crackling fire with distant wind").

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
            "walks along a wide sandy beach at golden hour, each footstep crunching softly on "
            "fine wet sand. He raises his right hand in a carefree wave while his left arm "
            "swings naturally. Gentle waves roll in with a low rhythmic whoosh and recede with "
            "a faint hiss of water retreating over sand, leaving white foam. The waves produce "
            "a continuous soft roar in the background. In the far left background a tall white "
            "lighthouse stands against the sky. Distant seagull calls echo occasionally. "
            "The ocean stretches to the horizon in layered blues and teals, with rolling waves "
            "forming white crests that crash with a muffled boom. A warm breeze carries the "
            "sound of wind rustling through beach grass behind the camera. The sky is a warm "
            "gold-to-pale-blue gradient, with soft cumulus clouds lit from below. Warm "
            "side-light from the setting sun falls across the man and sand. The scene is calm, "
            "spacious, and full of life."
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
            "buzzing faintly and reflecting off wet asphalt. Rain falls steadily in visible "
            "streaks, producing a continuous soft patter on the pavement and a gentle hiss of "
            "raindrops hitting puddles. Neon signs hum and crackle with a low electrical buzz. "
            "A woman in a dark coat walks toward the camera under a clear umbrella, her boots "
            "splashing through shallow puddles with a crisp wet slap on each step. Behind her "
            "a taxi passes slowly, its tires sloshing through water with a low engine rumble "
            "and the distant hiss of wet brakes. Steam rises from a subway grate on the right "
            "with a faint hissing sound. The ambient soundscape is dominated by steady rainfall "
            "hitting different surfaces — metal awnings producing a tinny drumming, glass "
            "windows a flat patter, and wet asphalt a muffled soak. Occasional distant traffic "
            "rumble echoes between the narrow buildings. The scene is moody, dark, and "
            "atmospheric with sharp reflections on every wet surface."
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
            "forest trail, each footstep crunching dry leaves and snapping small twigs with a "
            "soft crackle. She steps over exposed roots with a quiet rustle. Tall moss-covered "
            "trees line both sides, their canopy filtering golden sunlight into scattered beams "
            "that shift across the ground. Small particles of dust and pollen drift through the "
            "light shafts. Wind moves through the upper branches producing a soft rushing sound, "
            "while closer branches creak gently. A woodpecker taps rhythmically in the distance. "
            "Birdsong — clear melodic whistles — filters through the canopy from several "
            "directions. Ferns and fallen leaves carpet the forest floor, muffling footsteps "
            "with a dry papery texture. The camera follows at a steady pace behind her. The "
            "atmosphere is cool, quiet, and serene, with the layered sounds of rustling leaves, "
            "distant birds, and gentle wind creating a rich natural ambience."
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
            "mountain slope covered in fresh powder. The board cuts a clean arc with a sharp "
            "slicing hiss through snow, sending a fan of white snow spray crackling to the "
            "right. Wind rushes past with a steady high-pitched whisper as speed increases. "
            "Tall mountain peaks rise in the background under a clear blue sky. The rider "
            "shifts weight and transitions into a second turn, the edge biting into the slope "
            "with a muffled crunch, body leaning into the slope. Snow particles sparkle in "
            "bright alpine sunlight. Loose powder cascading down the slope produces a soft "
            "sliding hiss. The ambient sound is dominated by the rhythmic carving — a "
            "repeating pattern of slicing, spraying, and settling snow — with wind as a "
            "constant high-altitude presence. The scene is fast, dynamic, and crisp."
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
            "A wooden table holds a matte ceramic vase with dried eucalyptus branches, "
            "their leaves faintly rustling as warm air rises around them. A single tall candle "
            "burns to the right, its flame gently flickering with a soft crackle and occasional "
            "pop. The flame produces a faint sizzle as it consumes the wick, and melting wax "
            "drips with a soft wet click onto the candle holder. Warm orange light casts across "
            "the vase and table surface. Soft shadows shift subtly on the wall behind. The "
            "background is a dark muted brown. The scene is almost motionless except for the "
            "candle flame dancing and the faint curl of smoke rising with a whisper-soft hiss. "
            "The only sounds are the intimate crackling of the flame, the occasional tick of "
            "cooling wax, and the deep silence of the room giving the space a meditative "
            "stillness. The mood is quiet, warm, and meditative."
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

    "dialog-test": {
        "name": "dialog-test",
        "description": (
            "Two people having a quiet conversation at a café table, "
            "ambient coffee shop sounds, testing voice generation"
        ),
        "prompt": (
            "Style: cinematic realism. "
            "Two people sit across from each other at a small wooden café table near a large "
            "window. A woman in a cream sweater leans forward slightly and says softly, "
            "\"I think it's going to rain today.\" Her voice is quiet, warm, and intimate with "
            "a slight American accent. The man across from her, wearing a dark jacket, chuckles "
            "with a low warm laugh and replies, \"It always rains here.\" His voice is calm and "
            "deep with a relaxed tone. Between them, two ceramic mugs sit on the table with "
            "steam rising gently. The background hum of the coffee shop fills the space — an "
            "espresso machine hissing and gurgling, ceramic cups clinking softly against saucers, "
            "muffled conversation from other tables blending into a warm murmur, and soft jazz "
            "music playing gently from overhead speakers. Natural daylight filters through the "
            "window on the left, casting a soft warm glow. The atmosphere is cozy, intimate, "
            "and unhurried."
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

    "voice-test": {
        "name": "voice-test",
        "description": (
            "Close-up of a woman speaking — test configurations for voice quality. "
            "Use 'configs' to run systematic A/B tests."
        ),
        "prompt": (
            "Style: cinematic realism. Close-up shot of a woman's face, "
            "framed from the shoulders up. She is looking directly at the camera "
            "and talking. She says clearly, \"The weather is beautiful today.\" "
            "Her voice is warm, clear, and natural. She speaks slowly and "
            "deliberately. The room is quiet with no background music or noise. "
            "Soft natural daylight from a window on the left illuminates her face. "
            "The background is a plain warm-toned wall, slightly out of focus."
        ),
        "defaults": {
            "frames": 49,
            "width": 704,
            "height": 480,
            "fps": 24.0,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
            "stage1_steps": 12,
            "stage2_steps": 3,
        },
        "configs": {
            "short-default": {
                "label": "49f, cfg=5, stg=1 (default)",
                "frames": 49, "cfg_scale": 5.0, "stg_scale": 1.0,
            },
            "short-high-cfg": {
                "label": "49f, cfg=7, stg=1 (match audio cfg)",
                "frames": 49, "cfg_scale": 7.0, "stg_scale": 1.0,
            },
            "short-no-stg": {
                "label": "49f, cfg=5, stg=0 (no STG pass)",
                "frames": 49, "cfg_scale": 5.0, "stg_scale": 0.0,
            },
            "short-cfg3": {
                "label": "49f, cfg=3, stg=1 (low cfg)",
                "frames": 49, "cfg_scale": 3.0, "stg_scale": 1.0,
            },
            "ultra-short": {
                "label": "25f, cfg=5, stg=1 (1 second)",
                "frames": 25, "cfg_scale": 5.0, "stg_scale": 1.0,
            },
        },
    },

    "frog-yoga": {
        "name": "frog-yoga",
        "description": (
            "Frog yoga studio — instructor speaks, class responds. "
            "Narrative dialog style with multiple voice interactions."
        ),
        "prompt": (
            "The camera opens in a calm, sunlit frog yoga studio. Warm morning "
            "light washes over the wooden floor as incense smoke drifts lazily in "
            "the air. The senior frog instructor sits cross-legged at the center, "
            "eyes closed, voice deep and calm. The instructor speaks slowly, \"We "
            "are one with the pond.\" The voice is deep, resonant, and peaceful. "
            "All the frogs answer softly in unison, \"Ommm...\" Their voices blend "
            "into a warm, harmonic hum. The instructor continues, \"We are one with "
            "the mud.\" A gentle breeze rustles through bamboo wind chimes near the "
            "window, producing soft tinkling sounds. A small fountain trickles "
            "quietly in the corner. The atmosphere is serene and meditative."
        ),
        "defaults": {
            "frames": 49,
            "width": 704,
            "height": 480,
            "fps": 24.0,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
            "stage1_steps": 12,
            "stage2_steps": 3,
        },
    },
}


def get_test_prompt(name: str) -> dict:
    """Look up a test prompt by name. Raises KeyError if not found."""
    return VIDEO_TEST_PROMPTS[name]


def list_test_prompt_names() -> list[str]:
    """Return ordered list of available test prompt names."""
    return list(VIDEO_TEST_PROMPTS.keys())
