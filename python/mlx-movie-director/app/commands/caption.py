"""caption — generate image description using Qwen3-VL via local OpenAI-compatible API."""

import argparse
import base64
import html
import io
import json
import os
import re
import shutil
import sys
import time
from typing import Any

import requests
from PIL import Image

PARSER_META = {
    "help": "Generate caption using Qwen3-VL (image or video)",
    "description": (
        "Caption an image or video using a local Qwen3-VL model.\n\n"
        "For images: uses the full image directly.\n"
        "For videos: extracts evenly-spaced keyframes and sends them as multiple images.\n\n"
        "Examples:\n"
        "  run.py caption output/base.png\n"
        "  run.py caption output/video.mp4\n"
        "  run.py caption video.mp4 --style video_score --lang en\n"
        "  run.py caption video.mp4 --style video_analysis\n"
        "  run.py caption base.png --style photography\n"
        "  run.py caption base.png --style t2i --lang en\n"
        "  run.py caption base.png --style score --lang en  ← VLM quality scoring\n"
    ),
}

# Shared defect-hunting + hard-cap block — the anti-over-praise guardrail.
# Used by BOTH the `score` and `review` styles so they cannot drift apart. The
# `review` style historically lacked this block and over-praised plasticky-skin
# images ~9/10 (while `score`, with it, scored the same skin 4-6); since the
# run-self-improve-image workflow gates autoFix on the REVIEW-style scores, that
# drift silently defeated the self-fix loop. Keeping one block prevents recurrence.
# `detail <= 6` on the plasticky-skin rule: no visible pores IS a detail failure
# (the detail dim is defined on skin pores), so an honest cap belongs there too.
_DEFECT_BLOCK = (
    "DEFECT CHECK (do this first; be ruthless — hunt for each of these):\n"
    "- PLASTICKY / WAXY / OVERSMOOTHED SKIN: skin with no visible pores that "
    "looks like a mannequin, wax doll, or airbrushed plastic. This is the most "
    "common AI defect — check forehead, cheeks, shoulders, hands, and arms.\n"
    "- HANDS & FINGERS: wrong finger count, fused/merged fingers, extra or "
    "missing fingers, malformed hands, or extra/missing/fused limbs.\n"
    "- FACE: asymmetric eyes or ears, mismatched pupils, deformed teeth, "
    "melting or drifting features.\n"
    "- STRUCTURE & SYMMETRY: warped body proportions, fused clothing, "
    "floating or duplicated objects.\n"
    "- BACKGROUND: chaotic/melting background, nonsensical objects, seams, "
    "or ghosting.\n\n"
    "HARD RULES (override any holistic impression):\n"
    "- If skin looks plasticky/waxy/oversmoothed (no visible pores): artifacts <= 5, detail <= 6, AND overall <= 7.\n"
    "- If ANY hand has a wrong finger count or fused fingers: artifacts <= 4 AND overall <= 6.\n"
    "- If there are extra limbs or fused body parts: artifacts <= 3 AND overall <= 4.\n"
    "- Give artifacts 9-10 ONLY if you genuinely cannot find ANY defect above.\n\n"
)

_STYLE_PROMPTS = {
    "default": "Describe this image in detail.",
    "photography": (
        "Describe this photo as a photography prompt. "
        "Include: subject, pose, clothing, lighting, camera angle, composition, mood, and setting."
    ),
    "t2i": (
        "Write a detailed text-to-image generation prompt for this image. "
        "Describe subject, appearance, clothing, pose, background, lighting, style, and atmosphere. "
        "Output only the prompt, no preamble."
    ),
    "profile": (
        "仔细描述这个人物的服装和外貌。"
        "包括：上衣、下装、鞋子、配饰、发型、发色、肤色。"
        "只输出服装和外貌描述，不要描述背景、姿势或构图。"
        "用简体中文回答，使用简洁的逗号分隔列表格式。"
    ),
    "style": (
        "Describe the ART STYLE and RENDERING TECHNIQUE of this image. "
        "Include: medium (digital painting, anime cel-shading, watercolor, oil, 3D render, etc.), "
        "color palette (vibrant/muted, warm/cool, dominant hues), "
        "lighting style (soft/dramatic/flat, ambient/directional), "
        "line work (thick/thin, present/absent, ink/pencil), "
        "texture/shading technique (smooth/grainy, flat/cross-hatch, gradient), "
        "overall aesthetic (realistic/semi-realistic/stylized/cartoon/anime). "
        "Output ONLY the style description as a comma-separated list. "
        "Answer in English."
    ),
    "score": (
        "You are a STRICT, ADVERSARIAL image quality evaluator. AI-generated "
        "images almost always carry subtle flaws — your job is to FIND them, not "
        "to praise. Do not be lenient; a polished-looking image can still fail on "
        "skin texture or hands.\n\n"
        + _DEFECT_BLOCK
        + "Then score on a 1-10 scale (respect the HARD RULES caps on overall/artifacts):\n"
        "1. overall — overall image quality and aesthetic appeal\n"
        "2. detail — level of fine detail (textures, fabric, skin pores, hair)\n"
        "3. sharpness — image sharpness and clarity across the frame\n"
        "4. composition — framing, rule of thirds, visual balance\n"
        "5. prompt_adherence — how well the image matches a typical text-to-image prompt intent\n"
        "6. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts, 1 = severe)\n\n"
        "Respond with ONLY a JSON object (no markdown fences, no explanation):\n"
        '{"overall": N, "detail": N, "sharpness": N, "composition": N, '
        '"prompt_adherence": N, "artifacts": N, '
        '"issues": ["..."], "strengths": ["..."], "summary": "one sentence"}\n'
        "Each score is an integer 1-10. List EVERY defect you found in issues[]."
    ),
    "video_score": (
        "You are a professional video quality evaluator. "
        "The images below are EVENLY-SPACED KEYFRAMES from a single generated video. "
        "Analyze them together to assess the video's overall quality.\n\n"
        "Evaluate these dimensions on a scale of 1-10:\n"
        "1. overall — overall video quality and aesthetic appeal\n"
        "2. sharpness — image sharpness and clarity across frames\n"
        "3. detail_preservation — level of fine detail (textures, faces, objects)\n"
        "4. color_lighting — color accuracy, lighting quality, exposure consistency\n"
        "5. temporal_coherence — how consistent objects/subjects appear across frames "
        "(do shapes, faces, and positions change smoothly or flicker/jump)\n"
        "6. artifacts — absence of rendering artifacts like blur, noise, blockiness, "
        "or seams (INVERTED: 10 = no artifacts, 1 = severe)\n\n"
        "Respond with ONLY a JSON object (no markdown fences, no explanation):\n"
        '{"overall": N, "sharpness": N, "detail_preservation": N, '
        '"color_lighting": N, "temporal_coherence": N, "artifacts": N, '
        '"issues": "...", "strengths": "...", "summary": "one-sentence assessment"}\n'
        "Each score is an integer 1-10."
    ),
    "video_analysis": (
        "The images below are EVENLY-SPACED KEYFRAMES from a single generated video.\n\n"
        "Analyze the video's content and production quality. Report:\n"
        "1. scene_description — what is happening in the video (subject, action, setting)\n"
        "2. camera_movement — is the camera static, panning, zooming, tracking?\n"
        "3. motion_quality — does motion appear smooth and natural, or jittery/stuttering?\n"
        "4. subject_consistency — does the main subject change appearance between frames?\n"
        "5. overall_quality — one-sentence quality summary\n\n"
        "Respond with ONLY a JSON object (no markdown fences):\n"
        '{"scene_description": "...", "camera_movement": "...", '
        '"motion_quality": "...", "subject_consistency": "...", '
        '"overall_quality": "..."}'
    ),
    "compare": (
        "Describe this image in ONE short sentence (max 25 words). "
        "Focus on: subject appearance (hair color, clothing), style (realistic/anime/3D), "
        "and overall quality. Output only the sentence, nothing else."
    ),
    "review": (
        "You are a STRICT image quality evaluator reviewing a TEXT-TO-IMAGE output.\n\n"
        "ORIGINAL PROMPT given to the generator:\n"
        "---\n"
        "{prompt}\n"
        "---\n\n"
        "STEP 1 — ELEMENT CHECK (do this first; be literal and strict):\n"
        "Split the prompt into its key elements: subject, clothing, pose, setting/background, "
        "STYLE or MEDIUM (oil painting, watercolor, anime, 3D render, photograph, etc.), lighting, "
        "color palette. For each element mark PRESENT or ABSENT in the image. "
        "STYLE/MEDIUM is CRITICAL: if the prompt names a style/medium and the image is NOT in that "
        "style (e.g. prompt 'oil painting' but image is a clean studio photo), mark it ABSENT.\n\n"
        "STEP 2 — prompt_adherence is a DETERMINISTIC function of the element check, NOT a holistic "
        "guess: adherence = round(10 x present_count / total_count), then if ANY style/medium "
        "element is ABSENT, CAP adherence at 5. A matching subject/pose does NOT redeem a wrong "
        "style — never score 8-10 when a named style/medium is absent.\n\n"
        + _DEFECT_BLOCK
        + "STEP 3 — general quality dimensions (1-10, respect the HARD RULES caps above):\n"
        "1. overall — overall image quality and aesthetic appeal\n"
        "2. detail — level of fine detail (textures, fabric, skin pores, hair)\n"
        "3. sharpness — image sharpness and clarity across the frame\n"
        "4. composition — framing, rule of thirds, visual balance\n"
        "5. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts)\n\n"
        "List captured[] (PRESENT elements) and missed[] (ABSENT/wrong elements).\n\n"
        'Respond with ONLY a JSON object (no markdown fences):\n'
        '{{"overall": N, "detail": N, "sharpness": N, "composition": N, '
        '"prompt_adherence": N, "artifacts": N, '
        '"captured": ["..."], "missed": ["..."], '
        '"issues": ["..."], "strengths": ["..."], "summary": "one sentence"}}\n'
        "Each score is an integer 1-10."
    ),
    "playwright": (
        "You are analyzing a SCREENSHOT of a web application's graphical user interface to help "
        "guide browser automation (Playwright). Describe the page so an automation agent can "
        "understand and interact with it WITHOUT seeing the screen.\n\n"
        "Report:\n"
        "1. LAYOUT — the major page regions/panels (e.g. left sidebar nav, top bar, main content, "
        "right output panel) and what each is for.\n"
        "2. INTERACTIVE ELEMENTS — list every control by its VISIBLE LABEL or placeholder text, "
        "with its type: button, text input (give placeholder), dropdown/select (list the options "
        "and which is selected), checkbox (checked?), slider (current value), radio, link, tab. "
        "Quote the exact on-screen text.\n"
        "3. STATE — currently selected values, filled-in field values, disabled/greyed-out "
        "controls, badges or counts (e.g. '12 failed'), error/warning/status messages, loading "
        "spinners, empty states.\n"
        "4. PRIMARY ACTION — the main submit/action button: its label, and whether it looks "
        "enabled or disabled.\n\n"
        "Be precise and exhaustive about labels and current values — those are what an "
        "automation agent keys on to locate elements. Answer in English."
    ),
    "lora_quality": (
        "You are a STRICT LoRA adapter quality evaluator. Determine whether the LoRA effect\n"
        "is VISIBLE at the given scale, and whether the scale causes over-activation.\n\n"
        "LoRA: {lora_name}\n"
        "Description: {lora_description}\n"
        "Scale applied: {scale}\n\n"
        "═══ STEP 1 — IS THE LoRA EFFECT VISIBLE? ═══\n"
        "Decide before scoring anything: does this image show ANY influence from this LoRA?\n"
        "Mentally compare to what the base model would produce WITHOUT this LoRA.\n"
        "- If you CANNOT tell that any LoRA style was applied → activation_level = 'under'\n"
        "- If LoRA style is clearly present and appropriate → activation_level = 'correct'\n"
        "- If LoRA has warped, filtered, or distorted the image → activation_level = 'over'\n\n"
        "SPECIAL CASE — BASELINE IMAGE (scale=0, scale=null, or scale='none'):\n"
        "No LoRA was applied. Unconditionally set:\n"
        "  lora_activation=1, activation_level='under', gate='fail'.\n"
        "Score overall/detail/artifacts for the base image quality only.\n\n"
        "═══ STEP 2 — OVER-ACTIVATION SYMPTOMS (hunt for ALL) ═══\n"
        "ONE symptom = activation_level must be 'over':\n"
        "- Watercolor wash or paint filter replacing photorealism\n"
        "- Extreme skin smoothing / plastic / airbrushed look — no visible pores\n"
        "- Color shift toward stylized palette (over-saturated, art-filter, too warm)\n"
        "- Style bleeding: anime or cartoon features imposed on a photo-realist subject\n"
        "- Loss of fine texture — detail replaced by flat or smeared shading\n"
        "- Any REGRESSION in image quality vs. what the base model alone would produce\n\n"
        "═══ STEP 3 — UNDER-ACTIVATION SYMPTOMS ═══\n"
        "If ANY apply, activation_level must be 'under':\n"
        "- No visible LoRA style influence — image indistinguishable from base-model output\n"
        "- Subject characteristics expected from this LoRA are absent\n"
        "- Trigger content for this LoRA is missing despite correct prompt\n\n"
        + _DEFECT_BLOCK
        + "═══ SCORING RULES ═══\n"
        "MANDATORY CONSISTENCY — enforce before writing JSON:\n"
        "  activation_level='under'   → lora_activation MUST be 1-4\n"
        "  activation_level='correct' → lora_activation MUST be 6-10\n"
        "  activation_level='over'    → lora_activation MUST be 1-3 (artifacts tank the score)\n\n"
        "Score each dimension 1-10 (respect HARD RULES caps from the defect check above):\n"
        "1. overall — overall image quality and aesthetic appeal\n"
        "2. detail — level of fine detail (pores, hair, fabric texture)\n"
        "3. artifacts — absence of LoRA-induced artifacts (INVERTED: 10 = zero artifacts)\n"
        "4. lora_activation — how PRESENT and CORRECT the LoRA style effect is at this scale:\n"
        "   10 = LoRA style CLEARLY VISIBLE + appropriate + no artifacts (BOTH required)\n"
        "   5  = marginal — faint or barely distinguishable from base-model output\n"
        "   1  = completely absent (baseline/invisible) OR severely over-activated\n"
        "   WARNING: 'no artifacts' alone does NOT justify a high score.\n"
        "   A clean baseline scores lora_activation=1 because the LoRA effect is ABSENT.\n\n"
        "GATE VERDICT — choose exactly one:\n"
        '- "pass": LoRA effect CLEARLY VISIBLE AND appropriate (activation_level MUST be "correct")\n'
        '- "marginal": faint activation but usable, or very minor artifacts\n'
        '- "fail": LoRA invisible (under) OR over-activation artifacts (over)\n'
        "  RULE: activation_level='under' → gate is 'fail' or 'marginal' ONLY. Never 'pass'.\n"
        "  RULE: activation_level='over'  → gate is ALWAYS 'fail'.\n\n"
        'Respond with ONLY a JSON object (no markdown fences, no prose):\n'
        '{{"overall": N, "detail": N, "artifacts": N, "lora_activation": N,\n'
        ' "activation_level": "under|correct|over",\n'
        ' "gate": "pass|marginal|fail",\n'
        ' "over_symptoms": ["list any over-activation symptoms found, empty if none"],\n'
        ' "under_symptoms": ["list any under-activation symptoms found, empty if none"],\n'
        ' "issues": ["all quality defects found"], "strengths": ["notable strengths"],\n'
        ' "summary": "one sentence verdict"}}\n'
        "Each score is an integer 1-10."
    ),
    "ltx_i2v": (
        "You are an expert LTX-2.3 video generation prompt engineer.\n\n"
        "Analyze this image carefully: note the character's appearance (hair color/style, face, "
        "clothing, body type, art style — realistic/anime/3D), the setting, and lighting.\n\n"
        "The user wants the following action:\n"
        "---\n"
        "{action}\n"
        "---\n\n"
        "Generate an optimized LTX I2V (image-to-video) prompt in English that includes ALL of:\n"
        "1. CHARACTER ANCHOR — 1-2 sentences describing the character's appearance as seen in "
        "the image (hair color/style, clothing, body features). This anchors the video to the "
        "input frame.\n"
        "2. MOTION — detailed, physics-aware motion description matching the action intent. "
        "Describe body movement, limb positions, speed, facial expressions, hair/clothing "
        "movement from motion.\n"
        "3. VOICE LINES — the character's spoken words or vocal sounds in Traditional Chinese "
        "(zh-TW) by default, rendered as she says them (e.g., 她輕喘著說「嗯...啊...」). "
        "Include vocal quality (husky / high-pitched / breathless / soft). "
        "If the action contains no speaking, add natural breathing sounds instead.\n"
        "4. AMBIENT AUDIO — background or impact sounds that fit the scene.\n\n"
        "Output ONLY a JSON object (no markdown fences, no extra text):\n"
        '{"prompt": "the full LTX I2V prompt as one English paragraph", '
        '"voice_lang": "zh_TW", '
        '"motion_summary": "one-sentence motion summary in English", '
        '"estimated_seconds": <integer seconds>}'
    ),
    # pose_dsg — DSG/TIFA-style atomic faithfulness + AbHuman anatomy gate.
    # See bun-apps/s2-agent-ext-flux2/docs/pose-validation.md. Uses {prompt} +
    # {atoms_block} via str.replace (NOT .format — the JSON example has literal
    # braces). Single VLM call (batched/Soft-TIFA style) for local-MLX practicality.
    "pose_dsg": (
        "You are a STRICT pose-faithfulness evaluator for a text-to-image output. AI models "
        "routinely produce a pleasing image that DOES NOT match the requested pose — your job "
        "is to verify ATOM-BY-ATOM, not to give a holistic impression.\n\n"
        "ORIGINAL POSE PROMPT:\n"
        "---\n"
        "{prompt}\n"
        "---\n\n"
        + _DEFECT_BLOCK
        + "STEP 1 — ATOMIC DECOMPOSITION (DSG-style).\n"
        "{atoms_block}\n"
        "STEP 2 — ATOM VERIFICATION. For EACH atom, look at the image and decide whether it is "
        "TRUE (present=true) or FALSE (present=false), plus your confidence 0.0-1.0. Be literal: "
        "an atom is true only if you can see it in the image.\n\n"
        "STEP 3 — ANATOMY GATE (independent of atoms; hard pass/fail). These are NOT about the "
        "prompt — they are structural correctness any human image must satisfy:\n"
        "- limb_count: exactly 2 arms and 2 legs, no extra/fused/duplicated limbs\n"
        "- hands: every visible hand has <= 5 fingers, none fused/malformed/extra\n"
        "- face: IF the face is visible — features symmetric, two eyes, no melting/drift; "
        "use the string \"n/a\" when the face is not visible in the frame\n"
        "- pose_plausible: every joint within a plausible human range of motion, no twisted/"
        "broken/unnatural limb orientation\n\n"
        "Respond with ONLY a JSON object (no markdown fences, no prose, no comments):\n"
        '{"atoms":[{"id":"a1","q":"the atom statement","present":true,"confidence":0.9}],\n'
        ' "faithfulness": 0.0,\n'
        ' "anatomy":{"limb_count":true,"hands":true,"face":true,"pose_plausible":true},\n'
        ' "anatomy_pass": true,\n'
        ' "issues":["every defect and every failed atom"],\n'
        ' "summary":"one sentence"}\n'
        "Rules:\n"
        "- Each atom present is boolean true/false. confidence is a number 0.0-1.0.\n"
        "- faithfulness = (number of atoms with present=true) / (total atoms). Recompute it;\n"
        "  do not paste a round number.\n"
        "- face may be true, false, or \"n/a\". anatomy_pass is false if limb_count, hands, or\n"
        "  pose_plausible is false, OR if face is false (a visible-but-distorted face fails).\n"
        "  face \"n/a\" never fails the gate."
    ),
}

