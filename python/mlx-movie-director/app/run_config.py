"""Run configuration: schema, serialization, and migration for .run.json files."""

import argparse
import json
import os
from dataclasses import asdict, dataclass
from typing import Any, TypedDict

SCHEMA_VERSION = 14


class LoraEntry(TypedDict, total=False):
    """Structured LoRA entry: {path, scale, stage}.

    ``total=False`` keeps the entry loadable from older run.json files that may
    omit ``scale``/``stage``; consumers still index defensively. New entries are
    always built with all three keys (see RunConfig.from_args).
    """

    path: str
    scale: float | None
    stage: str


def _lora_manifest_recommended_scale(lora_path: str) -> float:
    """Read recommended_scale from the LoRA's sibling manifest.json, fallback to 1.0."""
    from pathlib import Path
    manifest = Path(lora_path).parent / "manifest.json"
    if manifest.exists():
        try:
            return float(json.loads(manifest.read_text()).get("recommended_scale", 1.0))
        except Exception:
            pass
    return 1.0


def lora_entry_scale(entry: LoraEntry) -> float:
    """Resolve a structured LoRA entry's effective scale as a non-None float.

    ``LoraEntry.scale`` is typed ``float | None`` because some stages (notably
    ``face_detail``) are built with ``"scale": None`` and defer to the LoRA
    manifest's ``recommended_scale`` at apply time. Downstream consumers that
    treat scale as a plain float would otherwise index ``entry["scale"]`` and
    get a ``float | None`` with no narrowing. Route every read through this
    helper so the None branch is resolved in one typed place: a None scale
    falls back to the manifest ``recommended_scale`` (and ultimately 1.0),
    never propagating None to a pipeline call that expects a float.
    """
    _scale = entry.get("scale")
    if _scale is None:
        _path = entry.get("path")
        if _path:
            return _lora_manifest_recommended_scale(_path)
        return 1.0
    return _scale


def _resolve_ab_params(args: argparse.Namespace) -> dict[str, list[Any]] | None:
    """Resolve the A/B-params metadata to serialize into run.json.

    Variation runs set ``args.ab_params_json`` to the already-parsed dict (see
    ``_run_variations``). For a single (non-variation) run, only the raw JSON
    string is available on ``args.ab_params`` — parse it here so the run.json
    keeps its ab_params metadata. Only dict-shaped values are kept, matching the
    RunConfig.ab_params annotation; anything else (lists, scalars, invalid JSON)
    falls back to None rather than violating the type.

    The documented contract is ``dict[str, list]`` (each key maps to one value
    per variation, see ``--ab-params`` in video-generate.py). We validate that
    inner shape here too: a dict containing non-list values is dropped to None
    rather than persisted as malformed metadata, matching the rejection already
    enforced by the variation driver in video-generate._generate.
    """
    _ab = getattr(args, "ab_params_json", None)
    if _ab is None:
        _raw = getattr(args, "ab_params", None)
        if _raw:
            try:
                _ab = json.loads(_raw)
            except (json.JSONDecodeError, TypeError):
                _ab = None
    if not isinstance(_ab, dict):
        return None
    # Enforce dict[str, list]: a dict with any non-list value is malformed
    # (variation driver indexes each value as values[variation_index]) and is
    # dropped rather than serialized into run.json.
    if not all(isinstance(_v, list) for _v in _ab.values()):
        return None
    return _ab


# v2 action names → v3 command names
_ACTION_TO_COMMAND = {
    "text2img": "generate",
    "img2img": "refine",
}


