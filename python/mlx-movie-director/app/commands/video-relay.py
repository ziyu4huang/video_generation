"""video-relay — multi-segment Prompt-Relay-Custom-Audio pipeline for LTX-2.3.

Implements the "Prompt Relay" pattern from RuneXX/LTX-2.3-Workflows:
  1. Generate segment 1 using --relay-first-image (I2V) or without (T2V)
  2. Extract last frame of segment 1 → use as input image for segment 2
  3. Repeat for all N segments
  4. Concatenate all segments into a single MP4
  5. Overlay custom audio track (if provided)

This is the MLX equivalent of the ComfyUI Prompt-Relay-Custom-Audio workflows.
The pipeline is loaded once and reused across all segments (~21 GB avoids N reloads).

Examples:
  # 4-segment relay from prompts file + first image + audio
  run.py video relay \
    --relay-prompt-file prompts.txt \
    --relay-first-image opening.jpg \
    --relay-audio background.mp3 \
    --relay-duration 8 --fps 24 --low-ram

  # Inline prompts with per-segment images (empty = use relay frame)
  run.py video relay \
    --relay-prompts "opening shot" "person walks" "enters lobby" "sits at desk" \
    --relay-images city.jpg "" building.jpg "" \
    --relay-audio music.mp3

  # With VBVR reasoning LoRA across all segments
  run.py video relay \
    --relay-prompt-file prompts.txt --relay-first-image base.jpg \
    --relay-audio music.mp3 --lora-path vbvr-ltx2.3

Prompt file format: one prompt per line, blank lines and # comments ignored.
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
import types
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name, resolve_lora_path, RELAY_FINAL_MODE
from app.manifest import Manifest
from app.run_config import RunConfig


# ---------------------------------------------------------------------------
# Variant definitions — built-in pipeline configs for relay A/B comparison
# ---------------------------------------------------------------------------

_RELAY_VARIANTS = {
    "distilled": {
        "distilled": True, "lora_path": None, "lora_scale": 1.0,
        "cfg_scale": 1.0, "stg_scale": 0.0,
        "label": "Distilled (baseline)",
    },
    "distilled+vbvr-licon": {
        "distilled": True, "lora_path": "vbvr-licon-ltx2.3", "lora_scale": 1.0,
        "cfg_scale": 1.0, "stg_scale": 0.0,
        "label": "Distilled + VBVR (LiconStudio)",
    },
    "distilled+vbvr-siraxe": {
        "distilled": True, "lora_path": "vbvr-ltx2.3", "lora_scale": 1.0,
        "cfg_scale": 1.0, "stg_scale": 0.0,
        "label": "Distilled + VBVR (siraxe)",
    },
    "dev2stg": {
        "distilled": False, "lora_path": None, "lora_scale": 1.0,
        "cfg_scale": 5.0, "stg_scale": 1.0,
        "label": "Dev 2-Stage (dev+distill-lora)",
    },
    "dev2stg+vbvr-licon": {
        "distilled": False, "lora_path": "vbvr-licon-ltx2.3", "lora_scale": 1.0,
        "cfg_scale": 5.0, "stg_scale": 1.0,
        "label": "Dev 2-Stage + VBVR (LiconStudio)",
    },
    "dev2stg+vbvr-siraxe": {
        "distilled": False, "lora_path": "vbvr-ltx2.3", "lora_scale": 1.0,
        "cfg_scale": 5.0, "stg_scale": 1.0,
        "label": "Dev 2-Stage + VBVR (siraxe)",
    },
    # LiconStudio step-by-step checkpoints (96K / 240K / 390K training steps)
    "distilled+vbvr-licon-96k": {
        "distilled": True, "lora_path": "vbvr-licon-96k", "lora_scale": 1.0,
        "cfg_scale": 1.0, "stg_scale": 0.0,
        "label": "Distilled + VBVR Licon 96K",
    },
    "distilled+vbvr-licon-240k": {
        "distilled": True, "lora_path": "vbvr-licon-240k", "lora_scale": 1.0,
        "cfg_scale": 1.0, "stg_scale": 0.0,
        "label": "Distilled + VBVR Licon 240K",
    },
    "distilled+vbvr-licon-390k": {
        "distilled": True, "lora_path": "vbvr-licon-390k", "lora_scale": 1.0,
        "cfg_scale": 1.0, "stg_scale": 0.0,
        "label": "Distilled + VBVR Licon 390K (best)",
    },
    "dev2stg+vbvr-licon-96k": {
        "distilled": False, "lora_path": "vbvr-licon-96k", "lora_scale": 1.0,
        "cfg_scale": 5.0, "stg_scale": 1.0,
        "label": "Dev 2-Stage + VBVR Licon 96K",
    },
    "dev2stg+vbvr-licon-240k": {
        "distilled": False, "lora_path": "vbvr-licon-240k", "lora_scale": 1.0,
        "cfg_scale": 5.0, "stg_scale": 1.0,
        "label": "Dev 2-Stage + VBVR Licon 240K",
    },
    "dev2stg+vbvr-licon-390k": {
        "distilled": False, "lora_path": "vbvr-licon-390k", "lora_scale": 1.0,
        "cfg_scale": 5.0, "stg_scale": 1.0,
        "label": "Dev 2-Stage + VBVR Licon 390K (best)",
    },
}


# ---------------------------------------------------------------------------
# Human A/B review scores — updated after each review session.
# Format: preset → { date, params, winner, scores: { variant → { stars, notes } } }
# ---------------------------------------------------------------------------

_RELAY_REVIEWS = {
    "kitchen": {
        "date": "2026-06-11",
        "params": "704×448, 193fr, 8s/seg × 3, distilled, cfg=1, stg=0",
        "winner": "distilled+vbvr-siraxe",
        "scores": {
            "distilled": {
                "stars": 1,
                "notes": "看起來像兩顆球 畫面會閃動跳動不太合理 物體會變換來變換去缺乏一致性",
            },
            "distilled+vbvr-licon": {
                "stars": 2,
                "notes": "雞蛋殼打敲開來比較真實 但還是會還原雞蛋的樣子",
            },
            "distilled+vbvr-siraxe": {
                "stars": 3,
                "notes": "後面做菜的部分比較合理 雖然還是有散光 但最後面做成一道餐的樣子比較合理",
            },
        },
    },
    "physics": {
        "date": "2026-06-12",
        "params": "704×448, 193fr, 8s/seg × 3, distilled, cfg=1, stg=0",
        "winner": "distilled",
        "scores": {
            "distilled": {
                "stars": 3,
                "notes": "",
            },
            "distilled+vbvr-licon": {
                "stars": 2,
                "notes": "切換到最後玻璃的破碎的形狀跟位置有不一致",
            },
            "distilled+vbvr-siraxe": {
                "stars": 3,
                "notes": "看不出來跟baseline有何差異",
            },
        },
    },
    "kitchen-dev2stg": {
        "date": "2026-06-12",
        "params": "704×448, 193fr, 8s/seg × 3, dev2stg, cfg=5, stg=1",
        "winner": "dev2stg+vbvr-licon",
        "scores": {
            "dev2stg": {"stars": 1, "notes": "非常差錯誤非常多"},
            "dev2stg+vbvr-licon": {"stars": 3, "notes": ""},
            "dev2stg+vbvr-siraxe": {"stars": 2, "notes": ""},
        },
    },
    "physics-dev2stg": {
        "date": "2026-06-12",
        "params": "704×448, 193fr, 8s/seg × 3, dev2stg, cfg=5, stg=1",
        "winner": "dev2stg",
        "scores": {
            "dev2stg": {"stars": 3, "notes": ""},
            "dev2stg+vbvr-licon": {"stars": 2, "notes": ""},
            "dev2stg+vbvr-siraxe": {"stars": 3, "notes": ""},
        },
    },
}


# ---------------------------------------------------------------------------
# Prompt presets — named prompt sets with recommended defaults
# ---------------------------------------------------------------------------

_RELAY_PRESETS = {
    "wuxia": {
        "prompts": [
            (
                "Style: cinematic realism. Shot on 35mm film with shallow depth of field. "
                "A lone warrior in weathered black hanfu stands perfectly still at the heart of "
                "a crowded ancient Chinese marketplace at dusk. Red paper lanterns cast warm amber "
                "pools of light across wet cobblestones. Silk banners drift in a faint evening "
                "breeze. Steam rises from a nearby clay noodle pot. The warrior's eyes move slowly "
                "across the crowd — sharp, calculating, unhurried. Dust motes drift through shafts "
                "of fading gold light between canvas awnings."
            ),
            (
                "Style: cinematic realism. Shot on 35mm film, motion blur on fast action. "
                "With a sharp metallic ring the warrior's silver blade clears its scabbard and "
                "catches the last copper light of dusk. He lunges forward into the crowd — black "
                "robes billowing, feet barely grazing the cobblestones. Bystanders scatter and "
                "shout. He vaults over a wooden market cart, ceramic jars exploding on impact. "
                "A dark-cloaked figure sprints between stalls ahead. A hanging red lantern swings "
                "violently in his wake."
            ),
            (
                "Style: cinematic realism. Wide establishing shot transitioning to medium close-up. "
                "The warrior lands in perfect silence on curved grey clay roof tiles, arms extended "
                "briefly for balance. Ten thousand lantern lights glimmer through evening haze across "
                "the ancient city below. A cool wind lifts the hem of his black robes and loosens "
                "strands of his hair. He lowers his sword slowly, chest rising and falling. Temple "
                "bells toll in the far distance. The sky fades from deep crimson at the horizon to "
                "indigo directly above."
            ),
        ],
        "width": 704,
        "height": 448,
        "duration": 8.0,  # 193 frames @ 24fps — long enough for quality judgment
    },
    "physics": {
        "prompts": [
            (
                "Style: cinematic realism. A glass of water sits on the edge of a wooden table "
                "in a sunlit kitchen. A cat leaps up onto the table, its paw catching the glass. "
                "The glass tips in slow motion, water spilling in an arc through the air, catching "
                "sunlight. The glass shatters on the tile floor, shards scattering in every direction."
            ),
            (
                "Style: cinematic realism. Water pools across the white tile floor, running between "
                "the cracks. The cat freezes, one paw raised, staring down at the broken glass. It "
                "backs away carefully, tail puffing out. A person rushes in from the next room, bare "
                "feet stopping just short of the water, arms flailing for balance."
            ),
            (
                "Style: cinematic realism. The person kneels and carefully picks up the largest glass "
                "shards one by one, wrapping them in a cloth. They mop the water with a towel, wringing "
                "it into a bucket. The cat watches from the safety of a nearby chair, licking its paw. "
                "Sunlight shifts across the now-dry floor as dust motes drift in the warm air."
            ),
        ],
        "width": 704,
        "height": 448,
        "duration": 8.0,
    },
    "kitchen": {
        "prompts": [
            (
                "Style: cinematic realism. Shot on 35mm film with shallow depth of field. A chef's "
                "hands crack two eggs into a stainless steel bowl, yolks intact. Whisk flashes, beating "
                "eggs into a frothy yellow mixture. Butter sizzles in a cast iron pan, bubbling and "
                "browning at the edges. The chef pours the egg mixture in one smooth motion."
            ),
            (
                "Style: cinematic realism. The omelette sets, edges curling up golden brown. The chef "
                "tilts the pan, slides a spatula underneath, and flips it in a single practiced motion. "
                "Grated cheese scatters across the surface, melting into long strings. Fresh herbs are "
                "chopped rapidly with a rocking knife motion on a wooden cutting board."
            ),
            (
                "Style: cinematic realism. The omelette folds onto itself, cheese oozing from the seam. "
                "It slides onto a white plate with a gentle shake of the pan. A garnish of microgreens "
                "lands on top, followed by a drizzle of olive oil from a small pitcher. Steam rises "
                "from the plate in the warm kitchen light, camera slowly pulling back."
            ),
        ],
        "width": 704,
        "height": 448,
        "duration": 8.0,
    },
    "street": {
        "prompts": [
            (
                "Style: cinematic realism. A busy Tokyo crosswalk at night. Hundreds of people stream "
                "across in both directions, umbrellas glistening under neon reflections on wet asphalt. "
                "A tourist in a bright yellow raincoat stands still amid the flowing crowd, looking up "
                "at enormous LED billboards. Rain drops catch the colored light as they fall."
            ),
            (
                "Style: cinematic realism. The camera follows the tourist pushing through the crowd into "
                "a narrow alley. Steam rises from a ramen stall, the vendor ladling broth into ceramic "
                "bowls. Neon kanji signs reflect in puddles. The tourist stops at the stall, sitting on "
                "a red plastic stool, rain dripping from their hood."
            ),
            (
                "Style: cinematic realism. Close-up of chopsticks lifting noodles from the bowl, broth "
                "dripping back. The tourist slurps noodles, steam fogging their glasses. Behind them, "
                "the alley blurs with passing figures and swinging lanterns. A cat sits on a stack of "
                "crates, watching. The neon glow pulses softly against the wet walls."
            ),
        ],
        "width": 704,
        "height": 448,
        "duration": 8.0,
    },
}


PARSER_META = {
    "help": "Multi-segment Prompt-Relay video generation with custom audio",
    "description": (
        "Generate a short film by chaining N video segments with prompt relay.\n\n"
        "The last frame of segment N becomes the input image for segment N+1 (I2V relay),\n"
        "creating visual continuity. All segments are concatenated into one video.\n"
        "An optional audio track is overlaid on the final output.\n\n"
        "Equivalent to the RuneXX LTX-2.3 Prompt-Relay-Custom-Audio ComfyUI workflows.\n\n"
        "Examples:\n"
        "  run.py video relay --relay-prompt-file prompts.txt --relay-first-image base.jpg\n"
        "  run.py video relay --relay-prompt-file prompts.txt --relay-audio music.mp3 --low-ram\n"
        "  run.py video relay --relay-prompts 'shot 1' 'shot 2' 'shot 3' --relay-audio sfx.mp3\n"
    ),
}


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_relay_args(parser):
    """Register video-relay arguments (relay-specific only; reuses generate args for the rest)."""
    grp = parser.add_argument_group("Prompt Relay")

    # Prompt input — relay-specific (mutually exclusive with each other but NOT with generate's --prompt)
    prompt_grp = grp.add_mutually_exclusive_group()
    prompt_grp.add_argument("--relay-prompts", nargs="+", default=None, metavar="PROMPT",
                            help="Inline prompts, one per segment (N args = N segments)")
    prompt_grp.add_argument("--relay-prompt-file", type=str, default=None, metavar="PATH",
                            help="Text file with one prompt per line "
                                 "(blank lines and # comments ignored)")

    # Per-segment images (optional)
    grp.add_argument("--relay-first-image", type=str, default=None, metavar="PATH",
                     help="Reference image for segment 1 (T2V if omitted)")
    grp.add_argument("--relay-images", nargs="*", default=None, metavar="PATH",
                     help="Per-segment image paths (use '' for relay frame). "
                          "When provided, overrides --relay-first-image for their segments.")

    # Audio track
    grp.add_argument("--relay-audio", type=str, default=None, metavar="PATH",
                     help="Custom audio track overlaid on the final concatenated video "
                          "(WAV, MP3, AAC, M4A — any ffmpeg-supported format)")

    # Timing
    grp.add_argument("--relay-duration", type=float, default=8.0, metavar="SECS",
                     help="Duration per segment in seconds (default: 8.0). "
                          "Frame count auto-calculated from fps × duration and snapped to 8k+1. "
                          "With --distilled, Stage 1 runs at half-resolution (2x spatial upscale built in). "
                          "Optimal distilled resolutions: 704×448 (fast), 896×512, 1280×768 (near-HD).")

    # Output path (optional override)
    grp.add_argument("--relay-output", type=str, default=None, metavar="PATH",
                     help="Explicit output path for the final relay MP4 "
                          "(default: output/<timestamp>_relay.mp4)")

    # Audio mode
    grp.add_argument(
        "--relay-audio-mode",
        choices=["replace", "mix", "keep"],
        default="replace",
        dest="relay_audio_mode",
        help="How custom --relay-audio interacts with model-generated audio. "
             "'replace' (default): custom audio replaces model audio entirely. "
             "'mix': blend model audio + custom audio (amix, narration dominant). "
             "'keep': ignore --relay-audio, keep only model-generated audio.",
    )

    # TTS generation
    grp.add_argument(
        "--relay-tts-engine",
        choices=["say", "edge-tts"],
        default="say",
        dest="relay_tts_engine",
        help="TTS engine for --relay-tts-text. 'say' = macOS built-in. "
             "'edge-tts' = Microsoft neural TTS (much more natural, requires internet).",
    )
    grp.add_argument(
        "--relay-tts-voice",
        default=None,
        dest="relay_tts_voice",
        metavar="VOICE",
        help="Voice name. say default: 'Meijia'. "
             "edge-tts default: 'zh-TW-HsiaoChenNeural'. "
             "edge-tts zh-TW options: HsiaoChenNeural, YunJheNeural, HsiaoYuNeural.",
    )
    grp.add_argument(
        "--relay-tts-text",
        default=None,
        dest="relay_tts_text",
        metavar="TEXT",
        help="Narration text to synthesize and use as relay audio. "
             "Use with --relay-tts-engine and --relay-tts-voice. "
             "Ignored if --relay-audio is also set.",
    )
    grp.add_argument(
        "--relay-tts-rate",
        type=int,
        default=None,
        dest="relay_tts_rate",
        help="Speech rate. For 'say': words/min (default 145). "
             "For 'edge-tts': percentage offset, e.g. -10 for slower (default 0).",
    )

    # Self-test
    grp.add_argument(
        "--relay-self-test", action="store_true", default=False, dest="relay_self_test",
        help="Run a 2-segment relay self-test (T2V → last-frame → I2V → concat). "
             "No prompts or images required. Pass --relay-audio to also test audio mux.",
    )

    # Variant A/B comparison
    grp.add_argument(
        "--relay-variant", type=str, default=None, dest="relay_variant",
        metavar="VARIANT[,VARIANT,...]",
        help="Run relay once per variant for A/B comparison. "
             "Comma-separated variant names. Each variant runs independently with "
             "its own pipeline config. Outputs get variant-suffixed filenames.\n"
             f"Options: {', '.join(_RELAY_VARIANTS.keys())}",
    )
    grp.add_argument(
        "--relay-preset", type=str, default=None, dest="relay_preset",
        metavar="PRESET",
        help="Named prompt preset (overrides --relay-prompts / --relay-prompt-file "
             "and applies recommended resolution/duration defaults).\n"
             f"Options: {', '.join(_RELAY_PRESETS.keys())}",
    )


# ---------------------------------------------------------------------------
# ffmpeg helpers
# ---------------------------------------------------------------------------

def _require_ffmpeg() -> str:
    """Return ffmpeg path or exit with a clear error."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ERROR: ffmpeg not found in PATH. Install it: brew install ffmpeg", file=sys.stderr)
        sys.exit(1)
    return ffmpeg