# Styles that require strict JSON output — response_format=json_object is set
# to prevent thinking-only models (Gemma-4) from producing an empty response.
_JSON_OUTPUT_STYLES = frozenset({"ltx_i2v"})

# Language instructions — appended to style prompt
_LANG_INSTRUCTIONS = {
    "zh_TW": "請用繁體中文回答。",
    "zh_CN": "请用简体中文回答。",
    "en": "Answer in English.",
    "ja": "日本語で答えてください。",
}

_DEFAULT_API_URL = "http://localhost:1234/v1"
# The canonical default VLM = the local LLM brain (gemma). Qwen3-VL-4B
# over-praises on score/review styles ([[vlm-caption-overpraise-qa-gap]]) and is
# load-flakey ([[lm-studio-vlm-load-failure]]); gemma-4 outperforms Qwen on
# vision, so a Gemma-4 variant is always preferred over Qwen. The default
# auto-load target is now gemma-4-12b-qat: it aligns with the Bun VLM stack
# (which already defaults to gemma-4-12b-qat) and with LM Studio's catalog
# (which leads with 12b), and it has a much faster cold-start than 26b/31b.
# The larger 31b/26b variants remain PREFERRED when already loaded (higher
# quality) and are reachable any time via an explicit --model. The default is
# auto-loaded when nothing is running.
_DEFAULT_MODEL = "google/gemma-4-12b-qat"
# Preferred VLMs in priority order — first loaded one wins.
# Gemma-4 variants outperform Qwen3-VL-4B on vision tasks; prefer any loaded
# Gemma-4 over Qwen. The larger 31B/26B variants are preferred for quality when
# already loaded; the 12B variant is the auto-load target (faster cold-start,
# aligns with the Bun VLM stack + LM Studio catalog which both lead with 12b).
_PREFERRED_MODELS = [
    "google/gemma-4-31b-qat",      # best quality (31B)
    "google/gemma-4-26b-a4b-qat",  # good quality (26B, faster)
    "google/gemma-4-12b-qat",      # default auto-load target (aligns with Bun VLM stack + LM Studio catalog; faster cold-start)
]
# Lightweight fallback chain — used ONLY when the default (gemma) is not
# downloaded on this machine. Qwen3-VL-4B is the lightweight VL model that
# auto-loads fast; it over-praises, so it is never the first choice, but it is
# the honest last resort when no Gemma variant is available locally.
_FALLBACK_MODELS = [
    "qwen/qwen3-vl-4b",  # lightweight VL (4B); over-praises — fallback only
]
# Keep for backward compat (single-model references elsewhere)
_PREFERRED_MODEL = _PREFERRED_MODELS[0]

# Per-request timeout for VLM chat completions. Large (26B) models can take well
# over a minute on a COLD first inference (MLX graph compilation), which used to
# blow past the old 120s ceiling and time out. 300s tolerates cold start while
# still bounding a genuine hang. Applied to both single- and multi-image paths.
_VLM_REQUEST_TIMEOUT = 300


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("image", nargs="?", default=None, metavar="IMAGE",
                        help="Input image path (positional shorthand for --input-image)")
    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Input image path (flag form)")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output JSON path (default: <image>.caption.json)")
    parser.add_argument("--api-url", type=str, default=_DEFAULT_API_URL,
                        help=f"VLM API base URL (default: {_DEFAULT_API_URL})")
    parser.add_argument("--model", type=str, default=None,
                        help="Model name. If omitted, auto-select: first loaded Gemma-4 variant "
                        f"({', '.join(_PREFERRED_MODELS)}) wins; otherwise auto-load "
                        f"{_DEFAULT_MODEL}; if that isn't downloaded, fall back to "
                        f"{', '.join(_FALLBACK_MODELS)}.")
    parser.add_argument("--style", nargs="+", choices=list(_STYLE_PROMPTS.keys()), default=["t2i"],
                        help="Caption style(s) (default: t2i). Accepts ONE OR MORE styles; each is "
                        "a separate VLM call and all merge into the same <image>.caption.json "
                        "under the `styles` map, so e.g. --style default score yields both a "
                        "description and a quality score in one file. Single-value usage "
                        "(--style score) is unchanged.")
    parser.add_argument("--lang", choices=list(_LANG_INSTRUCTIONS.keys()), default="zh_TW",
                        help="Output language (default: zh_TW)")
    parser.add_argument("--no-auto-load", action="store_true",
                        help="Don't auto-load the VLM in LM Studio before captioning "
                        "(assume the model is already loaded)")
    parser.add_argument("--prompt", type=str, default=None, metavar="TEXT",
                        help="Original T2I prompt (used by 'review' style for adherence evaluation, "
                        "and by 'pose_dsg' for atomic pose-faithfulness evaluation)")
    parser.add_argument("--atoms", type=str, default=None, metavar="PATH|JSON",
                        help="Atomic yes/no propositions for 'pose_dsg' (DSG-style decomposition). "
                        "Either a path to a JSON file ({atoms:[{id,q},...]}) or an inline JSON "
                        "string. If omitted, the VLM self-decomposes the --prompt into atoms.")
    parser.add_argument("--view", choices=["front", "back", "side"], default=None,
                        help="Profile view label (front|back|side). With --style review/score, injects "
                             "per-view EXPECTED framing elements into the captured[]/missed[] checklist "
                             "so multi-view images are scored on a common, view-appropriate yardstick "
                             "(otherwise front/side `captured` arrays are sparse/empty because the base "
                             "prompt names no view-specific elements). Used by the multi-view workflow.")
    parser.add_argument("--action", type=str, default=None, metavar="TEXT",
                        help="User action intent (used by 'ltx_i2v' style for VLM I2V prompt generation)")
    parser.add_argument("--lora-name", type=str, default=None, metavar="NAME",
                        help="LoRA name (used by 'lora_quality' style)")
    parser.add_argument("--lora-description", type=str, default=None, metavar="DESC",
                        help="LoRA description (used by 'lora_quality' style)")
    parser.add_argument("--lora-scale", type=float, default=None, metavar="SCALE",
                        help="LoRA scale applied during generation (used by 'lora_quality' style)")
    parser.add_argument("--frames", type=int, default=8, metavar="N",
                        help="Number of keyframes for video captioning (default: 8)")
    parser.add_argument("--review-html", type=str, nargs="+", metavar="JSON",
                        help="Generate feedback HTML from caption JSON files (exits after HTML generation)")
    parser.add_argument("--ab-manifest", type=str, default=None, metavar="PATH",
                        help="Generate a MULTI-SET A/B review HTML from a manifest JSON "
                        "({sets:[{name, prompt?, variants?:[{label}], files:[caption_jsons]}]}). "
                        "Exits after HTML generation. Produces one <section> per set.")
    parser.add_argument("--html-output", type=str, default=None, metavar="PATH",
                        help="Output path for --review-html/--ab-manifest (default: "
                        "output/review_<timestamp>.html next to the images)")
    parser.add_argument("--samples", type=int, default=1, metavar="N",
                        help="Run N independent VLM samples and write the per-dimension MEDIAN "
                        "of their scores to --output (for --style score VLM-noise denoising; "
                        "default 1 = single sample, current behavior). The median keeps the "
                        "single-sample schema and adds a `scoreSamples` count. Moving the loop "
                        "into Python (rather than N CLI calls) keeps the model loaded and costs "
                        "zero orchestration tokens. Ignored for video / --review-html / --ab-manifest.")