@dataclass
class RunConfig:
    """Captures every parameter for a single pipeline run.

    Written to <base_name>.run.json before execution starts.
    Loaded back via the replay command to reproduce a run.
    """

    schema_version: int = SCHEMA_VERSION
    command: str = "generate"           # replaces v2 "action" field

    # Pipeline selection
    pipeline: str = "zimage"            # "zimage" or "flux2-klein"
    transformer: str | None = None       # Transformer instance dir; None = pipeline default (zimage→cfg, flux2→klein-9b)

    # Prompt
    prompt: str | None = None
    prompt_file: str | None = None

    # Generation
    width: int = 640
    height: int = 960
    steps: int = 9
    seed: int = 777
    lora_path: str | None = None
    lora_scale: float = 1.0
    lora_paths: list[str] | None = None    # multi-LoRA: resolved paths (main stage)
    lora_scales: list[float] | None = None  # one per lora_paths entry
    vae_path: str | None = None

    # img2img / refine / FLF2V keyframe reference
    input_image: str | None = None   # Reference image for: I2V conditioning (video),
                                     # T2I visual anchor (image), FLF2V keyframe background
                                     # consistency (use same seed + different prompt)
    latent_upscale: float = 1.0
    denoise_strength: float = 1.0

    # Post-process
    upscale: bool = False
    upscale_model: str | None = None
    upscale_method: str = "esrgan"

    # Batch
    count: int = 1
    seed_start: int | None = None

    # Video (LTX)
    frames: int | None = None
    fps: float | None = None
    video_model: str | None = None
    cfg_scale: float = 5.0
    stg_scale: float = 1.0
    low_ram: bool = False
    audio: str | None = None
    stage1_steps: int | None = None
    stage2_steps: int | None = None
    hq: bool = False
    teacache: bool = False
    teacache_thresh: float | None = None
    enhance_prompt: bool = False

    # FLF2V (First-Last Frame to Video / 首尾帧视频生成)
    begin_image: str | None = None
    end_image: str | None = None
    begin_strength: float = 1.0
    end_strength: float = 1.0

    # Distilled mode (faster generation: 8 steps, CFG=1)
    distilled: bool = False

    # Temporal upscaling (F → 2F-1 frames after Stage 2, before VAE decode)
    temporal_upscale: bool = False

    # Future: ControlNet / animate
    control_image: str | None = None
    control_type: str | None = None
    control_strength: float | None = None

    # A/B variation tracking
    variation_index: int | None = None      # 1-based index within an A/B test
    ab_params: dict[str, list[Any]] | None = None           # the full ab-params JSON (for reference)

    # Draft mode (quick preview: fewer steps, smaller resolution)
    draft: bool = False

    # Seed variance enhancer (perturb text embeddings in early denoising steps)
    seed_variance: bool = False
    seed_variance_percent: float = 50.0
    seed_variance_strength: float = 20.0
    seed_variance_switchover: float = 20.0

    # Workflow stage settings (multi-stage pipeline: generate → face detail → postprocess → upscale)
    face_detail: bool = False
    face_detail_denoise: float = 0.15
    face_detail_steps: int = 9
    face_detail_lora: str | None = None
    film_grain: float = 0.0
    sharpening: float = 0.0
    lut_path: str | None = None
    lut_strength: float = 0.3
    skin_contrast: bool = False
    noise_clean: bool = False

    # Structured LoRA usage: [{path, scale, stage}], stage ∈
    # main / face_detail / anime2real / faceswap / fusion. lora_path/lora_scale
    # (the "main" LoRA) stay authoritative for replay + backward-compat readers.
    loras: list[LoraEntry] | None = None

    # ------------------------------------------------------------------
    # Factories
    # ------------------------------------------------------------------

    @classmethod
    def from_args(cls, args: "argparse.Namespace", command: str = "generate") -> "RunConfig":
        """Build a RunConfig from a parsed argparse Namespace, filling defaults.

        The concrete defaults in the getattr calls below are a SECOND source of
        truth and can drift from the argparse registrations in app/cli.py — they
        MUST mirror those defaults. They are fallbacks for sub-Namespace shapes
        where a flag is genuinely absent (not a sentinel None), so an explicit
        ``--seed 0`` reaches here as 0 and is kept correctly. Never replace the
        getattr default with ``... or <default>`` (that would turn ``--seed 0``
        into the default and silently override an explicit value).
        """
        from app.commands._shared import resolve_lora_path, resolve_vae_path
        rc = cls(
            schema_version=SCHEMA_VERSION,
            command=command,
            pipeline=getattr(args, "pipeline", "zimage"),
            transformer=getattr(args, "transformer", None),
            prompt=getattr(args, "prompt", None),
            prompt_file=getattr(args, "prompt_file", None),
            width=getattr(args, "width", 640),
            height=getattr(args, "height", 960),
            steps=getattr(args, "steps", 9),
            seed=getattr(args, "seed", 777),
            lora_path=None,        # set by multi-LoRA normalize below (legacy scalar = first)
            lora_scale=1.0,        # set by multi-LoRA normalize below
            vae_path=resolve_vae_path(getattr(args, "vae_path", None)),
            input_image=getattr(args, "input_image", None) or getattr(args, "input", None),
            latent_upscale=getattr(args, "latent_upscale", 1.0),
            denoise_strength=(
                args.denoise_strength if getattr(args, "denoise_strength", None) is not None
                else 1.0
            ),
            upscale=getattr(args, "upscale", False),
            upscale_model=getattr(args, "upscale_model", None),
            upscale_method=getattr(args, "upscale_method", "esrgan"),
            count=getattr(args, "count", 1),
            seed_start=getattr(args, "seed_start", None),
            frames=getattr(args, "frames", None),
            fps=getattr(args, "fps", None),
            video_model=getattr(args, "video_model", None),
            cfg_scale=getattr(args, "cfg_scale", 5.0),
            stg_scale=getattr(args, "stg_scale", 1.0),
            low_ram=getattr(args, "low_ram", False),
            audio=getattr(args, "audio", None),
            stage1_steps=getattr(args, "stage1_steps", None),
            stage2_steps=getattr(args, "stage2_steps", None),
            hq=getattr(args, "hq", False),
            teacache=getattr(args, "teacache", False),
            teacache_thresh=getattr(args, "teacache_thresh", None),
            enhance_prompt=getattr(args, "enhance_prompt", False),
            begin_image=getattr(args, "begin_image", None),
            end_image=getattr(args, "end_image", None),
            begin_strength=getattr(args, "begin_strength", 1.0),
            end_strength=getattr(args, "end_strength", 1.0),
            distilled=getattr(args, "distilled", False),
            temporal_upscale=getattr(args, "temporal_upscale", False),
            control_image=getattr(args, "control_image", None),
            control_type=getattr(args, "control_type", None),
            control_strength=getattr(args, "control_strength", None),
            variation_index=getattr(args, "variation_index", None),
            ab_params=_resolve_ab_params(args),
            draft=getattr(args, "draft", False),
            seed_variance=getattr(args, "seed_variance", False),
            seed_variance_percent=getattr(args, "seed_variance_percent", 50.0),
            seed_variance_strength=getattr(args, "seed_variance_strength", 20.0),
            seed_variance_switchover=getattr(args, "seed_variance_switchover", 20.0),
            face_detail=getattr(args, "face_detail", False),
            face_detail_denoise=getattr(args, "face_detail_denoise", 0.15),
            face_detail_steps=getattr(args, "face_detail_steps", 9),
            face_detail_lora=getattr(args, "face_detail_lora", None),
            film_grain=getattr(args, "film_grain", 0.0),
            sharpening=getattr(args, "sharpening", 0.0),
            lut_path=getattr(args, "lut", None),
            lut_strength=getattr(args, "lut_strength", 0.3),
            skin_contrast=getattr(args, "skin_contrast", False),
            noise_clean=getattr(args, "noise_clean", False),
        )
        # Per-transformer built-in defaults (app/transformer_defaults.py). Applied
        # ONLY when the user did NOT pass the flag — detected via the argparse
        # default=None sentinel (getattr(args,key) is None ⇒ not passed), so an
        # explicit CLI flag always wins. Never a magic-number compare vs the global
        # default (see memory argparse-sentinel-for-user-override).
        #
        # Invariant: every key in TRANSFORMER_DEFAULTS MUST be a field whose
        # argparse registration uses default=None (the sentinel). Registering a
        # default for a field whose argparse default is a concrete value (so
        # getattr(args,key) is never None) would silently let the transformer
        # default clobber values — and conversely a field resolved to a concrete
        # value during RC construction above could be overwritten here. The guard
        # checks the args sentinel, so keep transformer_defaults keys confined to
        # sentinel-defaulted fields (today: cfg_scale for the t2i path).
        if rc.transformer:
            from app.transformer_defaults import get_transformer_defaults
            for _key, _val in get_transformer_defaults(rc.transformer).items():
                if getattr(args, _key, None) is None:
                    setattr(rc, _key, _val)

        # Inline prompt-file content so run.json is self-contained
        if rc.prompt_file and not rc.prompt:
            try:
                with open(rc.prompt_file, "r") as f:
                    rc.prompt = f.read().strip()
            except (FileNotFoundError, PermissionError, OSError) as e:
                raise ValueError(
                    f"Cannot read prompt file {rc.prompt_file}: {e}"
                ) from e

        # Multi-LoRA: --lora-path / --lora-scale are now lists (action="append").
        # Resolve each, pad scales to match paths (default 1.0), and keep legacy
        # lora_path/lora_scale = first entry for manifest/replay back-compat.
        from app.commands._shared import resolve_lora_paths
        rc.lora_paths = resolve_lora_paths(getattr(args, "lora_path", None) or []) or None
        if rc.lora_paths:
            _raw_scales = list(getattr(args, "lora_scale", None) or [])
            while len(_raw_scales) < len(rc.lora_paths):
                _raw_scales.append(_lora_manifest_recommended_scale(rc.lora_paths[len(_raw_scales)]))
            # Coerce defensively so a programmatic caller (tests, replay Namespace
            # rebuild) injecting a non-float into args.lora_scale can't reach
            # apply_lora — fall back to 1.0 per entry on any coercion failure.
            _coerced: list[float] = []
            for _s in _raw_scales[:len(rc.lora_paths)]:
                try:
                    _coerced.append(float(_s))
                except (TypeError, ValueError):
                    _coerced.append(1.0)
            rc.lora_scales = _coerced
            rc.lora_path = rc.lora_paths[0]
            rc.lora_scale = rc.lora_scales[0]
        else:
            rc.lora_scales = None

        # Structured LoRA list: main LoRA(s) + face-detail LoRA (anime2real /
        # faceswap / fusion are appended by their own command paths). lora_path /
        # lora_scale remain the source of truth for the "main" LoRA + replay.
        _lora_entries: list[LoraEntry] = []
        if rc.lora_paths:
            # Narrow explicitly rather than `rc.lora_scales or []`: the `or []`
            # would silently substitute an empty list when lora_scales is None
            # (its typed value when no scales were resolved), truncating zip to
            # zero pairs and dropping every main-LoRA entry. Pad to match paths
            # so a programmatic caller that leaves lora_scales None still gets
            # one entry per path (default scale 1.0 via the manifest helper).
            _scales = rc.lora_scales
            if _scales is None:
                _scales = [
                    _lora_manifest_recommended_scale(_p) for _p in rc.lora_paths
                ]
            for _p, _s in zip(rc.lora_paths, _scales):
                _lora_entries.append({"path": _p, "scale": _s, "stage": "main"})
        elif rc.lora_path:
            _lora_entries.append({"path": rc.lora_path, "scale": rc.lora_scale, "stage": "main"})
        if rc.face_detail_lora:
            _lora_entries.append({"path": rc.face_detail_lora, "scale": None, "stage": "face_detail"})
        rc.loras = _lora_entries or None
        return rc

    @classmethod
    def from_json(cls, path: str) -> "RunConfig":
        """Load a .run.json file, migrating from older schema versions if needed."""
        with open(path, "r") as f:
            raw = json.load(f)

        version = raw.get("schema_version", 0)
        if version > SCHEMA_VERSION:
            raise ValueError(
                f"Run config schema_version {version} is newer than supported "
                f"{SCHEMA_VERSION}. Update mlx-movie-director to replay this run."
            )

        raw = _migrate(raw)
        known = set(cls.__dataclass_fields__)
        rc = cls(**{k: v for k, v in raw.items() if k in known})
        # Coerce scalar numeric fields against their annotations. A run.json may
        # be hand-edited, written by an older binary, or produced by the
        # variation driver which setattr's ab-params values; without this pass a
        # "steps": "9" or "cfg_scale": null would flow untyped into MLX pipeline
        # calls expecting int/float and surface as a confusing downstream error.
        _coerce_typed_fields(rc)
        return rc

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_json(self, path: str) -> None:
        """Write run config to JSON atomically (write .tmp → rename)."""
        data = asdict(self)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, path)


