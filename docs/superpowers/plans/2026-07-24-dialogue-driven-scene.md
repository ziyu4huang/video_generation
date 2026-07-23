# Dialogue-Driven Two-Character Scene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local MLX-native TTS engine to `run.py tts`, then produce a
6-shot, shot/reverse-shot dialogue scene (two characters, one short
pause-free sentence each) proving out a "drama, not narration" production
path within LipDub's validated precision ceiling.

**Architecture:** `app/commands/tts.py` gains `--engine mlx` (Kokoro via
`mlx-audio`) alongside the existing `--engine edge-tts` default. Each of the
6 dialogue lines becomes an independent shot: TTS → `native-i2v` (Swift/MLX)
→ `video lipdub` (Python IC-LoRA) → `lipsync_metrics.py` verification gate,
retried once on failure. The 6 shots are joined with `ffmpeg -filter_complex
concat` (not the concat demuxer — see design doc's Background section for
why) into the final scene.

**Tech Stack:** mlx-audio (Kokoro-82M), native-i2v (Swift/MLX LTX-2.3
distilled), `run.py video lipdub`, `app/lipsync_metrics.py`, ffmpeg.

**Design doc:** `docs/superpowers/specs/2026-07-24-dialogue-driven-scene-design.md`

---

## Task 1: `--engine mlx` for `run.py tts`

**Files:**
- Modify: `python/mlx-movie-director/app/commands/tts.py` (full rewrite, ~150 lines)
- Test: `python/mlx-movie-director/app/tests/test_tts.py` (new file)

- [ ] **Step 1: Write the failing tests**

Create `python/mlx-movie-director/app/tests/test_tts.py`:

```python
"""Unit tests for app/commands/tts.py — edge-tts (cloud) + mlx (local Kokoro
via mlx-audio) narration/dialogue synthesis.

The mlx path is exercised via monkeypatching `tts._synthesize_mlx` — no real
Kokoro model load happens in this suite, keeping it fast and offline.
"""

import argparse
import json
import os

import pytest

from app.commands import tts
from app.commands.tts import (
    PARSER_META,
    _DEFAULT_EDGE_VOICE,
    _DEFAULT_MLX_MODEL,
    _DEFAULT_MLX_VOICE,
    _parse_rate_to_speed,
    _validate_mlx_voice,
    add_args,
    run,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    add_args(parser)
    return parser


class TestParserMeta:
    def test_meta_has_required_keys(self):
        assert "help" in PARSER_META
        assert "description" in PARSER_META


class TestAddArgsDefaults:
    def test_engine_defaults_to_edge_tts(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.engine == "edge-tts"

    def test_engine_choices_include_mlx(self):
        ns, _ = _build_parser().parse_known_args(["--engine", "mlx"])
        assert ns.engine == "mlx"

    def test_engine_rejects_unknown_value(self):
        with pytest.raises(SystemExit):
            _build_parser().parse_known_args(["--engine", "bogus"])

    def test_voice_defaults_to_none(self):
        # Resolved per-engine in run(), not at argparse time.
        ns, _ = _build_parser().parse_known_args([])
        assert ns.voice is None

    def test_mlx_model_default(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.mlx_model == _DEFAULT_MLX_MODEL

    def test_rate_default_unchanged(self):
        ns, _ = _build_parser().parse_known_args([])
        assert ns.rate == "+0%"


class TestParseRateToSpeed:
    def test_zero_percent_is_speed_one(self):
        assert _parse_rate_to_speed("+0%") == 1.0

    def test_positive_percent(self):
        assert _parse_rate_to_speed("+15%") == pytest.approx(1.15)

    def test_negative_percent(self):
        assert _parse_rate_to_speed("-10%") == pytest.approx(0.90)

    def test_missing_percent_sign_raises(self):
        with pytest.raises(ValueError):
            _parse_rate_to_speed("10")


class TestValidateMlxVoice:
    def test_valid_prefixes_pass(self):
        _validate_mlx_voice("am_michael")
        _validate_mlx_voice("af_heart")
        _validate_mlx_voice("bm_daniel")

    def test_edge_tts_style_voice_exits(self):
        with pytest.raises(SystemExit):
            _validate_mlx_voice("en-US-AriaNeural")


class TestRunDispatchMlx:
    def test_mlx_engine_calls_synthesize_mlx_with_defaults(self, tmp_path, monkeypatch):
        calls = []

        def fake_synth(text, voice, model, speed, out_path):
            calls.append((text, voice, model, speed, out_path))
            with open(out_path, "wb") as f:
                f.write(b"fake-wav-bytes")

        monkeypatch.setattr(tts, "_synthesize_mlx", fake_synth)

        out_path = str(tmp_path / "line1.wav")
        args = argparse.Namespace(
            text="You're late.", text_flag=None, text_file=None,
            engine="mlx", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        run(args)

        assert len(calls) == 1
        text, voice, model, speed, path = calls[0]
        assert text == "You're late."
        assert voice == _DEFAULT_MLX_VOICE
        assert model == _DEFAULT_MLX_MODEL
        assert speed == 1.0
        assert path == out_path
        assert os.path.exists(out_path)

    def test_mlx_engine_honors_explicit_voice_and_rate(self, tmp_path, monkeypatch):
        calls = []

        def fake_synth(text, voice, model, speed, out_path):
            calls.append((text, voice, model, speed, out_path))
            with open(out_path, "wb") as f:
                f.write(b"fake-wav-bytes")

        monkeypatch.setattr(tts, "_synthesize_mlx", fake_synth)

        out_path = str(tmp_path / "line2.wav")
        args = argparse.Namespace(
            text="I had to lose someone.", text_flag=None, text_file=None,
            engine="mlx", voice="am_adam", mlx_model=_DEFAULT_MLX_MODEL,
            rate="+15%", output=out_path,
        )
        run(args)

        _, voice, _, speed, _ = calls[0]
        assert voice == "am_adam"
        assert speed == pytest.approx(1.15)

    def test_mlx_engine_rejects_edge_tts_voice(self, tmp_path, monkeypatch):
        monkeypatch.setattr(tts, "_synthesize_mlx", lambda *a, **k: None)
        out_path = str(tmp_path / "line.wav")
        args = argparse.Namespace(
            text="Hi", text_flag=None, text_file=None,
            engine="mlx", voice="en-US-AriaNeural", mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        with pytest.raises(SystemExit):
            run(args)


class TestRunDispatchEdgeTts:
    def test_edge_tts_engine_still_used_by_default(self, tmp_path, monkeypatch):
        import asyncio

        saved = {}

        class FakeCommunicate:
            def __init__(self, text, voice, rate):
                saved["text"] = text
                saved["voice"] = voice
                saved["rate"] = rate

            async def save(self, out_path):
                with open(out_path, "wb") as f:
                    f.write(b"fake-mp3-bytes")

        fake_edge_tts = type("FakeModule", (), {"Communicate": FakeCommunicate})
        monkeypatch.setitem(__import__("sys").modules, "edge_tts", fake_edge_tts)

        out_path = str(tmp_path / "narration.mp3")
        args = argparse.Namespace(
            text="Hello world", text_flag=None, text_file=None,
            engine="edge-tts", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        run(args)

        assert saved["voice"] == _DEFAULT_EDGE_VOICE
        assert os.path.exists(out_path)


class TestManifestEngineField:
    def test_explicit_output_skips_manifest_and_just_writes_audio(self, tmp_path, monkeypatch):
        # --output given explicitly => run() takes the `paths is None` branch
        # and never writes a run.json/manifest (that's the pre-existing
        # edge-tts behavior too — this just confirms the mlx branch didn't
        # change it). The manifest-writing branch (`paths is not None`, the
        # auto-generated-output path) is exercised for real by Task 1 Step 5's
        # manual smoke test, which prints the run.json path.
        def fake_synth(text, voice, model, speed, out_path):
            with open(out_path, "wb") as f:
                f.write(b"fake-wav-bytes")

        monkeypatch.setattr(tts, "_synthesize_mlx", fake_synth)

        out_path = str(tmp_path / "line.wav")
        args = argparse.Namespace(
            text="Hi", text_flag=None, text_file=None,
            engine="mlx", voice=None, mlx_model=_DEFAULT_MLX_MODEL,
            rate="+0%", output=out_path,
        )
        run(args)

        assert os.path.exists(out_path)
        assert not os.path.exists(str(tmp_path / "line.run.json"))
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
( cd /Users/huangziyu/proj/video_generation__director && \
  /Users/huangziyu/proj/video_generation__venv/bin/python -m pytest \
  python/mlx-movie-director/app/tests/test_tts.py -v )
```