def _normalize_caption_file(data: dict) -> dict:
    """Migrate a legacy flat single-style caption record to the multi-style
    `styles` map format. Already-normalized files (with a `styles` key) pass
    through unchanged. Legacy files guess their style key from their own
    `style` field, defaulting to "default" when absent.
    """
    if isinstance(data.get("styles"), dict):
        return data
    style = data.get("style") or "default"
    return {
        "image": data.get("image"),
        "video": data.get("video"),
        "model": data.get("model"),
        "updated_style": style,
        "styles": {
            style: {
                "model": data.get("model"),
                "elapsed_sec": data.get("elapsed_sec"),
                "caption": data.get("caption"),
            }
        },
    }


def _load_existing_styles(output_path: str) -> dict:
    """Read and normalize the styles map from an existing caption.json, if any."""
    if not os.path.exists(output_path):
        return {}
    try:
        with open(output_path) as f:
            existing = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return _normalize_caption_file(existing).get("styles", {})


def run(args: argparse.Namespace) -> None:
    # --ab-manifest mode: build a MULTI-SET A/B review HTML from a manifest JSON
    if getattr(args, "ab_manifest", None):
        html_path = generate_review_html(
            manifest_path=args.ab_manifest,
            output_path=getattr(args, "html_output", None),
        )
        print(f"Review HTML: {html_path}")
        return

    # --review-html mode: generate feedback HTML from caption JSON files (flat, single set)
    if getattr(args, "review_html", None):
        if getattr(args, "image", None) or getattr(args, "input_image", None):
            print("WARNING: --image is ignored when --review-html is used", file=sys.stderr)
        html_path = generate_review_html(
            args.review_html,
            output_path=getattr(args, "html_output", None),
        )
        print(f"Review HTML: {html_path}")
        return

    # Auto-select VLM: an explicit --model always wins; otherwise the resolved
    # default is the Gemma brain (preferred loaded variant, else auto-load
    # gemma-4-12b; Qwen3-VL-4b only as the no-gemma-downloaded fallback). Resolved
    # once here so the video/image branches and the output JSON all record the
    # actually-used model, and the over-praising Qwen is never silently picked.
    model = _resolve_model(args.api_url, args.model)

    from app.io_utils import require_file
    input_path = require_file(
        args.image or args.input_image,
        "input (positional arg or --input-image)",
    )

    # `--style` is one-or-more (default ["t2i"]). Each requested style is a
    # separate VLM call; all merge into the SAME <image>.caption.json `styles`
    # map (alongside any previously-generated styles), so `--style default score`
    # produces both a description and a quality score in one file in one go.
    styles_to_run = list(args.style)
    lang = args.lang

    # Detect video by extension
    video_exts = {".mp4", ".mov", ".avi", ".webm", ".mkv", ".gif"}
    is_video = os.path.splitext(input_path)[1].lower() in video_exts

    # Derive default output path: file.ext → file.caption.json
    output_path = args.output
    if output_path is None:
        base, _ = os.path.splitext(input_path)
        output_path = f"{base}.caption.json"

    n_samples = max(1, int(getattr(args, "samples", 1) or 1))
    sample_tag = f", x{n_samples} samples (median)" if n_samples > 1 else ""
    multi_tag = f" ({len(styles_to_run)} styles)" if len(styles_to_run) > 1 else ""

    # b64 is identical across styles for the same image — encode once.
    b64 = None if is_video else _image_to_base64(input_path)

    new_entries: dict[str, dict] = {}
    last_style = styles_to_run[-1]
    flat_record: dict = {}
    for style in styles_to_run:
        if is_video:
            # --- Video path (per style) ---
            n_frames = getattr(args, "frames", 8)
            print(f"Captioning video {input_path} (style={style}, lang={lang}, "
                  f"{n_frames} frames{multi_tag})...", flush=True)
            t0 = time.perf_counter()
            result = caption_video(
                input_path,
                style=style,
                lang=lang,
                n_frames=n_frames,
                api_url=args.api_url,
                model=model,
                auto_load=not getattr(args, "no_auto_load", False),
            )
            elapsed_sec = round(time.perf_counter() - t0, 2)
            preview_text = result.get("summary", json.dumps(result, ensure_ascii=False))
            entry = {"model": model, "frames": n_frames,
                     "elapsed_sec": elapsed_sec, "caption": result}
            flat_record = {"video": input_path, "frames": n_frames}
        else:
            # --- Image path (per style) ---
            prompt_text = _STYLE_PROMPTS[style]
            if style == "review":
                if not args.prompt:
                    print("ERROR: --prompt TEXT is required for 'review' style", file=sys.stderr)
                    sys.exit(1)
                prompt_text = prompt_text.format(prompt=args.prompt)
            elif style == "pose_dsg":
                if not args.prompt:
                    print("ERROR: --prompt TEXT is required for 'pose_dsg' style", file=sys.stderr)
                    sys.exit(1)
                atoms = _load_atoms(getattr(args, "atoms", None))
                prompt_text = build_pose_dsg_prompt(args.prompt, atoms)
            elif style == "ltx_i2v":
                if not getattr(args, "action", None):
                    print("ERROR: --action TEXT is required for 'ltx_i2v' style", file=sys.stderr)
                    sys.exit(1)
                # Use replace() not format(): the template's JSON example
                # contains literal {/} braces that confuse str.format().
                prompt_text = prompt_text.replace("{action}", args.action or "")
            elif style == "lora_quality":
                lora_name = getattr(args, "lora_name", None) or "unknown"
                lora_desc = getattr(args, "lora_description", None) or "no description"
                lora_scale = getattr(args, "lora_scale", None)
                scale_str = str(lora_scale) if lora_scale is not None else "unknown"
                prompt_text = prompt_text.format(
                    lora_name=lora_name,
                    lora_description=lora_desc,
                    scale=scale_str,
                )
            # Per-view framing elements (multi-view fair comparison). Applies to any
            # style whose prompt carries a captured[]/missed[] checklist (review, score).
            view = getattr(args, "view", None)
            if view:
                prompt_text += get_profile_view_elements_block(view)
            prompt_text += "\n" + _LANG_INSTRUCTIONS[lang]
            print(f"Captioning {input_path} (style={style}, lang={lang}"
                  f"{sample_tag}){multi_tag}...", end=" ", flush=True)
            # Time only the VLM call(s) — the meaningful cold/warm cost (b64 is
            # encoded once above). Recorded per-style as elapsed_sec.
            t0 = time.perf_counter()
            # Thinking models (Gemma-4) consume large token budgets on reasoning;
            # give JSON-output styles 40k so complex scenes have room to think + answer.
            _max_tokens = 40000 if style in _JSON_OUTPUT_STYLES else 2048
            # pose_dsg is single-call: its per-atom aggregation is not compatible
            # with median_score_caption (score-specific). --samples is ignored.
            if n_samples > 1 and style != "pose_dsg":
                # Multi-sample denoising: N VLM calls in-process (model stays
                # loaded), then median the numeric score dims in Python.
                raws = [
                    _call_vlm(args.api_url, model, b64, prompt_text,
                              auto_load=not getattr(args, "no_auto_load", False),
                              max_tokens=_max_tokens)
                    for _ in range(n_samples)
                ]
                caption_value = median_score_caption(raws)
            else:
                caption_value = _call_vlm(args.api_url, model, b64, prompt_text,
                                          auto_load=not getattr(args, "no_auto_load", False),
                                          max_tokens=_max_tokens)
            elapsed_sec = round(time.perf_counter() - t0, 2)
            if style == "pose_dsg" and n_samples > 1:
                print("  (pose_dsg ignores --samples; single VLM call used)", file=sys.stderr)
            if style == "pose_dsg":
                # Recompute faithfulness/anatomy_pass in Python — never trust a
                # model-arithmetic slip in the stored verdict (the null→default
                # lesson: don't trust an aggregate you can recompute).
                caption_value = parse_pose_dsg(caption_value)
                preview_text = (caption_value.get("summary")
                                or json.dumps(caption_value, ensure_ascii=False))
            else:
                preview_text = caption_value
            entry = {"model": model, "elapsed_sec": elapsed_sec, "caption": caption_value}
            flat_record = {"image": input_path}
        new_entries[style] = entry
        print(f"Done ({elapsed_sec}s)")
        preview = (preview_text or "")[:120].replace("\n", " ")
        print(f"  [{style}] {preview}..." if len(preview) == 120 else f"  [{style}] {preview}")

    # Merge every new style into the existing multi-style caption.json (if any),
    # preserving previously-generated styles for the same image instead of
    # overwriting them.
    styles = _load_existing_styles(output_path)
    styles.update(new_entries)

    # Flat top-level `style`/`caption`/`model`/`elapsed_sec` fields mirror the
    # LAST style processed: other tools (image-review.py, video-review.py,
    # image-profile.py) read those flat fields directly and expect the
    # latest-style behavior that already existed before multi-style caching —
    # this keeps that read path unchanged while the GUI gets the full per-style
    # cache via `styles`. `updated_style` records which style the flat fields
    # reflect; `styles_run` lists what this invocation added.
    last_entry = new_entries[last_style]
    output = {**flat_record, "style": last_style, **last_entry}
    merged = {
        **output,
        "updated_style": last_style,
        "styles_run": list(new_entries.keys()),
        "styles": styles,
    }

    # Save JSON
    with open(output_path, "w") as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)

    print(f"Saved: {output_path} "
          f"({len(new_entries)} style(s): {', '.join(new_entries)})")


def _image_to_base64(image_path: str, max_size: int = 1024) -> str:
    """Load image, optionally downsize, convert to JPEG bytes, return base64 string."""
    try:
        with Image.open(image_path) as _im:
            img = _im.convert("RGB")
    except (FileNotFoundError, OSError) as e:
        raise ValueError(f"cannot read image {image_path}: {e}") from e
    # Downsize if largest dimension exceeds max_size (VLMs don't need huge images)
    w, h = img.size
    if max(w, h) > max_size:
        scale = max_size / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def get_profile_verify_prompt(expected_view: str) -> str:
    """Build a VLM prompt to verify a generated profile view is the correct angle.

    The returned prompt instructs the VLM to check four boolean criteria and score
    the image, returning a JSON object suitable for _parse_caption_scores().

    Args:
        expected_view: "front", "back", or "side"
    """
    descriptions = {
        "front": "front view (0°): character faces the viewer directly, face fully visible, no back of head",
        "back":  "back view (180°): rear-facing, back of head visible, NO face, back of clothing visible",
        "side":  "side view (90°): exactly sideways, face/head in profile, only one arm visible, body in silhouette",
    }
    desc = descriptions.get(expected_view, expected_view)
    return (
        f"This image should show the {desc} of a character in A-pose on a white/neutral background. "
        "Full body from head to feet should be visible.\n\n"
        "Evaluate and respond ONLY with a JSON object (no markdown, no explanation):\n"
        '{"view_correct": true/false, "full_body": true/false, "apose": true/false, '
        '"clean_bg": true/false, "score": 1-10, "issues": ["..."], "summary": "one sentence"}\n\n'
        "Criteria:\n"
        f"- view_correct: Is this actually a {expected_view} view as described above?\n"
        "- full_body: Are feet/shoes visible at the bottom of the frame?\n"
        "- apose: Are arms slightly away from the body (not pressed against it)?\n"
        "- clean_bg: Is the background white or clean without clutter?\n"
        "- score: Overall image quality 1-10."
    )


def get_profile_identity_prompt() -> str:
    """Build a VLM prompt to verify a generated view depicts the SAME character
    as the reference image.

    Two images are supplied (reference first, generated view second) via
    _call_vlm_multi(). Identity is decomposed into per-attribute atoms (face,
    hair, skin, outfit, accessories) rather than a single holistic judgement —
    a model aggregate is never trusted if it can be recomputed (the repo's
    null→default lesson), and per-attribute atoms localize WHICH part of the
    identity drifted (the actionable signal for multi-view turnaround work).

    Returns JSON: {same_identity, face_match, hair_match, skin_match,
    outfit_match, accessories_match, identity_score, issues, summary}.
    `same_identity` is the hard gate; identity_score is 1-10 supporting detail.
    """
    return (
        "The FIRST image is the reference character. The SECOND image is a "
        "generated view (front/side/back) that SHOULD depict the SAME character. "
        "Judge whether the second image shows the same person/character as the "
        "reference, attribute by attribute.\n\n"
        "Respond ONLY with a JSON object (no markdown, no explanation):\n"
        '{"same_identity": true/false, "face_match": true/false, '
        '"hair_match": true/false, "skin_match": true/false, '
        '"outfit_match": true/false, "accessories_match": true/false, '
        '"identity_score": 1-10, "issues": ["..."], "summary": "one sentence"}\n\n'
        "Per-attribute criteria (judge each independently; use the reference as ground truth):\n"
        "- face_match: Same face identity — for a back view (no face visible) judge by head shape / hairline / "
        "any visible profile cues; if genuinely undeterminable from the angle, still judge from the cues present.\n"
        "- hair_match: Same hair (color, length, style, parting).\n"
        "- skin_match: Same skin tone / ethnicity cues.\n"
        "- outfit_match: Same clothing (color, cut, pattern, texture, garment type). THIS IS THE STRONGEST "
        "identity signal across views — outfit must be the same garments, just seen from a different angle.\n"
        "- accessories_match: Same accessories (glasses, jewelry, hats, bags, shoes); false only if clearly different.\n"
        "- same_identity: Overall — is this recognizably the SAME character? True iff the majority of attributes "
        "match, with outfit + hair weighted highest.\n"
        "- identity_score: 1-10 how well identity is preserved (10 = same character, no drift).\n"
        "- issues: list any identity drifts observed (e.g. 'different hair color', 'outfit changed from red to blue')."
    )