class _RunConfigTypeHintsCache:
    """Mutable singleton holding the resolved typing.get_type_hints cache.

    A class (not a module global) so the cache attribute lives next to its use
    site and is trivially reset-friendly in tests by setting ``_cache = None``.
    """

    _cache: "dict[str, Any] | None" = None


cls_run_config_type_hints_cache = _RunConfigTypeHintsCache()


def _coerce_typed_fields(rc: "RunConfig") -> None:
    """Coerce the scalar numeric RunConfig fields to their declared types in-place.

    Drives off the dataclass annotations: for each field whose annotation is (or
    contains) ``int`` or ``float``, coerce the loaded JSON value into the declared
    type. ``None`` is preserved on Optional fields (``int | None`` / ``float | None``)
    but rejected on non-Optional scalar fields with a clear ValueError naming the
    field, so a malformed run.json fails loudly at load time rather than deep
    inside a pipeline call. Non-scalar fields (str, bool, lists, dicts) are left
    untouched — JSON already yields the right native Python type for those and
    bool must not be int-coerced.
    """
    import dataclasses
    import typing
    # Resolve annotations once via typing.get_type_hints (against module globals)
    # rather than tokenizing the string form. This handles 'int | None',
    # 'builtins.int', extra whitespace, and forward references uniformly — the
    # manual tokenizer below only recognized the bare tokens 'int'/'float'/
    # 'None'/'NoneType' and would silently bypass coercion for any other form
    # (e.g. a field annotated 'builtins.int | None'). Cached on the class to
    # avoid repeat resolution cost across loads.
    _hints = getattr(cls_run_config_type_hints_cache, "_cache", None)
    if _hints is None:
        _hints = typing.get_type_hints(type(rc))
        cls_run_config_type_hints_cache._cache = _hints
    for _f in dataclasses.fields(rc):
        _ann = _hints.get(_f.name, _f.type)
        # Normalize to a set of leaf types (handles "int | None" whether the
        # annotation is a resolved types.UnionType / typing.Union, or — as a
        # fallback for unresolved string annotations — the raw string).
        if isinstance(_ann, str):
            _ann_clean = _ann.strip()
            _leaves: set = set()
            for _tok in _ann_clean.replace("|", " ").split():
                _tok = _tok.strip()
                if _tok == "None" or _tok == "NoneType":
                    _leaves.add(type(None))
                elif _tok == "int":
                    _leaves.add(int)
                elif _tok == "float":
                    _leaves.add(float)
            # typing.get_type_hints above should resolve all real annotations;
            # an empty _leaves here means the string fallback could not tokenize
            # the form (e.g. 'Optional[int]', 'builtins.int'), so coercion is
            # silently skipped. Surface it as a warning so the gap is observable
            # rather than a silent type-safety hole.
            if not _leaves:
                import sys
                print(
                    f"[run_config] warning: RunConfig field '{_f.name}' has an "
                    f"unresolved string annotation {_ann!r}; numeric coercion skipped.",
                    file=sys.stderr,
                )
            _is_optional = type(None) in _leaves
        else:
            _args = typing.get_args(_ann)
            _leaves = set(_args) if _args else {_ann}
            _is_optional = type(None) in _leaves
        # Pick the numeric target: prefer float if both int+float are declared
        # (a float field may be written as an int in JSON); skip non-numeric.
        if int in _leaves and float not in _leaves:
            _target = int
        elif float in _leaves:
            _target = float
        else:
            continue
        # Never int-coerce a field that also allows bool (bool is a subclass of
        # int in Python); RunConfig bool fields are skipped via the `continue`.
        _val = getattr(rc, _f.name)
        if _val is None:
            if not _is_optional:
                raise ValueError(
                    f"RunConfig field '{_f.name}' is non-Optional but the "
                    f"run.json carried null."
                )
            continue
        try:
            setattr(rc, _f.name, _target(_val))
        except (TypeError, ValueError) as _e:
            raise ValueError(
                f"RunConfig field '{_f.name}' could not be coerced to "
                f"{_target.__name__} from {type(_val).__name__} ({_val!r}): {_e}"
            ) from _e