Expected: collection error / `ImportError: cannot import name '_parse_rate_to_speed'`
(none of the new names exist in `tts.py` yet).

- [ ] **Step 3: Rewrite `app/commands/tts.py`**

Replace the entire file with:

```python
"""tts — standalone narration/dialogue synthesis via edge-tts or local MLX Kokoro.

Isolates the edge-tts call already used inside `video relay` (--relay-tts-engine
edge-tts, see video-relay.py) into its own top-level command so movie-director
(bun-apps/pi-agent-ext-movie-director) can invoke natural-sounding narration
without going through the full relay pipeline. macOS `say` remains the
zero-network fallback (see app.commands._shared / video-relay.py's `--relay-tts-
engine say` path) — this command is the natural-voice alternative when network
egress is acceptable.

`--engine mlx` runs Kokoro-82M fully locally via the `mlx-audio` package — no
per-call network egress (only a one-time model/voice download on first use,
same as any other MLX model in this repo). Needs `mlx-audio`, `misaki`,
`num2words`, `spacy` (+ its `en_core_web_sm` model, auto-downloaded once) and
`phonemizer` + the system `espeak-ng` binary — see requirements.txt.
"""

import argparse
import asyncio
import os
import sys

from app.commands._shared import make_output_paths, run_session
from app.io_utils import require_file

PARSER_META = {
    "help": "Narration/dialogue synthesis via edge-tts (cloud) or local MLX Kokoro",
    "description": (
        "Synthesize speech from text using edge-tts (Microsoft neural TTS, cloud) "
        "or mlx-audio's Kokoro model (local, Apple Silicon, --engine mlx).\n\n"
        "edge-tts needs network egress per call — unlike macOS `say` or --engine mlx, "
        "it is NOT available under --offline. --engine mlx needs network only once "
        "to download the model/voice, then runs fully local.\n\n"
        "Examples:\n"
        "  run.py tts --text \"Hello world\" --output narration.mp3\n"
        "  run.py tts --text-file script.txt --voice en-US-GuyNeural\n"
        "  run.py tts --text \"...\" --voice zh-TW-HsiaoChenNeural --rate -10%\n"
        "  run.py tts --text \"You're late.\" --engine mlx --voice am_michael --output line1.wav\n"
    ),
}

# A few common voices, not exhaustive — edge-tts supports many more
# (see `edge-tts --list-voices`). Kept as documentation, not an enum: an
# unlisted voice id still works, argparse does not restrict --voice.
_EXAMPLE_VOICES = [
    "en-US-AriaNeural", "en-US-GuyNeural",
    "zh-TW-HsiaoChenNeural", "zh-TW-YunJheNeural", "zh-TW-HsiaoYuNeural",
]

# mlx-audio/Kokoro voice ids are "<lang><gender>_<name>" (af_heart, am_adam,
# bf_emma, ...) — used to catch an edge-tts voice id being passed to --engine
# mlx by mistake, with a clear error instead of a confusing mlx-audio failure.
_MLX_VOICE_PREFIXES = (
    "af_", "am_", "bf_", "bm_", "ef_", "em_", "ff_", "hf_", "hm_",
    "if_", "im_", "jf_", "jm_", "pf_", "pm_", "zf_", "zm_",
)
_DEFAULT_MLX_MODEL = "mlx-community/Kokoro-82M-bf16"
_DEFAULT_MLX_VOICE = "af_heart"
_DEFAULT_EDGE_VOICE = "en-US-AriaNeural"


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("text", nargs="?", default=None, metavar="TEXT",
                        help="Narration text (positional shorthand for --text)")
    parser.add_argument("--text", dest="text_flag", type=str, default=None, metavar="TEXT",
                        help="Narration text (flag form)")
    parser.add_argument("--text-file", type=str, default=None, metavar="PATH",
                        help="Read narration text from a file instead of --text")
    parser.add_argument("--engine", type=str, default="edge-tts",
                        choices=["edge-tts", "mlx"],
                        help="TTS engine: edge-tts (cloud, default) or mlx "
                        "(local Kokoro via mlx-audio, no per-call network egress)")
    parser.add_argument("--voice", type=str, default=None, metavar="VOICE",
                        help="Voice id. For --engine edge-tts: an edge-tts voice "
                        f"(default {_DEFAULT_EDGE_VOICE}; examples {', '.join(_EXAMPLE_VOICES)}). "
                        f"For --engine mlx: an mlx-audio/Kokoro voice (default "
                        f"{_DEFAULT_MLX_VOICE}; examples am_michael, am_adam, af_sarah).")
    parser.add_argument("--mlx-model", type=str, default=_DEFAULT_MLX_MODEL,
                        help=f"mlx-audio TTS model repo id, --engine mlx only "
                        f"(default: {_DEFAULT_MLX_MODEL})")
    parser.add_argument("--rate", type=str, default="+0%", metavar="RATE",
                        help="Speech rate as a signed percentage, e.g. -10%%, +15%% (default: +0%%). "
                        "For --engine mlx this is converted to a Kokoro speed multiplier.")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output audio path (default: <gen-output-dir>/output_<ts>.mp3)")


def _parse_rate_to_speed(rate: str) -> float:
    """Convert edge-tts's signed-percentage rate (e.g. '+15%', '-10%') to a
    Kokoro speed multiplier (e.g. 1.15, 0.90)."""
    rate = rate.strip()
    if not rate.endswith("%"):
        raise ValueError(f"--rate must be a signed percentage like '+10%' or '-5%', got: {rate!r}")
    pct = float(rate[:-1])
    return 1.0 + pct / 100.0


def _validate_mlx_voice(voice: str) -> None:
    if not voice.startswith(_MLX_VOICE_PREFIXES):
        print(f"ERROR: '{voice}' doesn't look like an mlx-audio/Kokoro voice id "
              f"(expected a prefix like {_MLX_VOICE_PREFIXES[0]!r} or {_MLX_VOICE_PREFIXES[1]!r}). "
              "Examples: am_michael, am_adam, af_heart, af_sarah.", file=sys.stderr)
        sys.exit(1)


def _synthesize_mlx(text: str, voice: str, model: str, speed: float, out_path: str) -> None:
    """Generate speech locally via mlx-audio's Kokoro pipeline. Imported lazily
    so the default --engine edge-tts path never requires mlx-audio / misaki /
    spacy / phonemizer to be installed.
    """
    from mlx_audio.tts.generate import generate_audio

    out_dir = os.path.dirname(out_path) or "."
    os.makedirs(out_dir, exist_ok=True)
    base, ext = os.path.splitext(os.path.basename(out_path))
    audio_format = ext.lstrip(".") or "wav"

    generate_audio(
        text=text,
        model=model,
        voice=voice,
        speed=speed,
        output_path=out_dir,
        file_prefix=base,
        audio_format=audio_format,
        join_audio=True,
        verbose=False,
    )


def run(args: argparse.Namespace) -> None:
    text = args.text or getattr(args, "text_flag", None)
    if args.text_file:
        if text:
            print("WARNING: both TEXT and --text-file given — using --text-file", file=sys.stderr)
        text_file = require_file(args.text_file, "--text-file")
        with open(text_file, encoding="utf-8") as f:
            text = f.read().strip()
    if not text:
        print("ERROR: narration text is required (positional TEXT, --text, or --text-file)",
              file=sys.stderr)
        sys.exit(1)

    engine = args.engine
    rate = args.rate

    if args.output:
        out_path = args.output
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        paths = None
    else:
        paths = make_output_paths(ext=".mp3")
        out_path = paths.output_file

    import time
    t0 = time.perf_counter()

    if engine == "mlx":
        voice = args.voice or _DEFAULT_MLX_VOICE
        _validate_mlx_voice(voice)
        speed = _parse_rate_to_speed(rate)
        print(f"[tts] mlx (Kokoro) synthesizing ({len(text)} chars, voice={voice}, "
              f"model={args.mlx_model}, speed={speed})...", flush=True)
        try:
            _synthesize_mlx(text, voice, args.mlx_model, speed, out_path)
        except Exception as e:
            print(f"ERROR: mlx TTS synthesis failed: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        voice = args.voice or _DEFAULT_EDGE_VOICE
        try:
            import edge_tts
        except ImportError:
            print("ERROR: edge-tts not installed. Run: uv pip install edge-tts "
                  "--python python/venv/bin/python", file=sys.stderr)
            sys.exit(1)

        print(f"[tts] edge-tts synthesizing ({len(text)} chars, voice={voice}, rate={rate})...",
              flush=True)

        async def _synthesize() -> None:
            communicate = edge_tts.Communicate(text, voice, rate=rate)
            await communicate.save(out_path)

        try:
            asyncio.run(_synthesize())
        except Exception as e:
            print(f"ERROR: edge-tts synthesis failed: {e}", file=sys.stderr)
            sys.exit(1)

    elapsed = time.perf_counter() - t0

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        print(f"ERROR: {engine} TTS produced no audio at {out_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[tts] ✓ saved: {out_path} ({elapsed:.2f}s)")

    if paths is not None:
        # Mirror run_session's manifest shape (status/output_files/models) so the
        # bun bridge (runpy_tts.ts) parses this the same way it parses image/video
        # manifests — no run_config (this command has no seed/model-fingerprint
        # concept worth replaying), so run_session's own run.json write is skipped
        # and a minimal one is written here instead.
        import json
        with open(paths.run_file, "w") as f:
            json.dump({"command": "tts", "engine": engine, "voice": voice, "rate": rate,
                       "text_length": len(text)}, f, indent=2)
        with run_session(paths, run_config=None) as ctx:
            ctx["outputs"] = [{
                "path": out_path,
                "size_bytes": os.path.getsize(out_path),
                "voice": voice,
            }]
            ctx["timings"] = {"total": round(elapsed, 2)}
            ctx["models"] = {"tts_engine": engine, "voice": voice}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
( cd /Users/huangziyu/proj/video_generation__director && \
  /Users/huangziyu/proj/video_generation__venv/bin/python -m pytest \
  python/mlx-movie-director/app/tests/test_tts.py -v )
```