# Per-view EXPECTED framing elements for fair multi-view scoring (同類比較).
# `caption --view <front|back|side>` injects these so each angle is evaluated on a
# common, view-appropriate yardstick. Multi-view images are usually scored with the
# `score` style (no T2I prompt known), which has NO captured[]/missed[] checklist and
# is fully view-agnostic — so all views score generic 9s with nothing to differentiate.
# The block below is STYLE-AGNOSTIC: it asks the VLM to ADD view_correct + per-view
# captured[]/missed[] to its JSON response regardless of style, giving each view
# view-specific differentiation for fair same-category comparison.
_PROFILE_VIEW_DESC = {
    "front": "front view (0°): character faces the viewer, full face visible",
    "back":  "back view (180°): rear-facing, back of head visible, no face",
    "side":  "side view (90°): exactly sideways, head in strict profile",
}
_PROFILE_VIEW_ELEMENTS = {
    "front": [
        "full face visible (both eyes, nose, mouth)",
        "front of the outfit / outfit front details visible",
        "front-facing pose (character looks toward the viewer)",
        "no back of head visible",
    ],
    "back": [
        "back of head / hair visible",
        "back of the outfit visible",
        "rear-facing pose (180°, character turned away from viewer)",
        "no face visible",
    ],
    "side": [
        "face/head in strict profile (only one eye visible)",
        "side of the outfit visible",
        "exactly sideways (90°)",
        "only one arm visible / body in silhouette",
    ],
}


def get_profile_view_elements_block(view: str) -> str:
    """Return a style-agnostic prompt block for per-view multi-view scoring.

    Appended to any style's prompt when `caption --view <front|back|side>` is used.
    Asks the VLM to ADD `view_correct` + per-view `captured`/`missed` to its JSON
    response (alongside whatever the style already requests), so multi-view images —
    even those scored with the prompt-less `score` style — get view-specific
    differentiation for fair same-category comparison. Returns "" for an unknown/empty
    view (a no-op when --view is absent).
    """
    elems = _PROFILE_VIEW_ELEMENTS.get(view)
    if not elems:
        return ""
    desc = _PROFILE_VIEW_DESC.get(view, view)
    return (
        f"\n\nADDITIONAL VIEW-SPECIFIC CHECK — this image should be the {desc}. "
        "Evaluate view correctness and framing, and ADD these fields to your JSON "
        "response (alongside any fields the style already requests):\n"
        f'- "view_correct": true/false — is this actually a {view} view as described?\n'
        '- "captured": [view-specific framing elements PRESENT in the image]\n'
        '- "missed": [view-specific framing elements ABSENT or wrong]\n'
        f"Expected {view} framing elements to check:\n- " + "\n- ".join(elems) + "\n"
    )
    """Build a VLM prompt to verify a ControlNet output shows a V-pose (arms raised).

    The returned prompt instructs the VLM to check arm position and return a JSON object
    suitable for pass/fail verdict in the basic-controlnet self-test.
    """
    return (
        "This image should show a person in a VICTORY V-POSE: both arms raised high above the head "
        "forming a V-shape, similar to an athlete celebrating a win.\n\n"
        "Evaluate and respond ONLY with a JSON object (no markdown, no explanation):\n"
        '{"arms_raised": true/false, "v_pose": true/false, "both_arms_visible": true/false, '
        '"score": 1-10, "issues": ["..."], "summary": "one sentence describing the actual pose"}\n\n'
        "Criteria:\n"
        "- arms_raised: Are both arms raised above shoulder height?\n"
        "- v_pose: Do the raised arms form a V-shape (spread apart) above the head?\n"
        "- both_arms_visible: Are both arms clearly visible in the image?\n"
        "- score: How well does this match the expected V-pose? 1-10 (10=perfect V-pose).\n"
        "Answer in English."
    )


def _lmstudio_base(api_url: str) -> str:
    """Derive LM Studio native API base from an OpenAI-compatible URL.

    Example: "http://localhost:1234/v1" → "http://localhost:1234"
    """
    return api_url.rstrip("/").removesuffix("/v1")


def _lmstudio_home() -> str:
    """Resolve the LM Studio home directory (where .internal/ lives)."""
    return os.environ.get("LMSTUDIO_HOME") or os.path.expanduser("~/.lmstudio")


def _lmstudio_default_config_path(model_id: str) -> str:
    """Path to LM Studio's per-model default load-config JSON.

    e.g. model_id="qwen/qwen3-vl-4b" ->
         ~/.lmstudio/.internal/user-concrete-model-default-config/qwen/qwen3-vl-4b.json
    """
    return os.path.join(
        _lmstudio_home(), ".internal", "user-concrete-model-default-config",
        f"{model_id}.json",
    )


def _disable_kv_cache_quant(model_id: str) -> bool:
    """Disable MLX KV-cache quantization in LM Studio's per-model default config.

    The MLX vision path (mlx-vlm) cannot load a VLM with KV-cache quantization
    enabled — it raises "The mlx-vlm batched vision path does not support KV
    cache quantization yet" and every headless load (REST /api/v1/models/load
    AND the `lms load` CLI) fails. LM Studio stores this default per-model; the
    REST load endpoint accepts only {"model"} and exposes no flag to turn it off,
    so the only programmatic fix is to edit this stored config. This flips the
    stored default to enabled=false so subsequent loads succeed.

    Idempotent and safe: a no-op (returns False) if the file is missing, the
    field is absent, or already disabled. Backs up the original before writing.

    Returns True if a change was made (caller should retry the load).
    """
    cfg_path = _lmstudio_default_config_path(model_id)
    if not os.path.exists(cfg_path):
        return False
    try:
        with open(cfg_path) as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[caption] Could not read LM Studio model config ({cfg_path}): {e}",
              file=sys.stderr)
        return False

    fields = cfg.get("load", {}).get("fields", [])
    kv_field = next(
        (f for f in fields if f.get("key") == "llm.load.mlx.kvCacheQuantization"), None
    )
    if kv_field is None:
        return False
    if not kv_field.get("value", {}).get("enabled", False):
        return False  # already disabled

    backup = f"{cfg_path}.bak.{int(time.time())}"
    try:
        shutil.copy2(cfg_path, backup)
        kv_field["value"]["enabled"] = False
        with open(cfg_path, "w") as f:
            json.dump(cfg, f, indent=4)
    except OSError as e:
        print(f"[caption] Could not write LM Studio model config: {e}", file=sys.stderr)
        return False

    print(
        f"[caption] Disabled KV-cache quantization for {model_id} in LM Studio "
        f"(backup: {backup}). This fixes the mlx-vlm VLM load failure.",
        flush=True,
    )
    return True


def _loaded_model_keys(api_url: str):
    """Return the set of currently-loaded model keys, or None if unreachable.

    Uses the NATIVE /api/v1/models endpoint: each model carries a
    `loaded_instances` list (non-empty iff loaded). The OpenAI /v1/models
    endpoint lists ALL indexed models regardless of load state, so it cannot
    distinguish loaded from unloaded.
    """
    base = _lmstudio_base(api_url)
    lms_base = f"{base}/api/v1"
    try:
        r = requests.get(f"{lms_base}/models", timeout=5)
        r.raise_for_status()
        data = r.json()
        return {
            m.get("key", "") for m in data.get("models", [])
            if m.get("loaded_instances")
        }
    except (requests.RequestException, ValueError) as e:
        print(f"[caption] LM Studio model query failed: {e}", file=sys.stderr)
        return None


def _catalog_model_keys(api_url: str):
    """Return the set of ALL downloaded (indexed) model keys, or None if
    unreachable. Unlike _loaded_model_keys, this lists every model LM Studio
    knows about regardless of load state — used to decide whether the default
    (gemma) is available to auto-load vs. falling back to a lightweight model.
    """
    base = _lmstudio_base(api_url)
    lms_base = f"{base}/api/v1"
    try:
        r = requests.get(f"{lms_base}/models", timeout=5)
        r.raise_for_status()
        data = r.json()
        return {m.get("key", "") for m in data.get("models", []) if m.get("key")}
    except (requests.RequestException, ValueError) as e:
        print(f"[caption] LM Studio catalog query failed: {e}", file=sys.stderr)
        return None


def _resolve_model(api_url: str, explicit_model):
    """Pick which VLM to use for captioning.

    Priority:
    1. Explicit --model arg → use it immediately (no LM Studio query).
    2. Any preferred model (Gemma 31B > 26B > 12B) already loaded → use it.
    3. Any model already loaded in LM Studio → use it (avoids forcing an
       auto-load when the user already has something running).
    4. Nothing loaded → auto-load the default (gemma-4-12b). If gemma is not
       downloaded on this machine, fall back through _FALLBACK_MODELS
       (Qwen3-VL-4B, lightweight) — the over-praising but always-available
       last resort.

    The default is gemma (the project brain), NOT Qwen — Qwen3-VL over-praises
    on score/review styles. Qwen is demoted to an opt-in --vlm-model / no-gemma
    fallback only. Returns the chosen model id string.
    """
    if explicit_model:
        return explicit_model
    loaded = _loaded_model_keys(api_url) or set()
    # Step 1: preferred models in priority order (Gemma 31B > 26B > 12B)
    for candidate in _PREFERRED_MODELS:
        if candidate in loaded:
            print(f"[caption] Auto: {candidate} already loaded — "
                  f"using it, no model load needed.", flush=True)
            return candidate
    # Step 2: use any already-loaded model — avoid forcing an auto-load when
    # the user already has something running in LM Studio.
    available = {k for k in loaded if k}
    if available:
        if _DEFAULT_MODEL in available:
            print(f"[caption] Auto: {_DEFAULT_MODEL} already loaded — "
                  f"using it, no model load needed.", flush=True)
            return _DEFAULT_MODEL
        chosen = next(iter(available))
        print(f"[caption] Auto: using already-loaded model {chosen} "
              f"(no preferred model found, skipping auto-load).", flush=True)
        return chosen
    # Step 3: nothing loaded at all — auto-load the default (gemma). If gemma
    # is not downloaded here, fall back to the lightweight chain (Qwen).
    catalog = _catalog_model_keys(api_url) or set()
    if _DEFAULT_MODEL in catalog:
        print(f"[caption] Auto: no VLM loaded — "
              f"will auto-load {_DEFAULT_MODEL} (default brain).", flush=True)
        return _DEFAULT_MODEL
    for fb in _FALLBACK_MODELS:
        if fb in catalog:
            print(f"[caption] Auto: no VLM loaded and {_DEFAULT_MODEL} not "
                  f"downloaded — falling back to {fb}.", flush=True)
            return fb
    # Nothing downloaded at all — return the default and let the load surface
    # a clear failure (better than silently picking an unrelated model).
    print(f"[caption] Auto: no VLM loaded or downloaded — "
          f"will attempt to auto-load {_DEFAULT_MODEL}.", flush=True)
    return _DEFAULT_MODEL


def resolve_default_model(api_url: str = _DEFAULT_API_URL) -> str:
    """Public resolver for callers that used to hardcode a model id.

    Returns the same model `run.py caption` would pick with no explicit
    --model: preferred Gemma variant if loaded, else the auto-load default
    (gemma-4-12b, or the Qwen fallback if gemma isn't downloaded). Routing
    the review/faceswap/profile tiers through this makes gemma the universal
    default and stops them silently using the over-praising Qwen3-VL.
    """
    return _resolve_model(api_url, None)


def _warmup_vlm(api_url: str, model_id: str,
                timeout: int = _VLM_REQUEST_TIMEOUT) -> None:
    """Run one throwaway inference right after a FRESH model load to absorb MLX
    cold-start cost (graph compilation + first weight upload to GPU) — so the
    real caption doesn't pay it and doesn't risk the request timeout on a slow
    26B model. Only called on a successful load, never on the already-loaded
    short-circuit, so warm sessions pay zero.

    Best-effort: any failure is logged and swallowed. A warmup error must never
    block the caption; the subsequent real request surfaces genuine problems.
    """
    url = f"{api_url}/chat/completions"
    content = [{"type": "text", "text": "ready"}]
    try:
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), (128, 128, 128)).save(buf, format="JPEG")
        warmup_b64 = base64.b64encode(buf.getvalue()).decode()
        content.insert(0, {
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{warmup_b64}"},
        })
    except Exception as e:
        # PIL unavailable or image build failed — fall back to text-only warmup,
        # which still compiles the (dominant) decoder graph.
        print(f"[caption] Warmup image build failed ({e}); text-only warmup.",
              file=sys.stderr)

    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 2,
        "temperature": 0,
        "stream": False,
    }
    t0 = time.perf_counter()
    try:
        requests.post(url, json=payload, timeout=timeout)
        print(f"[caption] Warmup inference for {model_id} done "
              f"({time.perf_counter() - t0:.1f}s); subsequent captions run warm.",
              flush=True)
    except Exception as e:
        print(f"[caption] Warmup inference failed ({e}); proceeding anyway.",
              file=sys.stderr)


