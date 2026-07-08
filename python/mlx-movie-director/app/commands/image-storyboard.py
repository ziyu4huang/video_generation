"""image-storyboard — storyline → storyboard → image pipeline (local, gemma-planned).

The OM-shaped local storyboard flow (Step 3 of next-goal-20260708-080000):
  story → scene list → shot_prompt_builder (5-layer) → batch image-gen
  (recurring characters use the character-lock: locked seed + hero as i2i
  reference) → contact-sheet storyboard + per-frame set.

This is the keystone that CERTIFIES both Step 2 (character consistency) and Step
3 (storyboard) in one flow: a short story → N frames, character-consistent where
a character recurs, gemma-planned (or deterministic via --scenes/--self-test for
certification), zero cloud.

Decomposition (story → SceneSpec list) is the gemma brain's job (constraint 2:
never a cloud LLM). For CERTIFICATION this command ships a deterministic
``--self-test`` fixture + accepts ``--scenes <json>`` so the full pipeline runs
end-to-end without the brain. The ``--story`` path loads a gemma decomposition
template (data/storyboard_prompts/) and is the production entry; when the brain
is unavailable it falls back to a clear, deterministic 3-beat decomposition so the
command never hard-fails on a missing runtime.

Generation reuses the tested ``execute_generation`` core (the same path t2i uses)
— no new MLX generation code (the Step-1 "wiring not new code" thesis).
"""
from __future__ import annotations

import argparse
import json
import os
import time
from typing import TYPE_CHECKING, Any

from app import config as cfg
from app.planning.scene_spec import SceneSpec, ShotLanguage, plan_storyboard

if TYPE_CHECKING:
    from app.run_config import RunConfig


# ---------------------------------------------------------------------------
# Deterministic fixtures (certify the pipeline without the gemma brain)
# ---------------------------------------------------------------------------

def _shot(sz: str, light: str, lens: int | None = None) -> ShotLanguage:
    return ShotLanguage(shot_size=sz, lighting_key=light, lens_mm=lens)


def _deterministic_fixture() -> list[SceneSpec]:
    """A 3-beat detective noir storyboard with one recurring character."""
    return [
        SceneSpec(
            id="beat-1",
            subject="a weary detective in a trench coat",
            scene="a rain-soaked alley at night",
            motion="lighting a cigarette under a flickering lamp",
            shot_language=_shot("wide", "low_key", lens=35),
            texture_keywords=["neon reflections", "wet pavement", "cigarette smoke"],
            character_id="detective",
            hero_moment=True,
        ),
        SceneSpec(
            id="beat-2",
            subject="the same detective",
            scene="a cramped diner booth",
            motion="studying a case file across the table",
            shot_language=_shot("medium", "tungsten_warm", lens=50),
            texture_keywords=["steam from coffee", "scattered photographs"],
            character_id="detective",
        ),
        SceneSpec(
            id="beat-3",
            subject="the detective",
            scene="the city rooftop at dawn",
            motion="looking out over the skyline",
            shot_language=_shot("medium_close", "blue_hour", lens=85),
            texture_keywords=["wind-blown coat", "soft morning haze"],
            character_id="detective",
            hero_moment=True,
        ),
    ]


# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