Expected: all tests PASS.

- [ ] **Step 5: Manual smoke test of the real Kokoro path (not mocked)**

```bash
/Users/huangziyu/proj/video_generation__venv/bin/python \
  /Users/huangziyu/proj/video_generation__director/python/mlx-movie-director/run.py \
  tts --text "You're late." --engine mlx --voice am_michael \
  --output /tmp/dialogue-scene-smoke.wav
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /tmp/dialogue-scene-smoke.wav
```

Expected: `[tts] ✓ saved: /tmp/dialogue-scene-smoke.wav (...)`, and `ffprobe`
reports a duration around 1-2s for this short line.

- [ ] **Step 6: Commit**

```bash
git add python/mlx-movie-director/app/commands/tts.py python/mlx-movie-director/app/tests/test_tts.py
git commit -m "feat(mlx-movie-director): add --engine mlx (local Kokoro) to run.py tts"
```

---

## Task 2: Declare the new dependencies

**Files:**
- Modify: `python/mlx-movie-director/requirements.txt`

- [ ] **Step 1: Add the mlx-audio TTS stack**

In `python/mlx-movie-director/requirements.txt`, after the existing `edge-tts`
line, add:

```
edge-tts
mlx-audio      # local TTS (run.py tts --engine mlx, Kokoro-82M) — no
               # per-call network egress. Needs 4 extra deps below, plus the
               # system `espeak-ng` binary (brew install espeak-ng on macOS)
               # and a one-time `en_core_web_sm` spaCy model download
               # (auto-fetched on first --engine mlx call).
misaki         # Kokoro's text-to-phoneme frontend
num2words      # misaki's English G2P needs this for number expansion
spacy          # misaki's English G2P needs this for POS tagging
phonemizer     # misaki's espeak-ng bridge
```