def _lmstudio_ensure_model(api_url: str, model_id: str, timeout: int = 180) -> bool:
    """Ensure the given model is loaded in LM Studio.

    Checks the native /api/v1/models endpoint for actual load state; if not
    loaded, POSTs /api/v1/models/load. If that load fails, attempts to auto-fix
    the most common MLX-VLM failure (KV-cache quantization) and retries once.

    Args:
        api_url: OpenAI-compatible base URL (e.g., "http://localhost:1234/v1")
        model_id: Model identifier string (e.g., "qwen/qwen3-vl-4b")
        timeout: Seconds to wait for a single load attempt (default 180s)

    Returns:
        True if the model is loaded (or becomes loaded); False if LM Studio is
        unavailable or the load genuinely fails.
    """
    base = _lmstudio_base(api_url)
    lms_base = f"{base}/api/v1"

    def _load_once() -> bool:
        """POST the load endpoint; returns True if the model reports loaded."""
        try:
            r = requests.post(
                f"{lms_base}/models/load",
                json={"model": model_id},
                timeout=timeout,
            )
            if r.status_code == 200:
                body = r.json()
                # Successful load: {"status": "loaded", "instance_id": ...}
                if body.get("status") == "loaded" or body.get("instance_id"):
                    return True
                err = body.get("error")
                if err:
                    print(f"[caption] LM Studio load error: {err.get('type')}: "
                          f"{err.get('message', '')}", file=sys.stderr)
            else:
                print(f"[caption] LM Studio load HTTP {r.status_code}: "
                      f"{r.text[:200]}", file=sys.stderr)
        except requests.RequestException as e:
            print(f"[caption] LM Studio load request failed: {e}", file=sys.stderr)
        return False

    loaded = _loaded_model_keys(api_url)
    if loaded is None:
        return False  # LM Studio not responding
    if model_id in loaded:
        return True

    print(f"[caption] Loading model {model_id} via LM Studio...", flush=True)
    if _load_once():
        _warmup_vlm(api_url, model_id)
        return True

    # Load failed — the most common cause for MLX VLMs is KV-cache quantization.
    # Auto-fix it (idempotent), give LM Studio a moment to release the failed
    # load state and re-read the edited config, then retry once.
    if _disable_kv_cache_quant(model_id):
        # LM Studio caches the failed-load state for a brief window: a retry
        # fired immediately after the config edit still fails with
        # model_load_failed. A short pause lets it pick up the updated config.
        time.sleep(2)
        print("[caption] Retrying load after KV-cache fix...", flush=True)
        if _load_once():
            _warmup_vlm(api_url, model_id)
            return True

    return False


def _call_vlm(api_url: str, model: str, b64_image: str, prompt: str,
              auto_load: bool = True, max_tokens: int = 2048) -> str:
    """Call OpenAI-compatible chat completions API with image + text.

    When auto_load is True (default), ensures the model is loaded in LM Studio
    before the first request — proactively, not only on failure. As a fallback,
    also retries once via _lmstudio_ensure_model if the first request fails with
    a connection error or HTTP error (model not loaded).
    """
    url = f"{api_url}/chat/completions"
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"},
                },
                {
                    "type": "text",
                    "text": prompt,
                },
            ],
        }],
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "stream": False,
    }

    def _do_request():
        resp = requests.post(url, json=payload, timeout=_VLM_REQUEST_TIMEOUT)
        resp.raise_for_status()
        return resp.json()

    if auto_load:
        _lmstudio_ensure_model(api_url, model)

    try:
        data = _do_request()
    except (requests.ConnectionError, requests.HTTPError) as first_err:
        # Reactive fallback: ensure the model is loaded, then retry once.
        if _lmstudio_ensure_model(api_url, model):
            data = _do_request()  # raises if still failing
        else:
            raise first_err

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raw_excerpt = json.dumps(data, ensure_ascii=False)[:500]
        raise RuntimeError(
            f"VLM response missing expected OpenAI chat-completion shape "
            f"({type(e).__name__}: {e}); raw response excerpt: {raw_excerpt}"
        ) from e

    # Strip Qwen3 / Gemma-4 <think/> reasoning blocks if present
    raw_content = content
    content = re.sub(r"<think.*?</think\s*>", "", content, flags=re.DOTALL).strip()

    # Gemma-4 thinking models sometimes put the structured answer INSIDE the
    # <think> block rather than after it — strip leaves an empty string. Recover
    # by extracting the inner text of all <think> blocks as a fallback.
    if not content and "<think" in raw_content:
        inner = re.sub(r"</?think\s*>", "", raw_content, flags=re.DOTALL).strip()
        if inner:
            content = inner

    return content


# ── Multi-sample score denoising (--samples N) ───────────────────────────────
# These run the VLM score call N times IN PYTHON and median the numeric dims,
# so the workflow can get a denoised score from ONE CLI call instead of N
# parallel agents each reading a full caption JSON (≈6× fewer tokens, and the
# model stays loaded across the N calls so it is faster too).

_SCORE_NUMERIC_DIMS = ("overall", "detail", "sharpness", "composition",
                       "prompt_adherence", "artifacts")
_SCORE_ARRAY_DIMS = ("captured", "missed", "issues", "strengths")


def _parse_score_dict(text: str) -> dict | None:
    """Parse a VLM score response into a dict, tolerating fences/prose.

    The score-style prompt asks for a bare JSON object, but the model sometimes
    wraps it in ```json fences or adds prose around it.
    """
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s).strip()
    start, end = s.find("{"), s.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(s[start:end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def median_score_caption(raws: list[str]) -> str:
    """Median N raw VLM score responses into one score dict, serialized as JSON.

    Numeric dims take the median; array dims take the order-preserving union
    (deduped); `summary` comes from the carrier sample (overall closest to the
    median overall). Output shape matches a single sample, plus `scoreSamples`.
    Returns the first raw on total parse failure so callers still get something.
    """
    parsed = [d for d in (_parse_score_dict(r) for r in raws) if d]
    if not parsed:
        return raws[0] if raws else "{}"
    if len(parsed) == 1:
        out = dict(parsed[0])
        out["scoreSamples"] = 1
        return json.dumps(out, ensure_ascii=False)

    def _median(values: list) -> float:
        nums = sorted(v for v in values if isinstance(v, (int, float)))
        if not nums:
            return 0
        m = len(nums) // 2
        return nums[m] if len(nums) % 2 else round((nums[m - 1] + nums[m]) / 2)

    med = {d: _median([p.get(d) for p in parsed]) for d in _SCORE_NUMERIC_DIMS}
    for d in _SCORE_ARRAY_DIMS:
        seen, union = set(), []
        for p in parsed:
            for x in (p.get(d) or []):
                t = str(x)
                if t not in seen:
                    seen.add(t)
                    union.append(t)
        med[d] = union
    target = med["overall"]
    carrier = min(parsed, key=lambda p: abs((p.get("overall") or 0) - target))
    med["summary"] = carrier.get("summary", "")
    med["scoreSamples"] = len(parsed)
    return json.dumps(med, ensure_ascii=False)


# ── pose_dsg — atomic faithfulness + anatomy gate ────────────────────────────
# DSG/TIFA-style: decompose a pose prompt into atomic yes/no propositions, have
# the VLM verify each against the image, and recompute the aggregates in Python.
# Anatomy gate is AbHuman-derived (limb count, hands, face, pose plausibility).
# See bun-apps/s2-agent-ext-flux2/docs/pose-validation.md.

def _load_atoms(spec: str | None) -> list[dict] | None:
    """Load explicit atoms for pose_dsg from a path or inline JSON string.

    Accepts {"atoms":[{"id":"a1","q":"..."},...]} or a bare [{"id","q"},...].
    Returns None when no spec is given (caller → VLM self-decomposes). Raises
    ValueError with a actionable message on a malformed/missing file.
    """
    if not spec:
        return None
    text: str
    if os.path.exists(spec):
        with open(spec) as f:
            text = f.read()
    else:
        text = spec  # treat as inline JSON
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"--atoms is not valid JSON: {e}") from e
    atoms = data["atoms"] if isinstance(data, dict) else data
    if not isinstance(atoms, list) or not atoms:
        raise ValueError("--atoms JSON must be a non-empty list of {id, q} objects")
    norm = []
    for i, a in enumerate(atoms):
        if not isinstance(a, dict) or not a.get("q"):
            raise ValueError(f"--atoms[{i}] missing a 'q' statement: {a!r}")
        norm.append({"id": str(a.get("id") or f"a{i + 1}"), "q": str(a["q"])})
    return norm


def build_atoms_block(atoms: list[dict] | None) -> str:
    """STEP-1 instruction for pose_dsg: use explicit atoms, or self-decompose."""
    if atoms:
        lines = "\n".join(f"  - {a['id']}: {a['q']}" for a in atoms)
        return (
            "Use EXACTLY these atoms (do not add, merge, drop, or reword any):\n"
            + lines + "\n"
        )
    return (
        "Derive 5-10 atoms yourself from the pose prompt above. Each atom is a single "
        "yes/no proposition about ONE thing: an object (e.g. 'exactly one woman'), a body "
        "attribute ('sitting cross-legged'), a spatial relation ('left hand on top of head'), "
        "a viewpoint ('3/4 profile view'), or a count ('exactly 5 fingers per visible hand').\n"
    )


def build_pose_dsg_prompt(prompt: str, atoms: list[dict] | None = None) -> str:
    """Build the pose_dsg VLM prompt. Uses str.replace (not .format) because the
    template's JSON example contains literal braces."""
    return (
        _STYLE_PROMPTS["pose_dsg"]
        .replace("{prompt}", prompt)
        .replace("{atoms_block}", build_atoms_block(atoms))
    )


def _as_bool(v) -> bool:
    """Coerce a VLM anatomy field to bool. Strings like 'true'/'false'/missing → bool."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "1", "pass")
    return False


def _face_value(v):
    """Face field may be true / false / 'n/a' (face not visible). Map to True/False/None."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in ("n/a", "na", "none", "not visible"):
        return None
    return _as_bool(v)


def _clamp_conf(v) -> float:
    try:
        return max(0.0, min(1.0, round(float(v), 2)))
    except (TypeError, ValueError):
        return 0.0


def parse_pose_dsg(text: str | dict) -> dict:
    """Parse a pose_dsg VLM response and RECOMPUTE the aggregates in Python.

    The model returns atoms[] + anatomy{} + (possibly wrong) faithfulness /
    anatomy_pass. We never trust those aggregates — faithfulness is recomputed
    from the atoms, anatomy_pass from the anatomy fields. Returns a normalized:

      {atoms:[{id,q,present,confidence}], faithfulness: float,
       anatomy:{limb_count,hands,face,pose_plausible}, anatomy_pass: bool,
       issues:[...], summary: str}
    """
    raw = _extract_caption_json(text) if not isinstance(text, dict) else text
    if not isinstance(raw, dict):
        raw = {}

    src_atoms = raw.get("atoms") or []
    atoms = []
    for i, a in enumerate(src_atoms if isinstance(src_atoms, list) else []):
        if not isinstance(a, dict):
            continue
        atoms.append({
            "id": str(a.get("id") or f"a{i + 1}"),
            "q": str(a.get("q") or a.get("question") or ""),
            "present": bool(a.get("present")),
            "confidence": _clamp_conf(a.get("confidence")),
        })

    present = sum(1 for a in atoms if a["present"])
    faithfulness = round(present / len(atoms), 3) if atoms else 0.0

    an = raw.get("anatomy") or {}
    if not isinstance(an, dict):
        an = {}
    face = _face_value(an.get("face"))
    anatomy = {
        "limb_count": _as_bool(an.get("limb_count")),
        "hands": _as_bool(an.get("hands")),
        "face": face,  # True | False | None(n/a)
        "pose_plausible": _as_bool(an.get("pose_plausible")),
    }
    # face=None (not visible) never fails the gate; face=False (visible+distorted) does.
    anatomy_pass = (
        anatomy["limb_count"]
        and anatomy["hands"]
        and anatomy["pose_plausible"]
        and face is not False
    )

    issues = raw.get("issues") or []
    if not isinstance(issues, list):
        issues = [str(issues)]
    summary = str(raw.get("summary") or "")

    return {
        "atoms": atoms,
        "faithfulness": faithfulness,
        "anatomy": anatomy,
        "anatomy_pass": bool(anatomy_pass),
        "issues": [str(x) for x in issues],
        "summary": summary,
    }


def _call_vlm_multi(api_url: str, model: str, b64_images: list[str], prompt: str,
                    auto_load: bool = True, reasoning_effort: str | None = None) -> str:
    """Call OpenAI-compatible chat completions API with MULTIPLE images + text.

    Same as _call_vlm() but accepts a list of base64-encoded images. Each image
    is added as a separate image_url entry in the content array, enabling the VLM
    to see multiple frames (e.g. keyframes from a video) at once.

    Args:
        api_url: OpenAI-compatible API base URL.
        model: Model name (e.g. 'qwen/qwen3-vl-4b').
        b64_images: List of base64 JPEG strings, one per keyframe.
        prompt: Text prompt to accompany the images.
        auto_load: If True, ensure model is loaded in LM Studio first.
        reasoning_effort: Optional OpenAI-style reasoning-effort knob (e.g. "none").
            LM Studio honors ``"none"`` to suppress gemma-4 thinking, so multi-image
            JSON tasks land cleanly in ``content`` with no reasoning interference.

    Returns:
        Raw text response from the VLM.
    """
    url = f"{api_url}/chat/completions"

    # Build content array: image_url entries (one per frame) + text prompt
    content = []
    for b64 in b64_images:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })
    content.append({"type": "text", "text": prompt})

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 2048,
        "temperature": 0.3,
        "stream": False,
    }
    if reasoning_effort is not None:
        payload["reasoning_effort"] = reasoning_effort

    def _do_request():
        resp = requests.post(url, json=payload, timeout=_VLM_REQUEST_TIMEOUT)  # tolerates cold start
        resp.raise_for_status()
        return resp.json()

    if auto_load:
        _lmstudio_ensure_model(api_url, model)

    try:
        data = _do_request()
    except (requests.ConnectionError, requests.HTTPError) as first_err:
        if _lmstudio_ensure_model(api_url, model):
            data = _do_request()
        else:
            raise first_err

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raw_excerpt = json.dumps(data, ensure_ascii=False)[:500]
        raise RuntimeError(
            f"VLM response missing expected OpenAI chat-completion shape "
            f"({type(e).__name__}: {e}); raw response excerpt: {raw_excerpt}"
        ) from e
    content = re.sub(r"<think.*?</think\s*>", "", content, flags=re.DOTALL).strip()
    return content