def add_storyboard_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--scenes", type=str, default=None,
        help="Path to a JSON file with a scene list (deterministic; bypasses the "
             "gemma decomposition). Each scene: {id, subject, scene, motion?, "
             "shot_language?, texture_keywords?, character_id?, hero_moment?}.",
    )
    parser.add_argument(
        "--story", type=str, default=None,
        help="Free-form story text. The local gemma brain decomposes it into a "
             "SceneSpec list (Story2Board-shaped: N panels, consistent character "
             "identity, diverse camera). When the brain is unavailable, falls back "
             "to a deterministic 3-beat decomposition so the pipeline still runs.",
    )
    parser.add_argument(
        "--num-panels", type=int, default=4, metavar="N",
        help="Number of storyboard panels to plan from --story (default: 4).",
    )
    parser.add_argument(
        "--style-hint", type=str, default=None,
        help="Look/genre anchor baked into every panel (e.g. 'noir, 35mm film "
             "grain, teal-and-orange grade'). Optional.",
    )
    # Step 1a (hardening): pin a FAST NON-THINKING instruct model for decomposition
    # (a 7-12B instruct lands <60s vs gemma-4-26b's 3-5min thinking pass). Falls back
    # to the gemma brain (vlm_model / the caption resolver) when unset.
    parser.add_argument(
        "--decompose-model", type=str, default=None, dest="decompose_model",
        help="Local LM Studio model id for the story→scene decomposition. Pin a "
             "fast NON-THINKING instruct model here (e.g. a 7-12B Qwen/Llama instruct) "
             "for a <60s decomposition; the default gemma brain is a 3-5min thinking "
             "pass. Unset → the gemma brain (vlm_model / the caption resolver).",
    )
    # Step 1b (hardening): the identity JUDGE tier. _vlm_verify_identity was authored
    # for Qwen3-VL multi-image; gemma's multi-image JSON is flaky (1/4 parsed in #366).
    parser.add_argument(
        "--identity-judge-model", type=str, default="qwen/qwen3-vl-4b",
        dest="identity_judge_model",
        help="Local VLM model id for the multi-image identity judge "
             "(_vlm_verify_identity). Default qwen/qwen3-vl-4b — the model the "
             "identity prompt was authored for (gemma multi-image JSON is flaky). "
             "Falls back to the gemma brain if Qwen3-VL is unavailable.",
    )
    # NOTE: --vlm-api-url / --vlm-model are NOT re-registered here — image-profile's
    # add_profile_args already registers them on the shared `image` parser (image.py
    # calls it before add_storyboard_args), so args.vlm_api_url / args.vlm_model are
    # already populated. Re-registering would raise a conflicting-option-string error.
    parser.add_argument(
        "--style-context", type=str, default=None,
        help="Path to a JSON style context (Layer 5: {mood, visual_language:{aesthetic}}).",
    )
    parser.add_argument(
        "--character", type=str, default=None,
        help="Hero image path. Recurring-character shots lock seed + use this as "
             "the i2i reference (the character-lock). Required for cross-shot "
             "identity; without it, all shots are independent T2I.",
    )
    parser.add_argument(
        "--judge", action="store_true", default=False,
        help="Run `run.py caption --style score` on each frame (the closed loop's "
             "judge step). Needs LM Studio; skipped gracefully if unavailable.",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_scenes(args: argparse.Namespace) -> list[SceneSpec]:
    """Resolve the scene list: --self-test fixture, --scenes JSON, or --story."""
    if getattr(args, "self_test", None):
        return _deterministic_fixture()
    if args.scenes:
        with open(args.scenes, "r") as f:
            raw = json.load(f)
        if not isinstance(raw, list):
            raise ValueError(f"--scenes JSON must be a list, got {type(raw).__name__}")
        return [_scene_from_dict(s) for s in raw]
    if args.story:
        # Production path: the local gemma brain decomposes the story into a
        # SceneSpec list (constraint 2: brain = local gemma, never cloud). When the
        # brain is unreachable / returns unparseable JSON, fall back deterministically
        # so the pipeline still runs end-to-end (never hard-fail on runtime).
        num_panels = getattr(args, "num_panels", None) or 4
        style_hint = getattr(args, "style_hint", None)
        api_url = getattr(args, "vlm_api_url", None) or "http://localhost:1234/v1"
        # Step 1a: a pinned --decompose-model (fast non-thinking) wins; else the
        # shared --vlm-model / gemma brain resolver.
        model = getattr(args, "decompose_model", None) or getattr(args, "vlm_model", None)
        try:
            raw_scenes = _gemma_decompose(args.story, num_panels=num_panels,
                                          api_url=api_url, model=model,
                                          style_hint=style_hint)
            scenes = [_scene_from_dict(s) for s in raw_scenes]
            if scenes:
                print(f"[storyboard] gemma decomposed {len(scenes)} panels.", flush=True)
                return scenes
        except Exception as e:  # noqa: BLE001 — fall back is the documented behavior
            print(f"[storyboard] gemma decomposition unavailable ({type(e).__name__}: {e}); "
                  f"using deterministic fallback.", flush=True)
        return _deterministic_fixture()
    # No scene source: default to the fixture (so `image storyboard` alone runs).
    return _deterministic_fixture()


def _scene_from_dict(d: dict[str, Any]) -> SceneSpec:
    sl = d.get("shot_language") or {}
    return SceneSpec(
        id=str(d.get("id", f"scene-{d.get('_idx', '?')}")),
        subject=str(d.get("subject", "")),
        scene=str(d.get("scene", "")),
        motion=str(d.get("motion", "")),
        framing=str(d.get("framing", "")),
        shot_language=ShotLanguage(
            lens_mm=sl.get("lens_mm"),
            depth_of_field=sl.get("depth_of_field"),
            shot_size=sl.get("shot_size"),
            camera_movement=sl.get("camera_movement"),
            lighting_key=sl.get("lighting_key"),
            color_temperature=sl.get("color_temperature"),
        ),
        texture_keywords=list(d.get("texture_keywords", []) or []),
        character_id=d.get("character_id"),
        hero_moment=bool(d.get("hero_moment", False)),
        type=str(d.get("type", "visual")),
    )


def _gemma_decompose(story: str, *, num_panels: int = 4,
                     api_url: str = "http://localhost:1234/v1",
                     model: str | None = None,
                     style_hint: str | None = None) -> list[dict[str, Any]]:
    """Decompose a story into SceneSpec-shaped dicts via the local gemma brain.

    Thin wrapper over ``app.planning.gemma_brain.decompose_story``: builds the
    Story2Board-shaped prompt, calls LM Studio (text-only completion), and parses
    the strict ``SceneSpec[]`` JSON. Raises on unreachable brain / unparseable
    output — the caller falls back deterministically so the pipeline never breaks.

    LOCAL ONLY (constraint 2): the brain is the local gemma on LM Studio, never a
    cloud LLM. Generation stays on run.py (constraint 1).
    """
    from app.planning.gemma_brain import decompose_story
    return decompose_story(story, num_panels=num_panels, api_url=api_url,
                           model=model, style_hint=style_hint)


def _build_run_config(shot_prompt: str, args: argparse.Namespace,
                      hero: str | None, use_character_lock: bool) -> "RunConfig":
    """Build a RunConfig for one shot (the locked generation params)."""
    from app.run_config import RunConfig

    # The character-lock: recurring-character shots use the hero as the i2i
    # reference + locked seed + flux2-klein (which has reference conditioning).
    # Without a hero, every shot is independent T2I at the locked seed.
    pipeline = "flux2-klein" if (use_character_lock and hero) else getattr(args, "pipeline", "zimage") or "zimage"
    return RunConfig(
        command="image storyboard",
        pipeline=pipeline,
        prompt=shot_prompt,
        seed=getattr(args, "seed", None) or 777,   # LOCKED across all shots
        width=getattr(args, "width", None) or 640,
        height=getattr(args, "height", None) or 960,
        steps=getattr(args, "steps", None) or 9,
        input_image=hero if (use_character_lock and hero) else None,
        denoise_strength=0.85 if (use_character_lock and hero) else 1.0,
        lora_path=getattr(args, "lora_path", None),
        lora_scale=(getattr(args, "lora_scale", None) or 1.0) if getattr(args, "lora_path", None) else 1.0,
    )


def _newest_png_in_dir(directory: str) -> str | None:
    """Newest *.png in a flat dir (execute_generation writes exactly one per call)."""
    if not os.path.isdir(directory):
        return None
    best = None
    for name in os.listdir(directory):
        if not name.lower().endswith(".png"):
            continue
        path = os.path.join(directory, name)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if best is None or mtime > best[1]:
            best = (path, mtime)
    return best[0] if best else None


def _build_contact_sheet(image_paths: list[str], out_path: str, cols: int = 3) -> None:
    """Tile the frame PNGs into a contact-sheet grid (PIL)."""
    from PIL import Image

    if not image_paths:
        raise ValueError("no frames to build a contact sheet")
    thumbs = []
    target_w = 480
    for p in image_paths:
        im = Image.open(p).convert("RGB")
        ratio = target_w / im.width
        thumbs.append(im.resize((target_w, max(1, int(im.height * ratio)))))
    rows = (len(thumbs) + cols - 1) // cols
    th = max(t.height for t in thumbs)
    sheet = Image.new("RGB", (cols * target_w, rows * th), (16, 16, 16))
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        sheet.paste(t, (c * target_w, r * th))
    sheet.save(out_path)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_storyboard(args: argparse.Namespace) -> None:
    from app.commands._shared import execute_generation

    scenes = _load_scenes(args)
    style_context = None
    if args.style_context:
        with open(args.style_context, "r") as f:
            style_context = json.load(f)

    storyboard = plan_storyboard(scenes, style_context)
    print(f"[storyboard] {len(storyboard.shots)} shots, "
          f"recurring characters: {storyboard.recurring_characters or '(none)'}", flush=True)

    base_name = f"storyboard_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(cfg.OUTPUT_DIR, base_name)
    os.makedirs(out_dir, exist_ok=True)

    hero = args.character
    # Redirect generation output into the storyboard dir so frames + their manifests
    # land alongside storyboard.json. execute_generation reads cfg.OUTPUT_DIR via
    # make_output_paths(); save/restore so we don't leak the override.
    orig_output_dir = cfg.OUTPUT_DIR

    def _gen(shot: Any) -> dict[str, Any]:
        cfg.OUTPUT_DIR = out_dir
        use_lock = shot.character_id is not None and shot.character_id in storyboard.recurring_characters
        run_config = _build_run_config(shot.prompt, args, hero, use_lock)
        manifest_file = execute_generation(run_config, pipeline_type=run_config.pipeline)
        frame_path = _newest_png_in_dir(out_dir)
        if not frame_path:
            raise RuntimeError(f"shot {shot.scene_id} produced no image (manifest: {manifest_file})")
        return {
            "scene_id": shot.scene_id,
            "character_id": shot.character_id,
            "hero_moment": shot.hero_moment,
            "character_locked": use_lock,
            "prompt": shot.prompt,
            "image": frame_path,
            "manifest": manifest_file,
        }

    frames: list[dict[str, Any]] = []
    try:
        for i, shot in enumerate(storyboard.shots):
            tag = f"[storyboard {i + 1}/{len(storyboard.shots)}] {shot.scene_id}"
            tag += f" (character-lock: {shot.character_id})" if shot.character_id in storyboard.recurring_characters else ""
            print(f"{tag}\n  prompt: {shot.prompt[:120]}{'…' if len(shot.prompt) > 120 else ''}", flush=True)
            frames.append(_gen(shot))
    finally:
        cfg.OUTPUT_DIR = orig_output_dir

    # Contact sheet (the storyboard artifact).
    contact_path = os.path.join(out_dir, "contact_sheet.png")
    _build_contact_sheet([f["image"] for f in frames], contact_path)

    # Optional closed-loop judge (constraint 3: orchestrator reads TEXT judgments,
    # never pixels):
    #   1. mlx:caption --style score per frame (quality).
    #   2. For recurring characters with a hero: _vlm_verify_identity (multi-image
    #      same_identity) per frame vs the hero; regenerate weak frames ONCE (OM D12).
    if args.judge:
        frames = _judge_frames(frames)
        if hero and storyboard.recurring_characters:
            frames = _judge_identity(frames, hero, storyboard.recurring_characters, args)
            frames = _regenerate_weak_identity(frames, args, hero, out_dir, orig_output_dir)

    storyboard_json = os.path.join(out_dir, "storyboard.json")
    payload = {
        "command": "image storyboard",
        "shots": frames,
        "recurring_characters": storyboard.recurring_characters,
        "contact_sheet": contact_path,
        "hero": hero,
        "style_context": style_context,
    }
    with open(storyboard_json, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"\n[storyboard] ✓ {len(frames)} frames → {out_dir}", flush=True)
    print(f"  contact sheet : {contact_path}", flush=True)
    print(f"  plan          : {storyboard_json}", flush=True)
    print(f"Manifest:   {storyboard_json}")  # sentinel so adapters can find the artifact


def _identity_judge():
    """Lazy-load ``_vlm_verify_identity`` from the hyphenated image-profile module.

    ``app/commands/image-profile.py`` has a hyphen → not importable as a bare
    ``image_profile`` name; must go through importlib (like image.py does).
    """
    import importlib
    return importlib.import_module("app.commands.image-profile")._vlm_verify_identity


def _judge_identity(frames: list[dict[str, Any]], hero: str,
                    recurring_ids: list[str], args: argparse.Namespace) -> list[dict[str, Any]]:
    """Judge each recurring-character frame against the hero via the multi-image
    identity VLM (``image-profile._vlm_verify_identity`` → same_identity /
    face_match / identity_score). Best-effort: records the verdict on the frame
    and flags ``identity_weak`` when identity doesn't hold (constraint 3: the
    orchestrator reads TEXT judgments, never pixels). No regen here.
    """
    _vlm_verify_identity = _identity_judge()

    api_url = getattr(args, "vlm_api_url", None) or "http://localhost:1234/v1"
    # Step 1b: the identity judge tier defaults to Qwen3-VL (the model the
    # multi-image identity prompt was authored for; gemma's multi-image JSON is
    # flaky). Falls back to the gemma brain when Qwen3-VL is unavailable.
    model = _resolve_identity_judge_model(api_url, args)
    recurr_set = set(recurring_ids)
    for f in frames:
        if f.get("character_id") not in recurr_set:
            continue
        verdict = _vlm_verify_identity(hero, f["image"], api_url, model)
        f["identity"] = verdict
        if verdict is None:
            f["identity_weak"] = None  # judge unavailable — can't decide
            print(f"  [identity] {f['scene_id']} judge unavailable (skipped)", flush=True)
            continue
        same = bool(verdict.get("same_identity", False))
        score = verdict.get("identity_score")
        weak = (not same) or (isinstance(score, (int, float)) and score < 0.6)
        f["identity_weak"] = weak
        print(f"  [identity] {f['scene_id']}: same={same} score={score} "
              f"{'→ WEAK (will regen)' if weak else '→ ok'}", flush=True)
    return frames


def _regenerate_weak_identity(frames: list[dict[str, Any]], args: argparse.Namespace,
                              hero: str, out_dir: str, orig_output_dir: str) -> list[dict[str, Any]]:
    """Closed loop (OM D12): regenerate each identity-weak frame ONCE under the
    same character-lock, then re-judge. Frames already regenerated or whose judge
    was unavailable are left alone. Best-effort: a regen failure keeps the original.
    """
    from app.commands._shared import execute_generation
    _vlm_verify_identity = _identity_judge()

    api_url = getattr(args, "vlm_api_url", None) or "http://localhost:1234/v1"
    model = _resolve_identity_judge_model(api_url, args)
    weak = [f for f in frames if f.get("identity_weak") is True and not f.get("regen_attempted")]
    if not weak:
        return frames
    print(f"[storyboard] regenerating {len(weak)} identity-weak frame(s) once (OM D12 loop)", flush=True)
    cfg.OUTPUT_DIR = out_dir
    try:
        for f in weak:
            f["regen_attempted"] = True
            try:
                run_config = _build_run_config(f["prompt"], args, hero, use_character_lock=True)
                execute_generation(run_config, pipeline_type=run_config.pipeline)
                new_img = _newest_png_in_dir(out_dir)
                if new_img:
                    f["image"] = new_img
                    f["regenerated"] = True
            except Exception as e:  # noqa: BLE001 — keep the original frame on regen failure
                ename = type(e).__name__
                f["regen_error"] = f"{ename}: {e}"
                sid = f["scene_id"]
                print(f"  [regen] {sid} failed ({ename}); kept original", flush=True)
                continue
            # Re-judge the regenerated image.
            verdict = _vlm_verify_identity(hero, f["image"], api_url, model)
            f["identity_post_regen"] = verdict
            if verdict is not None:
                f["identity_weak"] = (not bool(verdict.get("same_identity", False))) or (
                    isinstance(verdict.get("identity_score"), (int, float))
                    and verdict["identity_score"] < 0.6)
            print(f"  [regen] {f['scene_id']} re-judged: same={verdict.get('same_identity') if verdict else 'n/a'}",
                  flush=True)
    finally:
        cfg.OUTPUT_DIR = orig_output_dir
    return frames


def _resolve_brain_model(api_url: str) -> str:
    """Resolve the local gemma brain model id (same resolver as `run.py caption`)."""
    try:
        from app.commands.caption import resolve_default_model
        return resolve_default_model(api_url)
    except Exception:  # noqa: BLE001 — caller treats None as "let LM Studio pick"
        return None


def _identity_judge_models(api_url: str) -> set[str]:
    """The set of model ids currently loaded/available on LM Studio."""
    try:
        import requests
        resp = requests.get(f"{api_url}/models", timeout=5)
        resp.raise_for_status()
        return {m.get("id", "") for m in resp.json().get("data", [])}
    except Exception:  # noqa: BLE001 — unavailable → empty set → fallback
        return set()


def _resolve_identity_judge_model(api_url: str, args: argparse.Namespace) -> str | None:
    """Resolve the identity-judge VLM, preferring Qwen3-VL (Step 1b).

    ``_vlm_verify_identity`` was authored for Qwen3-VL multi-image; gemma's
    multi-image JSON is the flaky path (1/4 parsed in PR #366). Default
    ``--identity-judge-model`` is qwen3-vl-4b. If that model is NOT loaded we fall
    back to the gemma brain (so the loop still runs) rather than hard-failing.
    """
    preferred = getattr(args, "identity_judge_model", None) or "qwen/qwen3-vl-4b"
    available = _identity_judge_models(api_url)
    # Exact match, or a loaded id that contains the preferred family token.
    if preferred in available or any("qwen3-vl" in m.lower() for m in available):
        return preferred
    # Fall back to the gemma brain (the proven single-image path) — never None-bind.
    return getattr(args, "vlm_model", None) or _resolve_brain_model(api_url)


def _judge_frames(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Closed-loop judge: run.py caption --style score on each frame (best-effort).

    Spawns the ``run.py caption`` CLI per frame rather than calling caption.py's
    internal ``run()`` directly — that decouples the storyboard from caption's
    argparse Namespace shape and exercises the EXACT judge path the orchestrator
    uses (constraint 3: vision via mlx:caption, never the orchestrator's eyes).
    Best-effort: a missing LM Studio / failed caption never blocks the storyboard.
    """
    import subprocess
    import sys

    run_py = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), "run.py")
    for f in frames:
        try:
            proc = subprocess.run(
                [sys.executable, run_py, "caption", f["image"], "--style", "score", "--lang", "en"],
                capture_output=True, text=True, timeout=180,
            )
            if proc.returncode != 0:
                f["caption_error"] = f"exit {proc.returncode}: {proc.stderr.strip()[:200]}"
                print(f"  [judge] {f['scene_id']} skipped (caption exit {proc.returncode})", flush=True)
                continue
            cap_path = os.path.splitext(f["image"])[0] + ".caption.json"
            if os.path.exists(cap_path):
                with open(cap_path, "r") as fh:
                    f["caption"] = json.load(fh)
        except Exception as e:  # noqa: BLE001 — judge is best-effort; never block the storyboard
            f["caption_error"] = f"{type(e).__name__}: {e}"
            print(f"  [judge] {f['scene_id']} skipped ({type(e).__name__})", flush=True)
    return frames