def _extract_last_frame(video_path: str, png_path: str) -> bool:
    """Extract the last video frame to png_path using ffmpeg."""
    ffmpeg = _require_ffmpeg()
    # -sseof -3: seek 3 seconds from end; -vframes 1: take one frame
    result = subprocess.run(
        [ffmpeg, "-y", "-sseof", "-3", "-i", video_path, "-vframes", "1",
         "-update", "1", png_path],
        capture_output=True, timeout=60,
    )
    if result.returncode != 0 or not os.path.exists(png_path):
        # Fallback: use last frame by filter (slower but reliable)
        result2 = subprocess.run(
            [ffmpeg, "-y", "-i", video_path,
             "-vf", "reverse,fps=1,vframes=1",
             png_path],
            capture_output=True, timeout=120,
        )
        return result2.returncode == 0 and os.path.exists(png_path)
    return True


def _extract_first_frame_relay(video_path: str, png_path: str) -> bool:
    """Extract the first video frame to png_path using ffmpeg."""
    ffmpeg = _require_ffmpeg()
    result = subprocess.run(
        [ffmpeg, "-y", "-i", video_path, "-vframes", "1", png_path],
        capture_output=True, timeout=30,
    )
    return result.returncode == 0 and os.path.exists(png_path)


def _concat_videos(video_paths: list, output_path: str) -> None:
    """Concatenate MP4 files using ffmpeg concat demuxer (stream copy, no re-encode)."""
    ffmpeg = _require_ffmpeg()

    # Write concat list to temp file
    tmp_fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="relay_concat_")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            for vp in video_paths:
                f.write(f"file '{os.path.abspath(vp)}'\n")

        result = subprocess.run(
            [ffmpeg, "-y", "-f", "concat", "-safe", "0",
             "-i", list_path, "-c", "copy", output_path],
            capture_output=True, timeout=300,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")
            print(f"ERROR: ffmpeg concat failed:\n{stderr}", file=sys.stderr)
            sys.exit(1)
    finally:
        if os.path.exists(list_path):
            os.unlink(list_path)


def _mux_audio_track(video_path: str, audio_path: str, output_path: str,
                     mode: str = "replace") -> None:
    """Overlay or mix an audio track on the video.

    mode='replace': custom audio replaces model audio entirely (-map 1:a:0)
    mode='mix': blend model audio + custom audio via amix (narration dominant at 0.6/0.4)
    """
    ffmpeg = _require_ffmpeg()
    tmp_path = output_path + ".audio_tmp.mp4"

    if mode == "mix":
        cmd = [
            ffmpeg, "-y",
            "-i", video_path,
            "-i", audio_path,
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:weights=0.4 0.6[aout]",
            "-map", "0:v:0",
            "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            tmp_path,
        ]
    else:  # replace
        cmd = [
            ffmpeg, "-y",
            "-i", video_path,
            "-i", audio_path,
            "-c:v", "copy",
            "-c:a", "aac",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-shortest",
            tmp_path,
        ]

    result = subprocess.run(cmd, capture_output=True, timeout=300)
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")
        print(f"[relay] WARNING: audio mux failed — output has no audio.\n{stderr}",
              file=sys.stderr)
        shutil.move(video_path, output_path) if video_path != output_path else None
        return

    os.replace(tmp_path, output_path)
    print(f"[relay] Audio overlaid ({mode}): {os.path.basename(audio_path)}")


# ---------------------------------------------------------------------------
# TTS helpers
# ---------------------------------------------------------------------------

def _generate_tts_audio(text: str, engine: str, voice: str | None,
                        rate: int | None, output_path: str) -> None:
    """Synthesize narration text to output_path (AAC) using the chosen TTS engine."""
    if engine == "edge-tts":
        _generate_tts_edge(text, voice or "zh-TW-HsiaoChenNeural", rate or 0, output_path)
    else:
        _generate_tts_say(text, voice or "Meijia", rate or 145, output_path)


def _generate_tts_say(text: str, voice: str, rate: int, output_path: str) -> None:
    """macOS say → AIFF → AAC via ffmpeg."""
    aiff_path = output_path.rsplit(".", 1)[0] + ".aiff"
    subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", aiff_path, text], check=True)
    try:
        subprocess.run(
            [_require_ffmpeg(), "-y", "-i", aiff_path, "-c:a", "aac", output_path],
            capture_output=True, check=True,
        )
    finally:
        if os.path.exists(aiff_path):
            os.unlink(aiff_path)


def _generate_tts_edge(text: str, voice: str, rate_offset: int, output_path: str) -> None:
    """Microsoft neural TTS via edge-tts → MP3 file."""
    import asyncio
    try:
        import edge_tts
    except ImportError:
        print("ERROR: edge-tts not installed. Run: pip install edge-tts", file=sys.stderr)
        sys.exit(1)

    rate_str = f"{rate_offset:+d}%" if rate_offset != 0 else "+0%"

    async def _run():
        communicate = edge_tts.Communicate(text, voice, rate=rate_str)
        await communicate.save(output_path)

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Resolution / frame helpers (same logic as video-generate.py)
# ---------------------------------------------------------------------------

def _adjust_resolution(width: int, height: int, distilled: bool = False) -> tuple:
    """Snap resolution to multiples of 64 (required by VAE).

    When distilled=True, the pipeline runs Stage 1 at width//2 × height//2 and applies
    a 2x spatial upscaler to reach the target resolution. Multiples of 64 ensure Stage 1
    dims are multiples of 32, which the VAE encoder requires.

    Recommended distilled+spatial-upscale resolutions (Stage1 → Final):
      352×224 → 704×448   (default, fast)
      448×256 → 896×512   (medium, good quality)
      480×288 → 960×576   (larger, ~1.5x slower)
      640×384 → 1280×768  (near-HD, ~3x slower)
    """
    aligned_w = max(64, round(width / 64) * 64)
    aligned_h = max(64, round(height / 64) * 64)
    if aligned_w != width or aligned_h != height:
        print(f"[relay] Resolution adjusted: {width}×{height} → {aligned_w}×{aligned_h}")
    if distilled:
        s1_w, s1_h = aligned_w // 2, aligned_h // 2
        print(f"[relay] Distilled 2x spatial upscale: "
              f"Stage 1 at {s1_w}×{s1_h} → Stage 2 at {aligned_w}×{aligned_h}")
    return aligned_w, aligned_h


def _adjust_frames(frames: int) -> int:
    if (frames - 1) % 8 == 0:
        return frames
    k = round((frames - 1) / 8)
    adjusted = max(9, 8 * k + 1)
    print(f"[relay] Frames adjusted: {frames} → {adjusted} (must satisfy 8k+1)")
    return adjusted


def _duration_to_frames(duration_secs: float, fps: float) -> int:
    """Convert duration + FPS to valid frame count (8k+1 pattern)."""
    raw = int(round(duration_secs * fps))
    return _adjust_frames(max(9, raw))


# ---------------------------------------------------------------------------
# Prompt loading
# ---------------------------------------------------------------------------

def _load_prompts(args) -> list:
    """Load prompts from --relay-prompts or --relay-prompt-file."""
    if getattr(args, "relay_prompts", None):
        return [p.strip() for p in args.relay_prompts if p.strip()]

    prompt_file = getattr(args, "relay_prompt_file", None)
    if prompt_file:
        if not os.path.exists(prompt_file):
            print(f"ERROR: prompt file not found: {prompt_file}", file=sys.stderr)
            sys.exit(1)
        with open(prompt_file, "r", encoding="utf-8") as f:
            prompts = [
                line.strip() for line in f
                if line.strip() and not line.strip().startswith("#")
            ]
        if not prompts:
            print(f"ERROR: no prompts found in {prompt_file}", file=sys.stderr)
            sys.exit(1)
        return prompts

    print("ERROR: No prompts provided. Use --relay-prompts or --relay-prompt-file.",
          file=sys.stderr)
    sys.exit(1)


def _resolve_segment_images(args, n_segments: int) -> list:
    """Build per-segment image list. None = use relay frame (auto-extracted last frame)."""
    relay_images = getattr(args, "relay_images", None) or []
    first_image = getattr(args, "relay_first_image", None)

    # Pad or trim to n_segments
    result = list(relay_images) + [None] * n_segments
    result = result[:n_segments]

    # Treat empty strings as None (relay frame)
    result = [r if r and r.strip() else None for r in result]

    # Fill segment 0 with first_image if not explicitly set
    if result[0] is None and first_image:
        result[0] = first_image

    # Validate provided image paths
    for i, img in enumerate(result):
        if img and not os.path.exists(img):
            print(f"ERROR: segment {i+1} image not found: {img}", file=sys.stderr)
            sys.exit(1)

    return result


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run_relay(args):
    """Entry point for video relay sub-action."""
    if getattr(args, "relay_variant", None):
        _run_relay_variants(args)
    elif getattr(args, "relay_self_test", False):
        _run_relay_self_test(args)
    else:
        _run_relay_inner(args)


_SELF_TEST_PROMPTS = _RELAY_PRESETS["physics"]["prompts"][:2]


def _run_relay_self_test(args):
    """2-segment relay integration test: T2V → last-frame extract → I2V → concat (→ audio mux)."""
    print("[relay-self-test] ═══ Relay Self-Test ═══")
    print("[relay-self-test] 2 segments, 49 frames each (@24fps ≈ 2s), 704×448, distilled pipeline (CFG=1, stage1=8)")

    relay_audio = getattr(args, "relay_audio", None)
    if relay_audio and not os.path.exists(relay_audio):
        print(f"ERROR: audio file not found: {relay_audio}", file=sys.stderr)
        sys.exit(1)

    # Build synthetic test args — distilled pipeline (has transformer-distilled-1.1.safetensors,
    # supports low_ram). 49 frames × 2 segments = ~4s total, 704×448, representative of real use.
    test_args = types.SimpleNamespace(
        relay_prompts=_SELF_TEST_PROMPTS,
        relay_prompt_file=None,
        relay_first_image=None,       # seg1 = T2V (no image)
        relay_images=None,
        relay_audio=relay_audio,
        relay_duration=2.0,           # 49 frames @ 24fps per segment
        relay_output=None,
        relay_self_test=False,        # prevent recursion
        width=704,
        height=448,
        fps=24.0,
        stage1_steps=8,
        stage2_steps=3,
        cfg_scale=1.0,                # distilled requires CFG=1
        stg_scale=0.0,                # distilled has no STG
        seed=42,
        low_ram=getattr(args, "low_ram", False),
        hq=False,
        distilled=True,               # best overall: distilled+vbvr-siraxe
        lora_path=getattr(args, "lora_path", "vbvr-ltx2.3"),  # default to siraxe (3★ both presets)
        lora_scale=1.0,
        video_model=None,             # use default distilled dir
        teacache=False,
        teacache_thresh=None,
    )

    before_segs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_seg*.mp4")))
    before_relay = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.mp4")))
    before_pngs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.png")))

    _run_relay_inner(test_args)

    after_segs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_seg*.mp4")))
    after_relay = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.mp4")))
    after_pngs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*_relay.png")))

    new_segs = sorted(after_segs - before_segs)
    new_relay = sorted(after_relay - before_relay)
    new_pngs = sorted(after_pngs - before_pngs)

    checks = []

    # seg01 exists and non-empty
    seg01 = next((p for p in new_segs if "_seg01." in p), None)
    checks.append(("seg01.mp4 exists", bool(seg01 and os.path.getsize(seg01) > 0)))

    # relay frame PNG extracted between segments
    relay_png = bool(new_pngs)
    checks.append(("relay frame PNG extracted", relay_png))

    # seg02 exists and non-empty
    seg02 = next((p for p in new_segs if "_seg02." in p), None)
    checks.append(("seg02.mp4 exists", bool(seg02 and os.path.getsize(seg02) > 0)))

    # concat relay.mp4 exists
    relay_mp4 = new_relay[-1] if new_relay else None
    checks.append(("relay.mp4 concat exists", bool(relay_mp4 and os.path.exists(relay_mp4))))

    # relay.mp4 size plausible (≥ 80% of seg01+seg02 combined)
    if relay_mp4 and seg01 and seg02:
        relay_sz = os.path.getsize(relay_mp4)
        combined = os.path.getsize(seg01) + os.path.getsize(seg02)
        checks.append(("relay.mp4 size plausible", relay_sz >= combined * 0.8))
    else:
        checks.append(("relay.mp4 size plausible", False))

    # Audio stream check (only if audio was requested)
    if relay_audio and relay_mp4:
        ffprobe = shutil.which("ffprobe")
        if ffprobe:
            r = subprocess.run(
                [ffprobe, "-v", "error", "-select_streams", "a:0",
                 "-show_entries", "stream=codec_type",
                 "-of", "default=nw=1:nk=1", relay_mp4],
                capture_output=True, text=True, timeout=30,
            )
            checks.append(("audio stream in relay.mp4", r.stdout.strip() == "audio"))
        else:
            print("[relay-self-test] WARNING: ffprobe not found, skipping audio stream check",
                  file=sys.stderr)

    # Report
    print("\n[relay-self-test] Results:")
    passed = 0
    failed = 0
    for name, ok in checks:
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {name}")
        if ok:
            passed += 1
        else:
            failed += 1

    total = len(checks)
    if failed == 0:
        print(f"\n[relay-self-test] PASS: {passed}/{total} checks passed")
    else:
        print(f"\n[relay-self-test] FAIL: {failed}/{total} checks failed", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Variant A/B comparison
# ---------------------------------------------------------------------------

def _run_relay_variants(args):
    """Run relay once per variant for A/B comparison.

    Each variant defines its own pipeline config (distilled, lora_path, cfg_scale, etc.).
    Prompts come from --relay-preset, --relay-prompts, or --relay-prompt-file.
    Outputs are suffixed with the variant name for easy comparison.
    """
    import copy
    import gc

    # Resolve variant names
    variant_names = [v.strip() for v in args.relay_variant.split(",") if v.strip()]
    unknown = [v for v in variant_names if v not in _RELAY_VARIANTS]
    if unknown:
        print(f"ERROR: unknown variant(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"  Available: {', '.join(_RELAY_VARIANTS.keys())}", file=sys.stderr)
        sys.exit(1)

    # Load prompts — preset takes priority, then relay args
    preset_name = getattr(args, "relay_preset", None)
    preset = None
    if preset_name:
        if preset_name not in _RELAY_PRESETS:
            print(f"ERROR: unknown preset '{preset_name}'", file=sys.stderr)
            print(f"  Available: {', '.join(_RELAY_PRESETS.keys())}", file=sys.stderr)
            sys.exit(1)
        preset = _RELAY_PRESETS[preset_name]
        prompts = preset["prompts"]
        print(f"[relay-variant] Preset: {preset_name} ({len(prompts)} prompts)")
    else:
        prompts = _load_prompts(args)

    n_variants = len(variant_names)
    print(f"[relay-variant] ═══ Relay Variant A/B Test ═══")
    print(f"[relay-variant] {n_variants} variant(s) × {len(prompts)} segment(s)")

    results = []
    manifest_files = []

    for vi, vname in enumerate(variant_names):
        vcfg = _RELAY_VARIANTS[vname]
        label = vcfg["label"]
        print(f"\n{'═' * 60}")
        print(f"[relay-variant] Variant {vi+1}/{n_variants}: {vname}")
        print(f"[relay-variant]   {label}")
        print(f"[relay-variant]   distilled={vcfg['distilled']}  "
              f"lora={vcfg.get('lora_path') or 'none'}  "
              f"cfg={vcfg['cfg_scale']}  stg={vcfg['stg_scale']}")
        print(f"{'═' * 60}")

        # Build args copy with variant overrides
        # Start from a shallow copy of the original args namespace
        v_args = copy.copy(args)

        # Override with variant config
        v_args.distilled = vcfg["distilled"]
        v_args.lora_path = vcfg.get("lora_path")
        v_args.lora_scale = vcfg.get("lora_scale", 1.0)
        v_args.cfg_scale = vcfg["cfg_scale"]
        v_args.stg_scale = vcfg["stg_scale"]

        # Apply preset overrides for resolution/duration
        if preset:
            v_args.relay_prompts = list(prompts)
            v_args.relay_prompt_file = None
            v_args.width = preset.get("width", getattr(args, "width", 704))
            v_args.height = preset.get("height", getattr(args, "height", 448))
            v_args.relay_duration = preset.get("duration", getattr(args, "relay_duration", 8.0))
        else:
            # Ensure prompts are set on args
            if not getattr(v_args, "relay_prompts", None) and not getattr(v_args, "relay_prompt_file", None):
                v_args.relay_prompts = list(prompts)
                v_args.relay_prompt_file = None

        # Suffix output with variant name
        v_args.relay_variant_suffix = vname
        # Clear variant flag to prevent recursion
        v_args.relay_variant = None

        t0 = datetime.now(timezone.utc)
        try:
            _run_relay_inner(v_args)
            elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
            results.append({"variant": vname, "label": label, "status": "ok", "elapsed": elapsed})
            # Collect manifest path for reviewer
            mf = getattr(v_args, "_last_manifest_file", None)
            if mf and os.path.exists(mf):
                manifest_files.append(mf)
        except SystemExit as e:
            elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
            results.append({"variant": vname, "label": label, "status": f"exit({e.code})",
                            "elapsed": elapsed})
        except Exception as exc:
            elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
            results.append({"variant": vname, "label": label, "status": f"error: {exc}",
                            "elapsed": elapsed})

        # Free GPU memory between variants
        if vi < n_variants - 1:
            print(f"\n[relay-variant] Freeing GPU memory…")
            gc.collect()
            try:
                import mlx.core as mx
                mx.clear_cache()
            except ImportError:
                pass

    # Summary table
    print(f"\n{'═' * 60}")
    print(f"[relay-variant] Variant Comparison Summary")
    print(f"{'═' * 60}")
    print(f"  {'Variant':<30} {'Status':<10} {'Time':>8}")
    print(f"  {'─' * 30} {'─' * 10} {'─' * 8}")
    for r in results:
        status_tag = "✓" if r["status"] == "ok" else "✗"
        mins = r["elapsed"] / 60
        print(f"  {r['variant']:<30} {status_tag + ' ' + r['status']:<10} {mins:>6.1f} min")
    print(f"{'═' * 60}")

    # Auto-launch HTML video reviewer for side-by-side comparison
    if manifest_files:
        print(f"\n[relay-variant] Launching video reviewer ({len(manifest_files)} manifests)…")
        import importlib
        _review_mod = importlib.import_module("app.commands.video-review")
        review_args = types.SimpleNamespace(
            labels=",".join(r["label"] for r in results if r["status"] == "ok"),
            output=None,
            no_open=False,
        )
        _review_mod._launch_review(review_args, manifest_files)


def _run_relay_inner(args):
    prompts = _load_prompts(args)
    n = len(prompts)
    print(f"[relay] {n} segment(s) detected")

    # Resolution + frame count
    width = getattr(args, "width", 704)
    height = getattr(args, "height", 448)
    distilled = getattr(args, "distilled", False)
    width, height = _adjust_resolution(width, height, distilled=distilled)

    fps = getattr(args, "fps", 24.0)
    relay_duration = getattr(args, "relay_duration", 8.0)
    frames = _duration_to_frames(relay_duration, fps)

    print(f"[relay] Resolution: {width}×{height}  "
          f"Duration: {relay_duration}s × {n} = {relay_duration * n:.0f}s total  "
          f"Frames/segment: {frames} @ {fps:.0f}fps")

    # Stage steps defaults
    hq = getattr(args, "hq", False)
    stage1_steps = getattr(args, "stage1_steps", None)
    stage2_steps = getattr(args, "stage2_steps", None)
    if hq and stage1_steps is None:
        stage1_steps = 15
        print("[relay] HQ mode: stage1_steps auto-set to 15")
    if stage1_steps is None:
        stage1_steps = 8
    if stage2_steps is None:
        stage2_steps = 3

    cfg_scale = getattr(args, "cfg_scale", 5.0)
    stg_scale = getattr(args, "stg_scale", 1.0)
    base_seed = getattr(args, "seed", 42)
    low_ram = getattr(args, "low_ram", False)
    lora_path = resolve_lora_path(getattr(args, "lora_path", None))
    lora_scale = getattr(args, "lora_scale", 1.0)

    segment_images = _resolve_segment_images(args, n)
    relay_audio = getattr(args, "relay_audio", None)
    audio_mode = getattr(args, "relay_audio_mode", "replace")

    # Auto-generate TTS narration if --relay-tts-text provided and no --relay-audio
    tts_text = getattr(args, "relay_tts_text", None)
    if tts_text and not relay_audio:
        tts_engine = getattr(args, "relay_tts_engine", "say")
        tts_voice = getattr(args, "relay_tts_voice", None)
        tts_rate = getattr(args, "relay_tts_rate", None)
        ext = "mp3" if tts_engine == "edge-tts" else "aac"
        tts_out = os.path.join(tempfile.gettempdir(), f"relay_tts_auto.{ext}")
        print(f"[relay] Generating TTS narration (engine={tts_engine}, "
              f"voice={tts_voice or 'default'})…")
        _generate_tts_audio(tts_text, tts_engine, tts_voice, tts_rate, tts_out)
        relay_audio = tts_out
        print(f"[relay] TTS audio: {tts_out}")

    # Validate audio file
    if relay_audio and not os.path.exists(relay_audio):
        print(f"ERROR: audio file not found: {relay_audio}", file=sys.stderr)
        sys.exit(1)

    # Pre-flight summary
    print(f"[relay] cfg={cfg_scale}  stg={stg_scale}  "
          f"s1_steps={stage1_steps}  s2_steps={stage2_steps}  "
          f"low-ram={low_ram}  hq={hq}")
    if lora_path:
        print(f"[relay] LoRA: {os.path.basename(lora_path)} (scale={lora_scale})")
    for i, (prompt, img) in enumerate(zip(prompts, segment_images)):
        img_label = os.path.basename(img) if img else ("relay frame" if i > 0 else "T2V")
        print(f"[relay] Segment {i+1}/{n}: [{img_label}] {prompt[:80]}")
    if relay_audio:
        print(f"[relay] Audio overlay: {os.path.basename(relay_audio)}")

    # Estimate total time (rough: 8 steps × empirical slope)
    mpx = width * height * frames / 1_000_000
    eta_per_seg = stage1_steps * 0.237 * mpx + stage2_steps * 0.495 * mpx + 0.251 * mpx + 7.4
    eta_total = eta_per_seg * n
    print(f"[relay] Estimated: {eta_per_seg:.0f}s/segment × {n} = "
          f"{eta_total:.0f}s ({eta_total / 60:.1f} min)")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name()
    # Append variant suffix when running in A/B comparison mode
    variant_suffix = getattr(args, "relay_variant_suffix", None)
    if variant_suffix:
        base_name = f"{base_name}_{variant_suffix}"
    base_path = os.path.join(cfg.OUTPUT_DIR, base_name)

    # Inject attrs expected by RunConfig.from_args
    for attr, val in [("pipeline", "ltx-relay"), ("audio", None),
                      ("begin_image", None), ("end_image", None),
                      ("distilled", False), ("temporal_upscale", False),
                      ("teacache", False), ("teacache_thresh", None),
                      ("audio_stage1_only", False), ("audio_cfg_scale", None),
                      ("audio_volume", None), ("allow_noise", False),
                      ("enhance_prompt", False), ("variations", 1),
                      ("ab_params", None), ("yes", False),
                      ("first_frame", False), ("caption", False),
                      ("skip_gpu_lock", False), ("video_model", None),  # noqa: keep for RunConfig compat
                      ("prompt", prompts[0]), ("prompt_file", None),
                      ("input_image", segment_images[0]),
                      ("lora_path", lora_path), ("lora_scale", lora_scale)]:
        if not hasattr(args, attr):
            setattr(args, attr, val)
    # Override resolved values
    args.width = width
    args.height = height
    args.frames = frames
    args.fps = fps
    args.stage1_steps = stage1_steps
    args.stage2_steps = stage2_steps
    args.prompt = prompts[0]
    args.input_image = segment_images[0]
    args.lora_path = lora_path
    args.lora_scale = lora_scale

    run_file = base_path + ".run.json"
    manifest_file = base_path + ".manifest.json"
    run_config = RunConfig.from_args(args, command="video relay")
    run_config.to_json(run_file)

    start_time = datetime.now(timezone.utc).isoformat()
    segment_outputs = []
    all_timings = {}

    try:
        from app.ltx_pipeline import LTXVideoPipeline

        # Load pipeline ONCE — reuse across all segments
        pipeline = LTXVideoPipeline(
            model_dir=getattr(args, "video_model", None),
            low_ram=low_ram,
            hq=hq,
            distilled=distilled,
            temporal_upscale=False,
            lora_path=lora_path,
            lora_scale=lora_scale,
        )

        prev_mp4 = None

        for i, prompt in enumerate(prompts):
            seg_num = i + 1
            seed = base_seed + i  # distinct seed per segment
            output_mp4 = f"{base_path}_seg{seg_num:02d}.mp4"

            # Determine input image
            input_img = segment_images[i]
            if input_img is None and i > 0:
                # Relay: extract last frame of previous segment
                relay_frame = f"{base_path}_seg{i:02d}_relay.png"
                print(f"\n[relay] Extracting last frame of segment {i} → relay.png")
                if not _extract_last_frame(prev_mp4, relay_frame):
                    print(f"ERROR: failed to extract last frame from {prev_mp4}",
                          file=sys.stderr)
                    sys.exit(1)
                input_img = relay_frame

            mode = "I2V" if input_img else "T2V"
            print(f"\n[relay] ═══ Segment {seg_num}/{n} [{mode}] seed={seed} ═══")
            print(f"[relay] Prompt: {prompt}")
            if input_img:
                print(f"[relay] Image:  {os.path.basename(input_img)}")

            timings = pipeline.generate(
                prompt=prompt,
                output_path=output_mp4,
                height=height,
                width=width,
                num_frames=frames,
                frame_rate=fps,
                seed=seed,
                stage1_steps=stage1_steps,
                stage2_steps=stage2_steps,
                cfg_scale=cfg_scale,
                stg_scale=stg_scale,
                image=input_img,
                enable_teacache=getattr(args, "teacache", False),
                teacache_thresh=None,
            )

            all_timings[f"seg{seg_num:02d}"] = timings
            segment_outputs.append({
                "segment": seg_num,
                "path": output_mp4,
                "prompt": prompt,
                "mode": mode,
                "seed": seed,
                "input_image": input_img,
                "size_bytes": os.path.getsize(output_mp4),
                "width": width,
                "height": height,
                "frames": frames,
                "fps": fps,
            })
            prev_mp4 = output_mp4
            print(f"[relay] Segment {seg_num} saved: {output_mp4}")

        # Concatenate all segments
        print(f"\n[relay] Concatenating {n} segments…")
        relay_mp4 = getattr(args, "relay_output", None) or f"{base_path}_relay.mp4"
        segment_paths = [s["path"] for s in segment_outputs]
        _concat_videos(segment_paths, relay_mp4)
        relay_size = os.path.getsize(relay_mp4)
        print(f"[relay] Concatenated: {relay_mp4} ({relay_size / 1_048_576:.1f} MB)")

        # Overlay / mix audio track
        if audio_mode != "keep" and relay_audio:
            print(f"[relay] Overlaying audio ({audio_mode}): {relay_audio}")
            _mux_audio_track(relay_mp4, relay_audio, relay_mp4, mode=audio_mode)
        elif audio_mode == "keep":
            print("[relay] Audio mode: keep (model-generated audio preserved)")

        end_time = datetime.now(timezone.utc).isoformat()

        output_files = segment_outputs + [{
            "path": relay_mp4,
            "mode": RELAY_FINAL_MODE,
            "segments": n,
            "size_bytes": relay_size,
            "width": width,
            "height": height,
            "frames": frames * n,
            "fps": fps,
            "audio": os.path.basename(relay_audio) if relay_audio else None,
        }]

        models = _collect_relay_fingerprints(pipeline._model_dir, lora_path)
        manifest = Manifest.from_success(run_file, start_time, end_time,
                                         all_timings, output_files, models)
        manifest.to_json(manifest_file)

        peak_gb = manifest.memory_peak_mb / 1024
        print(f"\n[relay] ══════════════════════════════════════════")
        print(f"[relay] Final video: {relay_mp4}")
        print(f"[relay] Run:         {run_file}")
        print(f"[relay] Manifest:    {manifest_file}")
        print(f"[relay] Peak RAM:    {peak_gb:.1f} GB")
        print(f"[relay] Segments:    {n} × {relay_duration:.0f}s = "
              f"{relay_duration * n:.0f}s total")

        # Extract first-frame thumbnail for video reviewer
        thumb_path = base_path + ".png"
        if _extract_first_frame_relay(relay_mp4, thumb_path):
            print(f"[relay] Thumbnail:   {thumb_path}")

        # Record paths on args for variant comparison to collect
        args._last_manifest_file = manifest_file
        args._last_relay_mp4 = relay_mp4
        args._last_thumb_path = thumb_path

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, {}, exc, {})
        manifest.to_json(manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


def _collect_relay_fingerprints(model_dir: str, lora_path: str | None) -> dict:
    """Fingerprint key model files for the relay run (dev pipeline)."""
    from app.manifest import file_fingerprint

    key_files = [
        "transformer-dev.safetensors",
        "ltx-2.3-22b-distilled-lora-384.safetensors",
        "connector.safetensors",
        "spatial_upscaler_x2_v1_1.safetensors",
        "vae_encoder.safetensors",
        "vae_decoder.safetensors",
    ]
    models = {}
    if model_dir and os.path.isdir(model_dir):
        for fname in key_files:
            fpath = os.path.join(model_dir, fname)
            if os.path.exists(fpath):
                models[fname] = file_fingerprint(fpath)
    if lora_path and os.path.exists(lora_path):
        models["lora"] = file_fingerprint(lora_path)
    return models