# ---------------------------------------------------------------------------
# Public helper — reusable by other commands (e.g., image-review self-tests)
# ---------------------------------------------------------------------------

def caption_image(image_path: str, style: str = "photography", lang: str = "en",
                  api_url: str = _DEFAULT_API_URL, model: str = _DEFAULT_MODEL,
                  prompt: str | None = None, auto_load: bool = True,
                  lora_name: str | None = None, lora_description: str | None = None,
                  lora_scale: float | None = None) -> str:
    """Caption a single image and return the text. Reusable public API.

    Args:
        image_path: Path to image file.
        style: Caption style key (default, photography, prompt, profile, style, score,
               review, lora_quality).
        lang: Output language (en, zh_TW, zh_CN, ja).
        api_url: VLM API base URL.
        model: VLM model name.
        prompt: Original T2I prompt (required for 'review' style).
        auto_load: If True, ensure the VLM is loaded in LM Studio first.
        lora_name: LoRA name (required for 'lora_quality' style).
        lora_description: LoRA description (for 'lora_quality' style).
        lora_scale: LoRA scale applied (for 'lora_quality' style).

    Returns:
        Caption text string.
    """
    prompt_text = _STYLE_PROMPTS.get(style, _STYLE_PROMPTS["default"])
    if style == "review" and prompt:
        prompt_text = prompt_text.format(prompt=prompt)
    elif style == "lora_quality":
        prompt_text = prompt_text.format(
            lora_name=lora_name or "unknown",
            lora_description=lora_description or "no description",
            scale=str(lora_scale) if lora_scale is not None else "unknown",
        )
    prompt_text += "\n" + _LANG_INSTRUCTIONS.get(lang, "")
    b64 = _image_to_base64(image_path)
    return _call_vlm(api_url, model, b64, prompt_text, auto_load=auto_load)


def caption_video(video_path: str, style: str = "video_score", lang: str = "en",
                  n_frames: int = 8, api_url: str = _DEFAULT_API_URL,
                  model: str = _DEFAULT_MODEL,
                  auto_load: bool = True) -> dict:
    """Analyze a video by extracting keyframes and sending them to a VLM.

    Extracts N evenly-spaced keyframes from the video, sends them as multiple
    images in a single VLM call, and returns the parsed response dict.

    Args:
        video_path: Path to video file.
        style: Caption style key (video_score or video_analysis).
        lang: Output language (en, zh_TW, zh_CN, ja).
        n_frames: Number of keyframes to extract (default: 8).
        api_url: VLM API base URL.
        model: VLM model name.
        auto_load: If True, ensure the VLM is loaded in LM Studio first.

    Returns:
        Parsed JSON dict from VLM response. For video_score style, contains:
        overall, sharpness, detail_preservation, color_lighting,
        temporal_coherence, artifacts, issues, strengths, summary.
        Returns empty dict on failure.
    """
    from app.video_utils import extract_keyframes

    prompt_text = _STYLE_PROMPTS.get(style, _STYLE_PROMPTS["video_score"])
    prompt_text += "\n" + _LANG_INSTRUCTIONS.get(lang, "")

    # Extract keyframes
    print(f"[caption] Extracting {n_frames} keyframes from {os.path.basename(video_path)}...",
          flush=True)
    frame_paths = extract_keyframes(video_path, n_frames=n_frames)

    if not frame_paths:
        print(f"[caption] WARNING: no keyframes extracted from {video_path}", file=sys.stderr)
        return {}

    # Convert to base64
    print(f"[caption] Sending {len(frame_paths)} frames to VLM ({style})...", flush=True)
    b64_images = [_image_to_base64(p) for p in frame_paths]

    # Call VLM
    response = _call_vlm_multi(api_url, model, b64_images, prompt_text,
                               auto_load=auto_load)

    # Parse JSON from response
    result = _extract_caption_json(response)

    # Clean up keyframe JPEGs (they're in a temp dir)
    for p in frame_paths:
        try:
            os.remove(p)
        except OSError:
            pass
    # Remove the temp dir if it's empty
    parent_dir = os.path.dirname(frame_paths[0])
    try:
        if parent_dir and os.path.isdir(parent_dir) and not os.listdir(parent_dir):
            os.rmdir(parent_dir)
    except OSError:
        pass

    return result


# ---------------------------------------------------------------------------
# Review HTML generation
# ---------------------------------------------------------------------------