def _migrate(raw: dict[str, Any]) -> dict[str, Any]:
    """Migrate a raw run config dict through version chain to SCHEMA_VERSION."""
    version = raw.get("schema_version", 0)

    if version < 1:
        raise ValueError(
            f"Run config has unsupported schema_version {version}. "
            f"Minimum supported version is 1."
        )

    if version == 1:
        # v1 → v2: add img2img, upscale, batch fields
        raw.setdefault("input_image", None)
        raw.setdefault("latent_upscale", 1.0)
        raw.setdefault("denoise_strength", 1.0)
        raw.setdefault("upscale", False)
        raw.setdefault("upscale_model", None)
        raw.setdefault("count", 1)
        raw.setdefault("seed_start", None)
        raw["schema_version"] = 2
        version = 2

    if version == 2:
        # v2 → v3: rename action → command; add future fields
        old_action = raw.pop("action", "text2img")
        raw["command"] = _ACTION_TO_COMMAND.get(old_action, old_action)
        raw.setdefault("frames", None)
        raw.setdefault("fps", None)
        raw.setdefault("video_model", None)
        raw.setdefault("control_image", None)
        raw.setdefault("control_type", None)
        raw.setdefault("control_strength", None)
        raw["schema_version"] = 3
        version = 3

    if version == 3:
        # v3 → v4: add LTX video generation params
        raw.setdefault("cfg_scale", 3.0)
        raw.setdefault("stg_scale", 1.0)
        raw.setdefault("low_ram", False)
        raw.setdefault("audio", None)
        raw.setdefault("stage1_steps", None)
        raw.setdefault("stage2_steps", None)
        raw["schema_version"] = 4
        version = 4

    if version == 4:
        # v4 → v5: add pipeline selection field
        raw.setdefault("pipeline", "zimage")
        raw["schema_version"] = 5
        version = 5

    if version == 5:
        # v5 → v6: add A/B variation tracking fields
        raw.setdefault("variation_index", None)
        raw.setdefault("ab_params", None)
        raw["schema_version"] = 6
        version = 6

    if version == 6:
        # v6 → v7: add HQ pipeline, TeaCache, prompt enhancement fields
        raw.setdefault("hq", False)
        raw.setdefault("teacache", False)
        raw.setdefault("teacache_thresh", None)
        raw.setdefault("enhance_prompt", False)
        raw["schema_version"] = 7
        version = 7

    if version == 7:
        # v7 → v8: add FLF2V (First-Last Frame to Video) fields
        raw.setdefault("begin_image", None)
        raw.setdefault("end_image", None)
        raw.setdefault("begin_strength", 1.0)
        raw.setdefault("end_strength", 1.0)
        raw["schema_version"] = 8
        version = 8

    if version == 8:
        # v8 → v9: add distilled mode flag
        raw.setdefault("distilled", False)
        raw["schema_version"] = 9
        version = 9

    if version == 9:
        # v9 → v10: add temporal upscaling flag
        raw.setdefault("temporal_upscale", False)
        raw["schema_version"] = 10
        version = 10

    if version == 10:
        # v10 → v11: add draft mode, vae_path, seed variance fields
        raw.setdefault("draft", False)
        raw.setdefault("vae_path", None)
        raw.setdefault("seed_variance", False)
        raw.setdefault("seed_variance_percent", 50.0)
        raw.setdefault("seed_variance_strength", 20.0)
        raw.setdefault("seed_variance_switchover", 20.0)
        raw["schema_version"] = 11
        version = 11

    if version == 11:
        # v11 → v12: add workflow stage settings (face detail, post-processing)
        raw.setdefault("face_detail", False)
        raw.setdefault("face_detail_denoise", 0.15)
        raw.setdefault("face_detail_steps", 9)
        raw.setdefault("face_detail_lora", None)
        raw.setdefault("film_grain", 0.0)
        raw.setdefault("sharpening", 0.0)
        raw.setdefault("lut_path", None)
        raw.setdefault("lut_strength", 0.3)
        raw.setdefault("skin_contrast", False)
        raw.setdefault("noise_clean", False)
        raw["schema_version"] = 12
        version = 12

    if version == 12:
        # v12 → v13: structured LoRA list. (The argv snapshot that used to live
        # here was removed — replay rebuilds from structured fields, not argv,
        # and from_json filters unknown keys so old files carrying argv load fine.)
        raw.setdefault("loras", None)
        raw["schema_version"] = 13
        version = 13

    if version == 13:
        # v13 → v14: multi-LoRA — lora_paths/lora_scales lists (main stage).
        # Old runs have scalar lora_path/lora_scale only; lists stay None and
        # execute_generation falls back to [lora_path].
        raw.setdefault("lora_paths", None)
        raw.setdefault("lora_scales", None)
        raw["schema_version"] = 14
        version = 14

    return raw