- [ ] **Step 2: Verify the pin doesn't break the existing offline preflight**

```bash
( cd /Users/huangziyu/proj/video_generation__director && \
  /Users/huangziyu/proj/video_generation__venv/bin/python \
  python/mlx-movie-director/run.py check-model --preflight 2>&1 | tail -20 )
```

Expected: same preflight output as before this change (mlx-audio and its
deps are pure-Python/no model-weight preflight entries — this just confirms
adding lines to requirements.txt didn't break the preflight parser).

- [ ] **Step 3: Commit**

```bash
git add python/mlx-movie-director/requirements.txt
git commit -m "chore(mlx-movie-director): declare mlx-audio TTS stack in requirements.txt"
```

---

## Task 3: Generate the two character portraits

**Files:**
- Output (outside repo, gitignored `video_generation__output/`): two PNGs

- [ ] **Step 1: Generate Kai's portrait**

```bash
/Users/huangziyu/proj/video_generation__venv/bin/python \
  /Users/huangziyu/proj/video_generation__director/python/mlx-movie-director/run.py \
  image t2i \
  --prompt "half-body portrait of a young man street courier at night, short messy dark hair, no hood, wearing a dark bomber jacket, standing facing the camera directly, lips slightly parted relaxed neutral expression, even soft frontal lighting on the face, faint neon signs blurred in the background at night, photorealistic" \
  --ratio portrait --seed 501 \
  --json-summary
```

Note the `outputs[0]` path from `JSON_SUMMARY:` — this is Kai's fixed
portrait, reused for all 3 of Kai's lines.

- [ ] **Step 2: Generate Dov's portrait**

```bash
/Users/huangziyu/proj/video_generation__venv/bin/python \
  /Users/huangziyu/proj/video_generation__director/python/mlx-movie-director/run.py \
  image t2i \
  --prompt "half-body portrait of a young man street contact at night, buzzcut hair, hood pulled down around the shoulders not covering the head, wearing a dark hoodie, standing facing the camera directly, lips slightly parted relaxed neutral expression, even soft frontal lighting on the face, faint neon signs blurred in the background at night, photorealistic" \
  --ratio portrait --seed 502 \
  --json-summary
```

- [ ] **Step 3: Visual check — confirm no hood-shadow / closeup artifacts**

Read both output PNGs (via the Read tool) and confirm: face fully visible,
no hood covering the head, mouth region unobstructed and evenly lit, half-body
framing (not an extreme closeup — this session's attempt 3/4 showed extreme
closeups trigger hallucinated-limb artifacts during native-i2v generation).

If either portrait fails this check, regenerate with `--seed 511` /
`--seed 512` and re-check before proceeding — do not proceed to Task 4 with a
flawed source portrait, since every downstream shot for that character
inherits it.

- [ ] **Step 4: Copy both to a stable scratch location**

```bash
DIR=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--director/947cd975-3b8e-4d82-bd76-f9ea6bc1bc77/scratchpad/dialogue-scene
mkdir -p "$DIR"
cp <kai_output_path> "$DIR/kai_source.png"
cp <dov_output_path> "$DIR/dov_source.png"
```

(Substitute the actual paths noted in Steps 1-2.)

---

## Task 4: Produce all 6 dialogue shots

**Files:** all under
`/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--director/947cd975-3b8e-4d82-bd76-f9ea6bc1bc77/scratchpad/dialogue-scene/`

This task repeats the same 4-step recipe for each of the 6 lines below. Do
all 6 before moving to Task 5 — each is independent but they share the
retry/verify discipline, so they're grouped as one task.

| # | Speaker | Voice | Seed | Line |
|---|---------|-------|------|------|
| 1 | Kai | am_michael | 501 | "You're late." |
| 2 | Dov | am_adam | 502 | "I had to lose someone." |
| 3 | Kai | am_michael | 501 | "Did they see your face?" |
| 4 | Dov | am_adam | 502 | "No one saw anything." |
| 5 | Kai | am_michael | 501 | "Then let's make this quick." |
| 6 | Dov | am_adam | 502 | "Here — take it and go." |

- [ ] **Step 1: Per line — synthesize speech, padded to a fixed 3.04s bucket**

```bash
DIR=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--director/947cd975-3b8e-4d82-bd76-f9ea6bc1bc77/scratchpad/dialogue-scene
VENV=/Users/huangziyu/proj/video_generation__venv/bin/python
REPO=/Users/huangziyu/proj/video_generation__director

# Example for line 1 (Kai). Repeat with the matching voice/text/N for lines 2-6.
"$VENV" "$REPO/python/mlx-movie-director/run.py" tts \
  --text "You're late." --engine mlx --voice am_michael \
  --output "$DIR/line1_raw.wav"

# Pad with silence to a fixed 3.04s (73 frames @ 24fps — the 8k+1 grid
# native-i2v snaps to) so every shot uses the same --seconds bucket.
ffmpeg -y -i "$DIR/line1_raw.wav" -af "apad=whole_dur=3.04167" -t 3.04167 "$DIR/line1.wav"
```

Expected: `ffprobe -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$DIR/line1.wav"`
reports `3.041670` (or very close).

- [ ] **Step 2: Per line — generate the base clip via native-i2v**

```bash
BIN=/Users/huangziyu/proj/video_generation__director/swift/ltx-video-director/.build/arm64-apple-macosx/release/ltx-video

# Kai's lines (1, 3, 5) use kai_source.png + seed 501.
# Dov's lines (2, 4, 6) use dov_source.png + seed 502.
"$BIN" native-i2v \
  --prompt "The man stands still facing the camera, lips slightly parted and relaxed as if talking, natural mouth movement with visible jaw motion, soft occasional blinking, camera static, gentle neon glow in the background at night." \
  --input-image "$DIR/kai_source.png" \
  --audio-track "$DIR/line1.wav" \
  --seconds 3 --seed 501 --no-upscale --no-refine \
  -o "$DIR/line1-base"
```

Expected: `$DIR/line1-base/video.mp4` exists, 73 frames, ~3.04s (matches
the padded audio track's `--audio-track` pinning).

- [ ] **Step 3: Per line — run LipDub, then verify**

```bash
"$VENV" "$REPO/python/mlx-movie-director/run.py" video lipdub \
  --lipdub-reference-video "$DIR/line1-base/video.mp4" \
  --prompt "a young man talking directly to the camera at night, natural mouth and lip motion matching his speech, neon-lit background" \
  --width 384 --height 576

# Note the "[lipdub] Saved: ..." path, then verify:
( cd "$REPO/python/mlx-movie-director" && "$VENV" -m app.lipsync_metrics <lipdub_output.mp4> )
```

Expected: `"verdict": "adequate"` (pearson_r >= 0.3). This is the regime
(short, single, pause-free line) this session's only successful LipDub
result came from — these lines are even shorter, so this should be at least
as reliable.

- [ ] **Step 4: If verdict is "inadequate" — one retry, then accept best-effort**

Retry once with the half-body-framing recipe already used for the source
portrait (should already apply here since Task 3 used half-body framing from
the start) — if it still fails, note the actual `pearson_r` and move on with
the better-scoring of the two attempts. Do not retry a third time (this
session's own lesson: 2 failed attempts is the point to stop and report, not
keep guessing blind).

- [ ] **Step 5: Repeat Steps 1-4 for lines 2 through 6**, substituting the
      text/voice/seed/source-image/output-names from the table above. Save
      each accepted LipDub output as `$DIR/shotN.mp4` (N = 1..6) for Task 5.

---

## Task 5: Assemble the final scene

**Files:**
- Output: `$DIR/dialogue-scene-final.mp4`

- [ ] **Step 1: Normalize resolution across all 6 shots (if needed)**

All 6 shots come from the same `--width 384 --height 576` LipDub call, so
this should already match — confirm with:

```bash
DIR=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--director/947cd975-3b8e-4d82-bd76-f9ea6bc1bc77/scratchpad/dialogue-scene
for i in 1 2 3 4 5 6; do
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$DIR/shot${i}.mp4"
done
```

Expected: all 6 lines print `384,576`. If any differ, scale it to match
(`ffmpeg -i in.mp4 -vf "scale=384:576" -c:a copy out.mp4`) before Step 2.

- [ ] **Step 2: Concatenate with `filter_complex concat` (audio-safe)**

```bash
DIR=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--director/947cd975-3b8e-4d82-bd76-f9ea6bc1bc77/scratchpad/dialogue-scene

ffmpeg -y \
  -i "$DIR/shot1.mp4" -i "$DIR/shot2.mp4" -i "$DIR/shot3.mp4" \
  -i "$DIR/shot4.mp4" -i "$DIR/shot5.mp4" -i "$DIR/shot6.mp4" \
  -filter_complex "\
[0:v]setpts=PTS-STARTPTS[v0];[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0]; \
[1:v]setpts=PTS-STARTPTS[v1];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1]; \
[2:v]setpts=PTS-STARTPTS[v2];[2:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a2]; \
[3:v]setpts=PTS-STARTPTS[v3];[3:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a3]; \
[4:v]setpts=PTS-STARTPTS[v4];[4:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a4]; \
[5:v]setpts=PTS-STARTPTS[v5];[5:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a5]; \
[v0][a0][v1][a1][v2][a2][v3][a3][v4][a4][v5][a5]concat=n=6:v=1:a=1[outv][outa]" \
  -map "[outv]" -map "[outa]" -c:v libx264 -c:a aac -pix_fmt yuv420p \
  "$DIR/dialogue-scene-final.mp4"
```

- [ ] **Step 3: Verify — the exact check that would have caught this
      session's earlier concat bug**

```bash
DIR=/private/tmp/claude-501/-Users-huangziyu-proj-video-generation--director/947cd975-3b8e-4d82-bd76-f9ea6bc1bc77/scratchpad/dialogue-scene

# Must produce zero output (no decode errors):
ffmpeg -v error -i "$DIR/dialogue-scene-final.mp4" -f null -

# Video and audio stream durations must match within a frame:
ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "$DIR/dialogue-scene-final.mp4"
ffprobe -v error -select_streams a:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "$DIR/dialogue-scene-final.mp4"
```

Expected: `ffmpeg -f null -` prints nothing (exit 0); the two `ffprobe`
durations differ by less than 0.1s.

- [ ] **Step 4: Visual spot-check**

Extract frames at the start/mid/end of each of the 6 shots (12 frames total)
via `ffmpeg -vf select=...`, read them with the Read tool, and confirm: (a)
Kai looks the same across shots 1/3/5, Dov looks the same across shots
2/4/6 (character consistency), and (b) no hallucinated-object artifacts like
the hand+eyeliner-pencil bug found in this session's monologue attempt 4.

- [ ] **Step 5: Copy to the output tree and open for review**

```bash
mkdir -p /Users/huangziyu/video_generation__output/movie-director/projects/dialogue-scene
cp /private/tmp/claude-501/-Users-huangziyu-proj-video-generation--director/947cd975-3b8e-4d82-bd76-f9ea6bc1bc77/scratchpad/dialogue-scene/dialogue-scene-final.mp4 \
   /Users/huangziyu/video_generation__output/movie-director/projects/dialogue-scene/dialogue-scene.mp4
open /Users/huangziyu/video_generation__output/movie-director/projects/dialogue-scene/dialogue-scene.mp4
```

---

## Self-Review Notes

- **Spec coverage:** Component 1 (MLX TTS) → Task 1-2. Component 2 (character
  portraits) → Task 3. Component 3 (per-line pipeline) → Task 4. Component 4
  (assembly) → Task 5. All four design-doc components have a task.
- **Scope cut (documented, not a placeholder):** the design doc's suggestion
  to document `espeak-ng` in `scripts/setup-offline.sh` / `setup.sh` was
  trimmed — neither script currently documents *any* brew/system dependency
  (not even `ffmpeg`, which this repo already assumes present), so adding a
  brew-prerequisites section for just this one dependency would be a new,
  unrequested precedent. The `requirements.txt` comment (Task 2) is the
  actual, in-scope fix.
- **Type/name consistency:** `_synthesize_mlx(text, voice, model, speed,
  out_path)` signature is identical between Task 1's implementation and its
  tests. `_DEFAULT_MLX_MODEL` / `_DEFAULT_MLX_VOICE` / `_DEFAULT_EDGE_VOICE`
  are used consistently across add_args, run(), and the test file.