def _extract_caption_json(raw: dict | str | Any) -> dict:
    """Parse the nested caption field into a dict, tolerating markdown fences/prose.

    _call_vlm does not set response_format=json_object, so the VLM often wraps
    JSON in ```json fences or surrounds it with prose. A naive json.loads then
    fails and silently zeroes every score in the review HTML. Strip fences and
    fall back to the first {...} block.
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"```\s*$", "", s).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", s, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
        return {}


_SCORE_KEYS = ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]
_SCORE_LABELS = ["Overall", "Detail", "Sharpness", "Composition", "Adherence", "Artifacts"]

# Chrome-string localization for the review HTML (VLM caption CONTENT is unaffected —
# it is whatever run.py caption --style produced). Selected by the manifest's top-level `lang`.
_REVIEW_I18N = {
    "en": {
        "best": "Best", "export": "Export Feedback JSON", "exported": "Feedback exported!",
        "captured": "Captured", "missed": "Missed", "compare": "Score Comparison",
        "strengths": "Strengths & Issues", "str_label": "Strengths", "issues_label": "Issues",
        "comment_ph": "Your comments...", "prompt_label": "Prompt", "guide_label": "What to compare",
        "reco_label": "VLM suggests", "none": "—", "close_hint": "click outside to close",
        "meta_across": "image(s) across", "meta_sets": "set(s)", "dimension": "Dimension",
        "tiebreak": " (by detail/sharpness)",
        "img_count": lambda n: f"{n} image{'s' if n != 1 else ''}",
        "rating": "Rating", "copy": "Copy JSON", "copied": "JSON copied to clipboard!",
        "copy_fallback": "Clipboard blocked — select the text below and press ⌘C/Ctrl+C",
        "config_label": "Config", "cfg_model": "model", "cfg_vae": "VAE",
        "cfg_lora": "LoRA", "cfg_params": "params", "cfg_seed": "seed",
        "cfg_default": "default", "cfg_none": "none",
    },
    "zh_TW": {
        "best": "最佳", "export": "匯出回饋 JSON", "exported": "已匯出回饋！",
        "captured": "命中", "missed": "遺漏", "compare": "分數比較",
        "strengths": "優點與問題", "str_label": "優點", "issues_label": "問題",
        "comment_ph": "你的評論...", "prompt_label": "提示詞", "guide_label": "評判重點",
        "reco_label": "VLM 建議", "none": "—", "close_hint": "點圖外關閉",
        "meta_across": "張圖片，共", "meta_sets": "組", "dimension": "指標",
        "tiebreak": "（依細節/銳利度）",
        "img_count": lambda n: f"{n} 張圖片",
        "rating": "評分", "copy": "複製 JSON", "copied": "JSON 已複製到剪貼簿！",
        "copy_fallback": "剪貼簿被封鎖——請選取下方文字並按 ⌘C/Ctrl+C",
        "config_label": "生成設定", "cfg_model": "模型", "cfg_vae": "VAE",
        "cfg_lora": "LoRA", "cfg_params": "參數", "cfg_seed": "seed",
        "cfg_default": "預設", "cfg_none": "無",
    },
}


def _resolve_review_path(p: str, base_dir: str = "") -> str:
    """Resolve a caption-JSON path that may be relative.

    Tries the path as-is, then relative to base_dir (the manifest's directory),
    then basename-in-base_dir. Returns the first that exists; falls back to the
    original guess so the loader can emit a clear 'not found' warning.
    """
    if not p:
        return ""
    cands = [p]
    if not os.path.isabs(p) and base_dir:
        cands.append(os.path.join(base_dir, p))
        cands.append(os.path.join(base_dir, os.path.basename(p)))
    for c in cands:
        if c and os.path.exists(c):
            return c
    return cands[0]


def _load_run_config(caption_path: str, img_path: str) -> dict:
    """Load generation config from the sibling <stem>.run.json.

    Tries <image_stem>.run.json next to the image, then next to the caption JSON.
    Returns {} when no run.json is found (old runs / external images) — graceful.
    """
    seen = set()
    for base in (img_path, caption_path):
        if not base:
            continue
        stem = os.path.splitext(base)[0]
        cand = stem + ".run.json"
        if cand in seen or not os.path.exists(cand):
            continue
        seen.add(cand)
        try:
            with open(cand) as f:
                return json.load(f) or {}
        except Exception:
            return {}
    return {}


def _load_review_item(path: str) -> dict:
    """Load one caption JSON into a flat display item.

    The image is referenced by RELATIVE filename (basename) so the browser
    resolves it next to the HTML file — no base64, no CWD dependency.
    """
    with open(path) as f:
        data = json.load(f)
    caption_raw = _extract_caption_json(data.get("caption", "{}"))
    img_path = data.get("image", "")
    # Generation config from the sibling <stem>.run.json (what model/VAE/LoRA/
    # resolution/steps/seed produced THIS image). Robust for any run that emits
    # a run.json — unlike the manifest reproducibility map (empty for self-test).
    run_cfg = _load_run_config(path, img_path)
    # If a sibling video (.mp4) shares the first-frame PNG's basename, embed it
    # as a playable <video> (video A/B review). Pure-image reviews have no mp4
    # → video_src "" → card renders the usual <img>. Resolve relative to the
    # caption JSON's dir first (robust to CWD), then the image path itself.
    video_path = ""
    if img_path:
        stem = os.path.splitext(os.path.basename(img_path))[0]
        caption_dir = os.path.dirname(os.path.abspath(path))
        for cand in (os.path.join(caption_dir, stem + ".mp4"),
                     os.path.splitext(img_path)[0] + ".mp4"):
            if cand and os.path.exists(cand):
                video_path = cand
                break
    return {
        "caption_path": path,
        "image_path": img_path,
        "filename": os.path.basename(img_path) if img_path else os.path.basename(path),
        "image_src": os.path.basename(img_path) if img_path else "",
        "video_src": os.path.basename(video_path) if video_path else "",
        "style": data.get("style", ""),
        "model": data.get("model", ""),
        "scores": {
            "overall": caption_raw.get("overall", 0),
            "detail": caption_raw.get("detail", 0),
            "sharpness": caption_raw.get("sharpness", 0),
            "composition": caption_raw.get("composition", 0),
            "prompt_adherence": caption_raw.get("prompt_adherence", 0),
            "artifacts": caption_raw.get("artifacts", 0),
        },
        "captured": caption_raw.get("captured", []),
        "missed": caption_raw.get("missed", []),
        "issues": caption_raw.get("issues", []),
        "strengths": caption_raw.get("strengths", []),
        "summary": caption_raw.get("summary", ""),
        "config": run_cfg,
    }


def _score_bars_html(item: dict) -> str:
    bars = ""
    for key, label in zip(_SCORE_KEYS, _SCORE_LABELS):
        val = item["scores"].get(key, 0)
        pct = val * 10  # 1-10 → 10-100%
        color = "#4caf50" if val >= 8 else "#ff9800" if val >= 5 else "#f44336"
        bars += (
            f'<div class="score-row">'
            f'<span class="score-label">{label}</span>'
            f'<div class="score-bar-bg"><div class="score-bar-fill" style="width:{pct}%;background:{color}"></div></div>'
            f'<span class="score-val">{val}</span>'
            f'</div>'
        )
    return bars


def _build_reproducibility_html(item: dict) -> str:
    """Compact per-image reproducibility panel: models · LoRA · denoise · seed.

    Fed by the workflow's ab_manifest.json "reproducibility" map (keyed by caption
    filename), built from each image's sibling <base>.manifest.json events trace.
    Returns "" when no reproducibility data (old runs / self-test) — graceful.
    """
    rep = item.get("reproducibility")
    if not rep:
        return ""
    parts = []
    models = rep.get("models") or []
    if models:
        parts.append('<span class="repro-models"><b>models:</b> ' + html.escape(", ".join(models)) + "</span>")
    lora = rep.get("lora")
    if lora:
        lstr = f'{html.escape(str(lora.get("name", "?")))} (scale {lora.get("scale", "?")}, {lora.get("applied_count", "?")} layers)'
        parts.append(f'<span class="repro-lora"><b>LoRA:</b> {lstr}</span>')
    denoise = rep.get("denoise") or {}
    if denoise:
        dparts = []
        if "steps" in denoise:
            dparts.append(f'steps={denoise["steps"]}')
        if "img2img" in denoise:
            dparts.append(f'img2img={denoise["img2img"]}')
        if "scheduler" in denoise:
            dparts.append(str(denoise["scheduler"]))
        parts.append('<span class="repro-denoise"><b>denoise:</b> ' + html.escape(" ".join(dparts)) + "</span>")
    seed = rep.get("seed")
    if seed is not None:
        parts.append(f'<span class="repro-seed"><b>seed:</b> {seed}</span>')
    if not parts:
        return ""
    return '<div class="reproducibility">' + " · ".join(parts) + "</div>"


def _short_name(p) -> str:
    """Short model/VAE/LoRA identifier: basename without common suffixes."""
    if not p:
        return ""
    s = os.path.basename(str(p))
    for suf in (".safetensors", ".int8", ".bf16", ".fp32", ".mlx"):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return s


def _build_config_html(item: dict, T: dict) -> str:
    """Per-image generation config panel: pipeline/transformer · VAE · LoRA ·
    resolution · steps · cfg · seed. Sourced from the sibling run.json (via
    item["config"]). Returns "" when no run.json — graceful for external images.
    Shows what model stack produced each image so A/B reviews are interpretable.
    """
    cfg = item.get("config") or {}
    if not cfg:
        return ""
    rows = []

    # Model: pipeline + transformer (the actual model dir)
    pipeline = cfg.get("pipeline")
    tf = cfg.get("transformer")
    model_bits = []
    if pipeline:
        model_bits.append(html.escape(str(pipeline)))
    if tf:
        model_bits.append(html.escape(_short_name(tf)))
    quant = cfg.get("quantize")
    if quant:
        model_bits.append(f'{html.escape(str(quant))}-bit')
    if model_bits:
        rows.append(f'<span class="cfg-model"><b>{T["cfg_model"]}:</b> {" · ".join(model_bits)}</span>')

    # VAE (None = pipeline default — show explicitly so defaults are visible)
    vae = cfg.get("vae_path")
    vae_str = html.escape(_short_name(vae)) if vae else T["cfg_default"]
    rows.append(f'<span class="cfg-vae"><b>{T["cfg_vae"]}:</b> {vae_str}</span>')

    # LoRA: lora_paths (multi) wins over lora_path (single); pair with scales
    lps = cfg.get("lora_paths") or []
    lsc = cfg.get("lora_scales") or []
    if not lps and cfg.get("lora_path"):
        lps = [cfg.get("lora_path")]
        lsc = [cfg.get("lora_scale")] if cfg.get("lora_scale") is not None else []
    if lps:
        lstrs = []
        for i, lp in enumerate(lps):
            name = html.escape(_short_name(lp))
            scale = lsc[i] if i < len(lsc) else None
            lstrs.append(f"{name}@{scale}" if scale is not None else name)
        rows.append(f'<span class="cfg-lora"><b>{T["cfg_lora"]}:</b> {", ".join(lstrs)}</span>')
    else:
        rows.append(f'<span class="cfg-lora"><b>{T["cfg_lora"]}:</b> {T["cfg_none"]}</span>')

    # Resolution + steps + cfg + seed (the param knobs)
    w, h = cfg.get("width"), cfg.get("height")
    param_bits = []
    if w and h:
        param_bits.append(f'{html.escape(str(w))}×{html.escape(str(h))}')
    if cfg.get("steps") is not None:
        param_bits.append(f'steps={cfg["steps"]}')
    if cfg.get("cfg_scale") is not None:
        param_bits.append(f'cfg={cfg["cfg_scale"]}')
    if param_bits:
        rows.append(f'<span class="cfg-params"><b>{T["cfg_params"]}:</b> {" ".join(param_bits)}</span>')
    if cfg.get("seed") is not None:
        rows.append(f'<span class="cfg-seed"><b>{T["cfg_seed"]}:</b> {cfg["seed"]}</span>')

    if not rows:
        return ""
    return '<div class="config-panel"><b class="cfg-title">' + T["config_label"] + '</b> ' + " ".join(rows) + "</div>"


def _build_card_html(gi: int, li: int, item: dict, variant_label: str, T: dict) -> str:
    bars_html = _score_bars_html(item)
    captured_html = "".join(
        f'<span class="tag captured">{html.escape(str(c))}</span>' for c in item["captured"]
    )
    missed_html = "".join(
        f'<span class="tag missed">{html.escape(str(m))}</span>' for m in item["missed"]
    )
    issues_html = "".join(f'<li>{html.escape(str(s))}</li>' for s in item["issues"])
    strengths_html = "".join(f'<li>{html.escape(str(s))}</li>' for s in item["strengths"])
    variant_html = (
        f'<div class="variant"><b>{html.escape(variant_label)}</b></div>'
        if variant_label else ""
    )
    summary_html = (
        f'<p class="summary"><b>VLM:</b> <i>{html.escape(item["summary"])}</i></p>'
        if item["summary"] else ""
    )
    repro_html = _build_reproducibility_html(item)
    config_html = _build_config_html(item, T)
    # Media: embed a playable <video> (poster = the captioned first frame) when a
    # sibling mp4 exists (video A/B review); otherwise the usual zoomable <img>.
    if item.get("video_src"):
        media_html = (
            f'<video class="card-video" controls preload="none" playsinline '
            f'poster="{html.escape(item["image_src"])}" '
            f'src="{html.escape(item["video_src"])}"></video>'
        )
    else:
        media_html = (
            f'<img src="{html.escape(item["image_src"])}" '
            f'alt="{html.escape(item["filename"])}" onclick="openLb(this.src)"/>'
        )
    return f"""
        <div class="img-card" data-set="{gi}" data-idx="{li}"
             data-variant="{html.escape(variant_label)}" data-filename="{html.escape(item['filename'])}">
          <div class="card-header">
            <h3>{html.escape(item['filename'])}</h3>
            <label class="pick-label"><input type="radio" name="best_set{gi}" value="{li}"/> {T['best']}</label>
          </div>
          {config_html}
          {variant_html}
          <div class="img-wrap">
            {media_html}
          </div>
          <div class="scores">{bars_html}</div>
          <div class="tags-row">
            <div class="tags captured-list"><b>{T['captured']}:</b> {captured_html or T['none']}</div>
            <div class="tags missed-list"><b>{T['missed']}:</b> {missed_html or T['none']}</div>
          </div>
          {summary_html}
          {repro_html}
          <details class="details-section">
            <summary>{T['strengths']}</summary>
            <div class="details-inner">
              <b>{T['str_label']}:</b><ul>{strengths_html or f"<li>{T['none']}</li>"}</ul>
              <b>{T['issues_label']}:</b><ul>{issues_html or f"<li>{T['none']}</li>"}</ul>
            </div>
          </details>
          <textarea class="comment-box" data-set="{gi}" data-idx="{li}" placeholder="{T['comment_ph']}"></textarea>
          <div class="stars" data-set="{gi}" data-idx="{li}" data-rating="0">
            <span class="stars-label">{T['rating']}:</span>
            <span class="star-row">{''.join('<span class="star" data-val="%d">★</span>' % v for v in (1, 2, 3, 4, 5))}</span>
          </div>
        </div>
        """


def _build_recommendation_html(group: dict, T: dict) -> str:
    """Per-set VLM recommendation: winner by overall, tiebreak detail+sharpness+artifacts.
    When overalls tie, append a note so a detail/sharpness win (e.g. SeedVR2) is self-explaining.
    Returns '' if fewer than 2 items or no score difference at all."""
    items = group["items"]
    if len(items) < 2:
        return ""
    variants = group.get("variants") or []

    def label(i):
        if i < len(variants) and variants[i]:
            return variants[i].get("label", "") or items[i]["filename"]
        return items[i]["filename"]

    def overall(it):
        return it["scores"].get("overall", 0)

    def detsum(it):
        s = it["scores"]
        return s.get("detail", 0) + s.get("sharpness", 0) + s.get("artifacts", 0)

    order = sorted(range(len(items)), key=lambda i: (overall(items[i]), detsum(items[i])), reverse=True)
    top, second = items[order[0]], items[order[1]]
    if overall(top) == overall(second) and detsum(top) == detsum(second):
        return ""  # no measurable difference
    winner = order[0]
    note = T["tiebreak"] if overall(top) == overall(second) else ""
    scores_str = "  ·  ".join(
        f"{html.escape(label(i))}: overall {overall(items[i])}" for i in order
    )
    return (
        f'<div class="set-recommendation"><b>{T['reco_label']}:</b> '
        f'{html.escape(label(winner))}{note}<span class="reco-scores">  —  {scores_str}</span></div>'
    )


def _build_group_table_html(group: dict, T: dict) -> str:
    items = group["items"]
    variants = group.get("variants") or []
    header = f"<th>{T['dimension']}</th>" + "".join(
        f'<th>{html.escape((variants[i].get("label") if i < len(variants) and variants[i] else "") or items[i]["filename"])}</th>'
        for i in range(len(items))
    )
    rows = ""
    for key, label in zip(_SCORE_KEYS, _SCORE_LABELS):
        vals = [item["scores"].get(key, 0) for item in items]
        best_val = max(vals) if vals else 0
        row = f"<tr><td class='metric-name'>{label}</td>"
        for v in vals:
            cls = "win" if v == best_val and best_val > 0 else ""
            row += f'<td class="{cls}">{v}</td>'
        row += "</tr>"
        rows += row
    return f'<table><thead><tr>{header}</tr></thead><tbody>{rows}</tbody></table>'


def generate_review_html(caption_json_paths: list[str] | None = None,
                         output_path: str | None = None,
                         groups: list[dict[str, Any]] | None = None,
                         manifest_path: str | None = None,
                         lang: str | None = None) -> str:
    """Generate a multi-set A/B review HTML from caption JSON files.

    Images are referenced by RELATIVE filename and the HTML is written next to
    them, so the browser loads them from disk (no base64, no CWD dependency).

    Args:
        caption_json_paths: Flat list → wrapped into one implicit set "Comparison"
            (backwards-compatible with --review-html).
        output_path: Where to write the HTML. Default: review_<ts>.html in the
            same folder as the images (so relative <img src> resolves).
        groups: List of {name, prompt?, guide?, variants?:[{label}], files:[caption_jsons]}.
        manifest_path: Path to a JSON {lang?, sets:[...]} → loaded into groups.
        lang: Chrome language ("en" | "zh_TW"). Manifest `lang` overrides; default "en".

    Returns:
        Absolute path to the generated HTML file.
    """
    import datetime

    # Resolve groups: manifest → explicit groups → flat list wrapped as one set
    base_dir = ""
    mf = {}
    if manifest_path:
        manifest_path = os.path.abspath(manifest_path)
        base_dir = os.path.dirname(manifest_path)
        with open(manifest_path) as f:
            mf = json.load(f)
        groups = mf.get("sets", [])
    elif groups is None:
        groups = [{"name": "Comparison", "files": caption_json_paths or []}]
        if caption_json_paths:
            base_dir = os.path.dirname(os.path.abspath(caption_json_paths[0]))

    # Resolve chrome language (VLM caption CONTENT is unaffected — it is whatever
    # run.py caption --style produced). kwarg > manifest > "en".
    resolved_lang = lang or mf.get("lang") or "en"
    T = _REVIEW_I18N.get(resolved_lang, _REVIEW_I18N["en"])

    # Per-image reproducibility map (keyed by caption filename) from the workflow's
    # ab_manifest.json "reproducibility" field. Empty for old/flat manifests — graceful.
    repro_map = mf.get("reproducibility") or {}

    # Load items per group, resolving relative file paths
    rendered = []
    for gi, g in enumerate(groups):
        items = []
        for fp in (g.get("files") or []):
            resolved = _resolve_review_path(fp, base_dir)
            if not resolved or not os.path.exists(resolved):
                print(f"WARNING: caption JSON not found, skipping: {fp}", file=sys.stderr)
                continue
            try:
                _ri = _load_review_item(resolved)
                _ri["reproducibility"] = repro_map.get(os.path.basename(resolved))
                items.append(_ri)
            except Exception as e:
                print(f"WARNING: could not load caption JSON {fp}: {e}", file=sys.stderr)
        if not items:
            continue
        rendered.append({
            "name": g.get("name") or f"Set {gi + 1}",
            "prompt": g.get("prompt", "") or "",
            "guide": g.get("guide", "") or "",
            "variants": g.get("variants") or [],
            "items": items,
        })

    total_items = sum(len(g["items"]) for g in rendered)
    if total_items == 0:
        raise ValueError("No valid caption JSON items to render")

    # Default output path = the images' folder (so relative <img src> resolves)
    default_dir = os.path.dirname(os.path.abspath(rendered[0]["items"][0]["caption_path"]))
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    if not output_path:
        ts_file = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(default_dir, f"review_{ts_file}.html")
    else:
        output_path = os.path.abspath(output_path)
        if os.path.abspath(os.path.dirname(output_path)) != os.path.abspath(default_dir):
            print(
                f"WARNING: --html-output directory differs from the images' folder "
                f"({default_dir}). Relative <img src> links will break — write the "
                f"HTML next to the images.",
                file=sys.stderr,
            )

    first_model = rendered[0]["items"][0].get("model", "")
    title = mf.get("title") or "A/B Review"

    # Build per-set sections (guide + VLM recommendation + cards + table)
    sets_html = ""
    for gi, group in enumerate(rendered):
        variants = group["variants"]
        cards = ""
        for li, item in enumerate(group["items"]):
            vlabel = ""
            if li < len(variants) and variants[li]:
                vlabel = variants[li].get("label", "") or ""
            cards += _build_card_html(gi, li, item, vlabel, T)
        n = len(group["items"])
        prompt_html = (
            f'<p class="set-prompt"><b>{T["prompt_label"]}:</b> {html.escape(group["prompt"])}</p>'
            if group["prompt"] else ""
        )
        guide_html = (
            f'<div class="set-guide"><b>{T["guide_label"]}:</b> {html.escape(group["guide"])}</div>'
            if group.get("guide") else ""
        )
        reco_html = _build_recommendation_html(group, T)
        sets_html += f"""
    <section class="set" data-set="{gi}">
      <h2 class="set-title"><span class="set-name">{html.escape(group['name'])}</span>
        <span class="set-count">({T['img_count'](n)})</span></h2>
      {reco_html}
      {prompt_html}
      {guide_html}
      <div class="set-images">{cards}</div>
      <h3 class="tbl-title">{T['compare']}</h3>
      {_build_group_table_html(group, T)}
    </section>
    """

    html_content = f"""<!DOCTYPE html>
<html lang="{resolved_lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html.escape(title)} — {ts}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#181818;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2rem 2rem 5rem;line-height:1.5}}
h1{{color:#fff;font-size:1.35rem;margin-bottom:.3rem}}
.meta{{color:#555;font-size:.8rem;margin-bottom:1.5rem}}
.set{{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:10px;padding:1.2rem;margin-bottom:1.5rem}}
.set-title{{color:#fff;font-size:1.05rem;margin-bottom:.6rem;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}}
.set-name{{font-weight:600}}
.set-count{{color:#666;font-size:.78rem;font-weight:400}}
.set-recommendation{{background:#11271a;border-left:3px solid #6cbe6c;padding:.5rem .75rem;border-radius:0 4px 4px 0;font-size:.82rem;color:#9be0a6;margin-bottom:.75rem}}
.set-recommendation .reco-scores{{color:#777;font-size:.76rem}}
.set-prompt{{background:#161616;border-left:3px solid #4a9eff;padding:.5rem .75rem;border-radius:0 4px 4px 0;font-size:.8rem;color:#bbb;margin-bottom:.75rem;word-break:break-word}}
.set-guide{{background:#2a2410;border-left:3px solid #e0a800;padding:.5rem .75rem;border-radius:0 4px 4px 0;font-size:.8rem;color:#e8c873;margin-bottom:.75rem}}
.set-images{{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem}}
.tbl-title{{color:#888;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin:.8rem 0 .4rem}}
.img-card{{flex:1;min-width:300px;max-width:600px;background:#222;border-radius:8px;padding:1rem;border:1px solid #2e2e2e}}
.card-header{{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:.5rem}}
.card-header h3{{font-size:.8rem;color:#ccc;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.variant{{font-size:.78rem;color:#4a9eff;margin-bottom:.5rem}}
.pick-label{{font-size:.82rem;color:#888;cursor:pointer;white-space:nowrap}}
.pick-label input{{margin-right:4px}}
.img-wrap{{margin-bottom:.8rem}}
.img-card img{{width:100%;border-radius:4px;display:block;cursor:zoom-in;transition:opacity .15s;background:#111}}
.img-card img:hover{{opacity:.9}}
.img-card video.card-video{{width:100%;border-radius:4px;display:block;background:#111;max-height:70vh}}
.scores{{margin-bottom:.7rem}}
.score-row{{display:flex;align-items:center;gap:8px;margin-bottom:4px}}
.score-label{{width:90px;font-size:.75rem;color:#999;text-align:right}}
.score-bar-bg{{flex:1;height:14px;background:#333;border-radius:7px;overflow:hidden}}
.score-bar-fill{{height:100%;border-radius:7px;transition:width .3s}}
.score-val{{width:24px;font-size:.82rem;font-weight:600;text-align:right}}
.tags-row{{margin-bottom:.5rem}}
.tags{{margin-bottom:4px;font-size:.75rem}}
.tag{{display:inline-block;padding:2px 8px;border-radius:4px;margin:2px;font-size:.72rem}}
.tag.captured{{background:#1b4332;color:#6cbe6c}}
.tag.missed{{background:#4a1c1c;color:#e07070}}
.summary{{color:#bbb;font-size:.8rem;margin:.6rem 0;padding:.4rem .6rem;background:#1a1a1a;border-radius:4px}}
.details-section{{margin-bottom:.5rem}}
.details-section summary{{cursor:pointer;color:#888;font-size:.78rem;padding:4px 0}}
.details-inner{{padding:.5rem 0;font-size:.8rem;color:#aaa}}
.details-inner ul{{padding-left:1.2rem;margin:4px 0}}
.comment-box{{width:100%;min-height:48px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#ddd;padding:8px;font-size:.82rem;resize:vertical;margin-top:.5rem;font-family:inherit}}
.comment-box:focus{{border-color:#4a9eff;outline:none}}
.stars{{margin-top:.5rem;display:flex;align-items:center;gap:.4rem}}
.stars-label{{color:#888;font-size:.78rem}}
.star-row{{cursor:pointer;user-select:none;font-size:1.15rem;letter-spacing:2px;line-height:1}}
.star{{color:#3a3a3a;transition:color .1s}}
.star:hover{{color:#888}}
.stars[data-rating="0"] .star:hover,
.star.active{{color:#f5a623}}
.modal{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:200;align-items:center;justify-content:center}}
.modal.open{{display:flex}}
.modal-box{{background:#222;border:1px solid #333;border-radius:8px;width:min(680px,92vw);max-height:86vh;display:flex;flex-direction:column}}
.modal-bar{{display:flex;justify-content:space-between;align-items:center;padding:.6rem .9rem;border-bottom:1px solid #2e2e2e;color:#ccc;font-size:.85rem}}
.modal-bar button{{background:none;border:none;color:#888;font-size:1.4rem;cursor:pointer;line-height:1}}
.modal-box textarea{{flex:1;width:100%;min-height:340px;background:#1a1a1a;border:none;border-radius:0 0 8px 8px;color:#ddd;padding:.8rem;font-size:.78rem;font-family:monospace;resize:none}}
table{{width:100%;border-collapse:collapse;background:#1e1e1e;border-radius:8px;overflow:hidden;border:1px solid #2a2a2a}}
th{{text-align:center;padding:.5rem .8rem;background:#242424;color:#666;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}}
td{{text-align:center;padding:.45rem .8rem;border-bottom:1px solid #252525;font-size:.85rem}}
.metric-name{{text-align:left;color:#999}}
.win{{color:#6cbe6c;font-weight:600}}
.bottom-bar{{position:fixed;bottom:0;left:0;right:0;background:#222;border-top:1px solid #333;padding:.75rem 2rem;display:flex;gap:1rem;align-items:center;z-index:100}}
.bottom-bar button{{background:#4a9eff;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:.85rem}}
.bottom-bar button:hover{{background:#3a8eef}}
.bottom-bar .status{{color:#888;font-size:.82rem}}
.lb{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:999;flex-direction:column}}
.lb.open{{display:flex}}
.lb-bar{{display:flex;gap:6px;align-items:center;padding:10px 16px;background:#111;border-bottom:1px solid #222;flex:none}}
.lb-bar button{{background:#333;color:#ddd;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:.85rem}}
.lb-bar button.active{{background:#4a9eff;color:#fff}}
.lb-bar .lb-close{{margin-left:auto;background:#4a1c1c;color:#e07070;font-size:1rem;line-height:1}}
.lb-hint{{color:#666;font-size:.76rem}}
.lb-viewport{{flex:1;overflow:auto;display:flex;align-items:safe center;justify-content:safe center;cursor:zoom-out}}
#lb-img{{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:4px;cursor:default}}
.reproducibility{{font-size:.82em;color:#555;margin:4px 0 8px;padding:4px 6px;background:#f7f7f7;border-radius:3px;line-height:1.5}}
.reproducibility b{{color:#333}}
.config-panel{{font-size:.76rem;color:#9a9a9a;margin:0 0 .6rem;padding:.4rem .55rem;background:#181818;border:1px solid #2a2a2a;border-radius:5px;line-height:1.7;word-break:break-word}}
.config-panel .cfg-title{{color:#4a9eff;margin-right:.15rem}}
.config-panel b{{color:#bbb}}
.config-panel span{{margin-right:.35rem;white-space:nowrap}}
.config-panel span.cfg-params,.config-panel span.cfg-seed{{white-space:normal}}
</style>
</head>
<body>
<h1>{html.escape(title)}</h1>
<p class="meta">Generated {ts} &middot; {total_items} {T['meta_across']} {len(rendered)} {T['meta_sets']} &middot; VLM: {html.escape(str(first_model))}</p>

{sets_html}

<div class="lb" id="lb">
  <div class="lb-bar">
    <button data-z="1" class="active">1&times;</button>
    <button data-z="2">2&times;</button>
    <button data-z="4">4&times;</button>
    <span class="lb-hint">{T['close_hint']}</span>
    <button class="lb-close" onclick="closeLb()">&times;</button>
  </div>
  <div class="lb-viewport" id="lb-vp" onclick="closeLb()">
    <img id="lb-img" src="" alt="" onclick="event.stopPropagation()"/>
  </div>
</div>

<div class="bottom-bar">
  <button onclick="exportFeedback()">{T['export']}</button>
  <button onclick="exportFeedback('copy')">{T['copy']}</button>
  <span class="status" id="status"></span>
</div>

<div class="modal" id="json-modal" onclick="if(event.target===this)closeJsonModal()">
  <div class="modal-box">
    <div class="modal-bar"><span>{T['copy_fallback']}</span><button onclick="closeJsonModal()">&times;</button></div>
    <textarea id="json-modal-text" readonly></textarea>
  </div>
</div>

<script>
function setZoom(n) {{
  var img = document.getElementById('lb-img');
  document.querySelectorAll('.lb-bar button[data-z]').forEach(function(b) {{
    b.classList.toggle('active', b.dataset.z === String(n));
  }});
  if (n === 1) {{
    img.style.width = ''; img.style.height = '';
    img.style.maxWidth = '90vw'; img.style.maxHeight = '90vh';
  }} else {{
    img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
    img.style.width = (img.naturalWidth * n) + 'px';
    img.style.height = 'auto';
  }}
}}
function openLb(src) {{
  var img = document.getElementById('lb-img');
  img.src = src;
  document.getElementById('lb').classList.add('open');
  setZoom(1);
  document.getElementById('lb-vp').scrollTo(0, 0);
}}
function closeLb() {{
  document.getElementById('lb').classList.remove('open');
}}
document.querySelectorAll('.lb-bar button[data-z]').forEach(function(b) {{
  b.addEventListener('click', function() {{ setZoom(parseInt(b.dataset.z)); }});
}});
document.addEventListener('keydown', function(e) {{
  if (e.key === 'Escape') {{ closeLb(); closeJsonModal(); }}
}});

// ── 5-star rating (event delegation) ──────────────────────────────────────
document.addEventListener('click', function(e) {{
  var star = e.target.closest('.star');
  if (!star) return;
  var container = star.closest('.stars');
  var val = parseInt(star.dataset.val);
  container.dataset.rating = String(val);
  container.querySelectorAll('.star').forEach(function(s) {{
    s.classList.toggle('active', parseInt(s.dataset.val) <= val);
  }});
}});

// ── Feedback export: 'copy' (clipboard + modal fallback) or download ──────
function buildFeedbackData() {{
  var data = {{ timestamp: new Date().toISOString(), sets: [] }};
  document.querySelectorAll('section.set').forEach(function(set) {{
    var gi = set.dataset.set;
    var nameEl = set.querySelector('.set-name');
    var promptEl = set.querySelector('.set-prompt');
    var promptText = '';
    if (promptEl) {{
      // strip the localized "<label>:" prefix (works for "Prompt:" and "提示詞:")
      promptText = (promptEl.textContent || '').replace(/^\\s*[^:]*:\\s*/, '').trim();
    }}
    var best = set.querySelector('input[name="best_set' + gi + '"]:checked');
    var images = [];
    set.querySelectorAll('.img-card').forEach(function(card) {{
      var starsEl = card.querySelector('.stars');
      images.push({{
        index: parseInt(card.dataset.idx),
        filename: card.dataset.filename || '',
        variant: card.dataset.variant || '',
        rating: starsEl ? parseInt(starsEl.dataset.rating || '0') : 0,
        comment: card.querySelector('.comment-box').value
      }});
    }});
    data.sets.push({{
      name: nameEl ? nameEl.textContent.trim() : '',
      prompt: promptText,
      best_image: best ? parseInt(best.value) : null,
      images: images
    }});
  }});
  return data;
}}
function flashStatus(msg) {{
  var s = document.getElementById('status');
  s.textContent = msg;
  setTimeout(function() {{ s.textContent = ''; }}, 3000);
}}
function showJsonModal(jsonStr) {{
  var ta = document.getElementById('json-modal-text');
  ta.value = jsonStr;
  document.getElementById('json-modal').classList.add('open');
  ta.focus(); ta.select();
}}
function closeJsonModal() {{
  document.getElementById('json-modal').classList.remove('open');
}}
function exportFeedback(mode) {{
  var jsonStr = JSON.stringify(buildFeedbackData(), null, 2);
  if (mode === 'copy') {{
    // file:// URLs may block the async Clipboard API → always offer the modal
    // textarea as a reliable manual-copy fallback.
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      navigator.clipboard.writeText(jsonStr).then(function() {{
        flashStatus('{T['copied']}');
      }}).catch(function() {{ showJsonModal(jsonStr); }});
    }} else {{
      showJsonModal(jsonStr);
    }}
    return;
  }}
  var blob = new Blob([jsonStr], {{type: 'application/json'}});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'review_feedback.json';
  a.click();
  URL.revokeObjectURL(url);
  flashStatus('{T['exported']}');
}}
</script>
</body>
</html>"""

    with open(output_path, "w") as f:
        f.write(html_content)

    return os.path.abspath(output_path)
