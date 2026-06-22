"""video-t2i2v — Text → Image → Video pipeline.

Chains three stages in a single command:
  Stage 1 (T2I)  — ZImage (moody-pro-mix) generates a high-quality image
  Stage 2 (VLM)  — VLM reads the image + user action intent → LTX-optimized I2V prompt
  Stage 3 (I2V)  — LTX-2.3 (dasiwa) animates the image with the VLM prompt

Stage 2 is skipped when --action is omitted (raw --prompt used for video).

Usage:
  run.py video t2i2v --prompt "a woman in a garden"
  run.py video t2i2v --prompt "a woman" --action "她微笑走向鏡頭"
  run.py video t2i2v --prompt "a woman" --action "她跳舞" --transformer dasiwa --frames 49
"""

import glob
import json
import os
import subprocess
import sys
import time

from app.commands._shared import build_run_py_cmd
from app import config as cfg

PARSER_META = {
    "help": "T2I2V: ZImage T2I → VLM prompt assistant → LTX I2V in one command",
    "description": (
        "Three-stage pipeline: ZImage generates an image, optionally a VLM assistant "
        "reads the image and expands the user's action intent into an LTX-optimized I2V "
        "prompt (with voice in zh-TW), then LTX-2.3 animates the image.\n\n"
        "Examples:\n"
        "  run.py video t2i2v --prompt 'a woman in a garden'\n"
        "  run.py video t2i2v --prompt 'a woman' --action '她微笑走向鏡頭'\n"
        "  run.py video t2i2v --prompt 'a woman' --action '她跳舞' --frames 49\n"
    ),
}


def add_t2i2v_args(parser):
    # --- T2I stage ---
    parser.add_argument("--t2i-transformer", type=str, default="moody-pro-mix",
                        metavar="NAME",
                        help="ZImage transformer for T2I stage (default: moody-pro-mix)")
    # --- Audio fix ---
    parser.add_argument("--tts-voice", type=str, default=None, metavar="VOICE",
                        help="macOS TTS voice to overlay on video when audio language gate fails "
                             "(e.g. 'Mei-Jia' for zh-TW, 'Ting-Ting' for zh-CN). "
                             "Requires --quality-check. Mixed at 85%% TTS + 15%% original.")
    parser.add_argument("--t2i-steps", type=int, default=9,
                        help="T2I denoising steps (default: 9)")
    parser.add_argument("--t2i-seed", type=int, default=None,
                        help="T2I seed (default: same as --seed)")
    parser.add_argument("--t2i-width", type=int, default=640,
                        help="T2I image width (default: 640)")
    parser.add_argument("--t2i-height", type=int, default=960,
                        help="T2I image height (default: 960)")
    parser.add_argument("--t2i-cfg-scale", type=float, default=None,
                        help="cfg-scale for T2I stage (default: model default)")
    parser.add_argument("--t2i-lora-path", type=str, default=None, metavar="PATH",
                        help="LoRA path for T2I stage")
    parser.add_argument("--t2i-lora-scale", type=float, default=1.0,
                        help="LoRA scale for T2I stage (default: 1.0)")

    # --- VLM stage ---
    # dest="vlm_action" avoids conflict with the positional `action` arg in video.py
    # that dispatches to t2i2v/relay/restore/etc. Both share dest="action" otherwise.
    parser.add_argument("--action", type=str, default=None, metavar="TEXT",
                        dest="vlm_action",
                        help="Action intent (zh-TW supported). VLM expands to full LTX I2V "
                             "prompt with motion + voice. Omit to skip VLM stage.")
    parser.add_argument("--vlm-api-url", type=str, default=None, metavar="URL",
                        help="VLM API base URL override (default: http://localhost:1234/v1)")

    # --- T2I skip / reuse ---
    parser.add_argument("--from-image", type=str, default=None, metavar="PATH",
                        help="Skip T2I stage; use this image directly for VLM + I2V. "
                             "Useful for iterating on animation without regenerating the image.")

    # --- Quality gate (Stage 4) ---
    parser.add_argument("--quality-check", action="store_true",
                        help="Run VLM + signal quality gate after I2V (requires LM Studio)")
    parser.add_argument("--quality-threshold", type=float, default=5.5,
                        help="VLM score below which a dimension is flagged (default: 5.5)")
    parser.add_argument("--max-retries", type=int, default=0,
                        help="Auto-retry I2V up to N times when quality is WARN, "
                             "incrementing seed by 1 each attempt (requires --quality-check)")

    # --- Run review / comparison ---
    parser.add_argument("--review-runs", action="store_true",
                        help="Scan past t2i2v_* output dirs and print a quality comparison table")
    parser.add_argument("--review-dir", type=str, default=None, metavar="DIR",
                        help="Directory to scan for t2i2v_* runs (default: OUTPUT_DIR)")
    parser.add_argument("--rescore", action="store_true",
                        help="With --review-runs: retroactively run Stage 4 on runs that have a "
                             "video but no quality_report.json (requires LM Studio)")


def _print_run_table(rows: list, col_run: int = 28) -> None:
    """Print the t2i2v quality comparison table."""
    print(f"  {'Run':<{col_run}} Verdict   Overall  Artifacts  Coherence  Sharp(sig)  Flicker  "
          f"i2v-xfmr  Frames  Seed  Audio  VLM-ok  Static")
    print(f"  {'─' * col_run}  {'─' * 7}  {'─' * 7}  {'─' * 9}  {'─' * 9}  {'─' * 10}  "
          f"{'─' * 7}  {'─' * 8}  {'─' * 6}  {'─' * 4}  {'─' * 5}  {'─' * 6}  {'─' * 6}")
    for r in rows:
        def _fmt(v, fmt=".1f"):
            return f"{v:{fmt}}" if v is not None else "  —  "
        verdict_icon = {"PASS": "✓ PASS", "WARN": "⚠ WARN", "SKIP": "— SKIP"}.get(
            r["verdict"], r["verdict"]
        )
        vlm_ok_str = "yes" if r["vlm_ok"] else ("no" if r["vlm_ok"] is False else "—")
        static_str = "⚠ yes" if r.get("static") else ("no" if r.get("static") is False else "—")
        audio_lang = r.get("audio_lang") or "—"
        audio_ok = r.get("audio_lang_ok")
        audio_str = f"{'✓' if audio_ok else '⚠'}{audio_lang}" if audio_ok is not None else audio_lang
        print(
            f"  {r['run']:<{col_run}}"
            f"  {verdict_icon:<7}"
            f"  {_fmt(r['overall']):>7}"
            f"  {_fmt(r['artifacts']):>9}"
            f"  {_fmt(r['coherence']):>9}"
            f"  {_fmt(r['sharpness_sig'], '.0f'):>10}"
            f"  {_fmt(r['flicker'], '.1f'):>7}"
            f"  {str(r['i2v_xfmr']):<8}"
            f"  {str(r['frames'] or '—'):>6}"
            f"  {str(r['seed'] or '—'):>4}"
            f"  {audio_str:<5}"
            f"  {vlm_ok_str:<6}"
            f"  {static_str}"
        )


def _review_t2i2v_runs(args) -> None:
    """Scan past t2i2v_* output dirs and print a quality comparison table."""
    scan_dir = getattr(args, "review_dir", None) or cfg.OUTPUT_DIR
    run_dirs = sorted(glob.glob(os.path.join(scan_dir, "t2i2v_*")))
    if not run_dirs:
        print(f"[t2i2v review] No t2i2v_* runs found in: {scan_dir}")
        return

    print(f"[t2i2v review] Scanning {len(run_dirs)} run(s) in {scan_dir}\n")

    rows = []
    for d in run_dirs:
        name = os.path.basename(d)
        manifest_path = os.path.join(d, "t2i2v_manifest.json")
        report_path = os.path.join(d, "quality_report.json")

        manifest = {}
        if os.path.exists(manifest_path):
            try:
                with open(manifest_path) as f:
                    manifest = json.load(f)
            except (OSError, json.JSONDecodeError):
                pass

        report = {}
        if os.path.exists(report_path):
            try:
                with open(report_path) as f:
                    report = json.load(f)
            except (OSError, json.JSONDecodeError):
                pass

        stages = manifest.get("stages", {})
        t2i = stages.get("t2i", {})
        i2v = stages.get("i2v", {})
        vlm = stages.get("vlm", {})
        qual = stages.get("quality", {})

        vlm_scores = report.get("vlm", {})
        signal = report.get("signal", {})
        verdict = report.get("verdict", "—" if not report else "?")

        audio_asr = report.get("audio_asr", {})
        row = {
            "run": name,
            "verdict": verdict,
            "overall": vlm_scores.get("overall"),
            "artifacts": vlm_scores.get("artifacts"),
            "coherence": vlm_scores.get("temporal_coherence"),
            "sharpness_vlm": vlm_scores.get("sharpness"),
            "sharpness_sig": signal.get("sharpness_mean"),
            "flicker": signal.get("flicker_mean"),
            "snr": signal.get("snr_db_mean"),
            "t2i_xfmr": t2i.get("transformer", "?"),
            "i2v_xfmr": i2v.get("transformer", "?"),
            "frames": i2v.get("frames"),
            "seed": t2i.get("seed"),
            "vlm_ok": vlm.get("vlm_ok"),
            "static": report.get("static_flag"),
            "audio_lang": audio_asr.get("detected_lang"),
            "audio_lang_ok": audio_asr.get("lang_ok"),
            "audio_transcript": audio_asr.get("transcript", "")[:30],
            "has_video": bool(glob.glob(os.path.join(d, "*.mp4"))),
            "has_quality": bool(report),
        }
        rows.append(row)

    # Sort: runs with quality reports first, then by overall score desc
    rows.sort(key=lambda r: (not r["has_quality"], -(r["overall"] or 0)))

    col_run = 28
    _print_run_table(rows, col_run)

    has_reports = sum(1 for r in rows if r["has_quality"])
    has_videos = sum(1 for r in rows if r["has_video"])
    print(f"\n  {len(rows)} runs total  |  {has_videos} with video  |  {has_reports} with quality report")

    if getattr(args, "rescore", False):
        to_score = [r for r in rows if r["has_video"] and not r["has_quality"]]
        if not to_score:
            print("  (all video runs already have quality reports)")
        else:
            print(f"\n  --rescore: scoring {len(to_score)} unscored run(s)...")
            for r in to_score:
                mp4s = glob.glob(os.path.join(scan_dir, r["run"], "*.mp4"))
                if not mp4s:
                    continue
                video_path = sorted(mp4s)[0]
                run_dir = os.path.join(scan_dir, r["run"])
                manifest_path = os.path.join(run_dir, "t2i2v_manifest.json")
                prompt = ""
                if os.path.exists(manifest_path):
                    try:
                        with open(manifest_path) as f:
                            m = json.load(f)
                        prompt = m.get("stages", {}).get("i2v", {}).get("prompt", "")
                    except (OSError, json.JSONDecodeError):
                        pass
                print(f"\n  Scoring: {r['run']}")
                report = _run_quality_stage(args, video_path, prompt, run_dir)
                r["verdict"] = report.get("verdict", "?")
                r["has_quality"] = True
                vlm_scores = report.get("vlm", {})
                signal = report.get("signal", {})
                r["overall"] = vlm_scores.get("overall")
                r["artifacts"] = vlm_scores.get("artifacts")
                r["coherence"] = vlm_scores.get("temporal_coherence")
                r["sharpness_vlm"] = vlm_scores.get("sharpness")
                r["sharpness_sig"] = signal.get("sharpness_mean")
                r["flicker"] = signal.get("flicker_mean")
                r["snr"] = signal.get("snr_db_mean")
            # Re-sort and reprint after scoring
            rows.sort(key=lambda r: (not r["has_quality"], -(r["overall"] or 0)))
            print(f"\n\n{'═' * 110}")
            print("  Updated ranking after rescore:\n")
            _print_run_table(rows, col_run)
    elif has_reports < has_videos:
        print("  Tip: add --rescore to retroactively score unscored runs (requires LM Studio)")


_CHINESE_LANG_CODES = {"zh", "yue", "wuu"}  # Mandarin, Cantonese, Wu dialects
_TTS_VOICE_ZH = "Mei-Jia"  # macOS default zh-TW voice


def _apply_tts_fix(video_path: str, speech_text: str, tts_voice: str) -> bool:
    """Overlay macOS TTS speech onto video when audio language gate fails.

    Mixes: TTS at full volume + original video audio at 15 % (preserves
    background ambient sounds). Replaces the video file in-place.

    Returns True on success, False on any error.
    """
    if not speech_text:
        print("[t2i2v] TTS fix: no expected speech in prompt — skipped")
        return False

    base = video_path[:-4]  # strip .mp4
    aiff_path = base + "_tts.aiff"
    wav_path  = base + "_tts.wav"
    fixed_path = base + "_ttsfixed.mp4"

    try:
        # 1. Generate TTS via macOS say
        r = subprocess.run(
            ["say", "-v", tts_voice, speech_text, "-o", aiff_path],
            capture_output=True, timeout=30,
        )
        if r.returncode != 0:
            print(f"[t2i2v] TTS fix: say({tts_voice}) failed — {r.stderr.decode()[:80]}",
                  file=sys.stderr)
            return False

        # 2. Convert AIFF → 48 kHz stereo WAV (matches LTX output)
        subprocess.run(
            ["ffmpeg", "-y", "-i", aiff_path, "-ar", "48000", "-ac", "2", wav_path],
            capture_output=True, timeout=30,
        )

        # 3. Get video duration for trim
        dur_r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True,
        )
        dur = float(dur_r.stdout.strip() or "4.0")

        # 4. Mix: original @ 0.15 (background) + TTS @ 1.0, trim to video length
        r = subprocess.run([
            "ffmpeg", "-y",
            "-i", video_path,
            "-i", wav_path,
            "-filter_complex",
            (f"[0:a]volume=0.15[bg];"
             f"[1:a]atrim=0:{dur},asetpts=PTS-STARTPTS,adelay=300|300[tts];"
             "[bg][tts]amix=inputs=2:duration=first[aout]"),
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            fixed_path,
        ], capture_output=True, timeout=60)

        if r.returncode != 0:
            print(f"[t2i2v] TTS fix: ffmpeg mux failed — {r.stderr.decode()[-120:]}",
                  file=sys.stderr)
            return False

        os.replace(fixed_path, video_path)
        print(f"[t2i2v] TTS fix applied: voice={tts_voice!r}, text={speech_text!r}")
        return True

    except Exception as e:
        print(f"[t2i2v] TTS fix error: {e}", file=sys.stderr)
        return False
    finally:
        for p in [aiff_path, wav_path]:
            if os.path.exists(p):
                os.unlink(p)
        if os.path.exists(fixed_path):
            os.unlink(fixed_path)


def _extract_expected_speech(prompt: str) -> tuple:
    """Return (speech_text, expected_lang) from prompt speech markers.

    Looks for text inside 「」 brackets. Falls back to empty strings if none found.
    """
    import re
    m = re.search(r'「([^」]+)」', prompt)
    speech = m.group(1).strip() if m else ""
    lang = ""
    if speech:
        if re.search(r'[一-鿿㐀-䶿]', speech):
            lang = "zh"
        elif re.search(r'[ぁ-ゟ゠-ヿ]', speech):
            lang = "ja"
    return speech, lang


def _run_audio_asr_gate(video_path: str, prompt: str) -> dict:
    """ASR-based audio quality gate using mlx_whisper.

    Checks:
    1. Language detection — audio must be in the expected language (zh for Chinese).
    2. Content match — if expected speech extracted from prompt, transcript must
       overlap ≥ 50 % at the CJK character level.

    Returns dict with: detected_lang, expected_lang, transcript, expected_speech,
    lang_ok, content_match, content_ratio.  On error: {"error": "<reason>"}.
    """
    import re as _re
    import os as _os

    wav_path = video_path.replace(".mp4", "_asr_tmp.wav")
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vn", "-ar", "16000", "-ac", "1", wav_path],
        capture_output=True, timeout=30,
    )
    if r.returncode != 0 or not _os.path.exists(wav_path):
        return {"error": "ffmpeg audio extraction failed"}

    try:
        import mlx_whisper
        result = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo="mlx-community/whisper-large-v3-mlx",
            language=None,  # auto-detect — critical for catching wrong-language output
        )
        detected_lang = result.get("language", "")
        transcript = result.get("text", "").strip()
    finally:
        if _os.path.exists(wav_path):
            _os.unlink(wav_path)

    expected_speech, expected_lang = _extract_expected_speech(prompt)
    if not expected_lang:
        expected_lang = "zh"  # t2i2v default assumes zh-TW voice

    lang_ok = detected_lang in _CHINESE_LANG_CODES if expected_lang == "zh" else (
        detected_lang == expected_lang
    )

    content_match = None
    content_ratio = None
    if expected_speech and transcript:
        exp = _re.sub(r'[^一-鿿㐀-䶿\w]', '', expected_speech)
        trn = _re.sub(r'[^一-鿿㐀-䶿\w]', '', transcript)
        if exp:
            matched = sum(1 for c in exp if c in trn)
            content_ratio = round(matched / len(exp), 3)
            content_match = content_ratio >= 0.5

    return {
        "detected_lang": detected_lang,
        "expected_lang": expected_lang,
        "transcript": transcript,
        "expected_speech": expected_speech,
        "lang_ok": lang_ok,
        "content_match": content_match,
        "content_ratio": content_ratio,
    }


def _run_quality_stage(args, video_path: str, prompt: str, out_dir: str) -> dict:
    """Stage 4: VLM multi-frame scoring + signal metrics on the generated video."""
    print(f"\n[t2i2v] ── Stage 4: Quality Check ──")
    threshold = getattr(args, "quality_threshold", 5.5)
    _CHECK, _WARN = "✓", "⚠"

    # Step A — VLM scoring (subprocess reuses caption pipeline)
    vlm_scores: dict = {}
    cap_output = os.path.join(out_dir, "video_quality_score.json")
    cap_cmd = build_run_py_cmd(
        "caption", video_path,
        "--style", "video_score",
        "--lang", "en",
        "--output", cap_output,
        force=False,
    )
    if getattr(args, "vlm_api_url", None):
        cap_cmd += ["--api-url", args.vlm_api_url]

    try:
        result = subprocess.run(cap_cmd, cwd=os.path.dirname(cap_cmd[1]), timeout=600)
        if result.returncode == 0 and os.path.exists(cap_output):
            with open(cap_output) as f:
                cap_data = json.load(f)
            raw = cap_data.get("styles", {}).get("video_score", {}).get("caption", {})
            if isinstance(raw, str):
                try:
                    vlm_scores = json.loads(raw)
                except json.JSONDecodeError:
                    pass
            elif isinstance(raw, dict):
                vlm_scores = raw
    except subprocess.TimeoutExpired:
        print("[t2i2v] WARNING: VLM quality scoring timed out — skipped", file=sys.stderr)
    except Exception as e:
        print(f"[t2i2v] WARNING: VLM quality scoring failed ({e}) — skipped", file=sys.stderr)

    # Step B2 — Audio ASR gate (language + content check via mlx_whisper)
    audio_asr: dict = {}
    try:
        audio_asr = _run_audio_asr_gate(video_path, prompt)
    except ImportError:
        audio_asr = {"error": "mlx_whisper not installed"}
    except subprocess.TimeoutExpired:
        audio_asr = {"error": "ffmpeg audio extraction timed out"}
    except Exception as e:
        audio_asr = {"error": str(e)}

    # Step C — Signal metrics (direct import from quality_metrics, no subprocess)
    signal: dict = {}
    try:
        import cv2
        import numpy as np
        from app.quality_metrics import analyze_frame

        cap = cv2.VideoCapture(video_path)
        if cap.isOpened():
            sharpness_v, flicker_v, snr_v, blockiness_v = [], [], [], []
            prev_gray = None
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float64)
                m = analyze_frame(gray, frame)
                sharpness_v.append(m["sharpness"])
                snr_v.append(m["snr_db"])
                blockiness_v.append(m["blockiness"])
                if prev_gray is not None:
                    flicker_v.append(float(np.abs(gray - prev_gray).mean()))
                prev_gray = gray.copy()
            cap.release()
            _m = lambda v: float(np.mean(v)) if v else 0.0
            signal = {
                "sharpness_mean": _m(sharpness_v),
                "flicker_mean":   _m(flicker_v),
                "snr_db_mean":    _m(snr_v),
                "blockiness_mean": _m(blockiness_v),
                # inter-frame motion: mean of per-frame MAD vs previous frame
                # flicker_v already holds these MAD values; reuse for clarity
                "motion_mean": _m(flicker_v),
            }
    except Exception as e:
        print(f"[t2i2v] WARNING: signal metrics failed ({e}) — skipped", file=sys.stderr)

    # Step D — Verdict (only count gates where we have data)
    gates: list[tuple[str, bool]] = []
    static_flag = False  # True when video is detected as nearly static
    if audio_asr and not audio_asr.get("error"):
        gates.append(("audio lang", audio_asr.get("lang_ok", False)))
        if audio_asr.get("content_match") is not None:
            gates.append(("audio content", audio_asr["content_match"]))
    if vlm_scores:
        gates.append(("VLM overall",    vlm_scores.get("overall", 0) >= threshold))
        gates.append(("VLM artifacts",  vlm_scores.get("artifacts", 0) >= threshold))
        gates.append(("VLM coherence",  vlm_scores.get("temporal_coherence", 0) >= threshold))
        # VLM static detection: issues text often reports "identical frames" or "static image"
        issues_text = str(vlm_scores.get("issues", "")).lower()
        if "identical frame" in issues_text or "static image" in issues_text:
            static_flag = True
            gates.append(("no static frames", False))
    if signal:
        gates.append(("sharpness",  signal["sharpness_mean"] > 50))
        gates.append(("flicker",    signal["flicker_mean"] < 15))
        # Motion gate: inter-frame motion < 0.5 means nearly identical frames = static video
        motion_mean = signal.get("motion_mean", signal.get("flicker_mean", 99))
        if motion_mean < 0.5:
            static_flag = True
            gates.append(("has motion", False))
    verdict = "SKIP" if not gates else ("PASS" if all(ok for _, ok in gates) else "WARN")

    # Step E — Print summary
    if audio_asr and not audio_asr.get("error"):
        lang_icon = _CHECK if audio_asr.get("lang_ok") else _WARN
        det = audio_asr.get("detected_lang", "?")
        exp = audio_asr.get("expected_lang", "zh")
        trn = audio_asr.get("transcript", "")[:50]
        content_part = ""
        if audio_asr.get("content_match") is not None:
            cok = audio_asr["content_match"]
            content_part = f"  content={'OK' if cok else 'MISMATCH'}{_CHECK if cok else _WARN} ({audio_asr.get('content_ratio',0):.0%})"
        print(f"[Quality] Audio   lang={det}{lang_icon} (expected: {exp})"
              f"{content_part}  transcript={repr(trn)}")
        if not audio_asr.get("lang_ok"):
            print(f"[Quality] ⚠ AUDIO LANG FAIL: got '{det}', expected '{exp}' — "
                  f"try --transformer dev for correct zh speech")
    elif audio_asr.get("error"):
        print(f"[Quality] Audio   skipped ({audio_asr['error']})")
    else:
        print("[Quality] Audio   (no result)")

    if vlm_scores:
        dims = [
            ("overall", vlm_scores.get("overall")),
            ("sharpness", vlm_scores.get("sharpness")),
            ("detail", vlm_scores.get("detail_preservation")),
            ("color", vlm_scores.get("color_lighting")),
            ("coherence", vlm_scores.get("temporal_coherence")),
            ("artifacts", vlm_scores.get("artifacts")),
        ]
        parts = [f"{k}={v}{_CHECK if v and v >= threshold else _WARN}" for k, v in dims if v is not None]
        print(f"[Quality] VLM    {' '.join(parts[:3])}")
        print(f"[Quality]        {' '.join(parts[3:])}")
        if vlm_scores.get("summary"):
            print(f"[Quality]        {vlm_scores['summary']}")
        if vlm_scores.get("issues"):
            print(f"[Quality]  Issues: {vlm_scores['issues']}")
    else:
        print("[Quality] VLM    (not available — LM Studio offline?)")

    if signal:
        print(
            f"[Quality] Signal "
            f"sharpness={signal['sharpness_mean']:.1f}"
            f"{_CHECK if signal['sharpness_mean'] > 50 else _WARN} (>50)  "
            f"flicker={signal['flicker_mean']:.1f}"
            f"{_CHECK if signal['flicker_mean'] < 15 else _WARN} (<15)  "
            f"snr={signal['snr_db_mean']:.1f}dB"
        )
    else:
        print("[Quality] Signal  (not available)")

    if static_flag:
        print("[Quality] ⚠ STATIC: video has little/no motion — VLM Stage 2 may have failed "
              "(check vlm_ok in manifest)")
    verdict_icon = "✓ PASS" if verdict == "PASS" else ("— SKIP" if verdict == "SKIP" else "⚠ WARN")
    print(f"[Quality] → {verdict_icon}")

    # Step F — Write quality_report.json
    report = {
        "verdict": verdict,
        "static_flag": static_flag,
        "audio_asr": audio_asr,
        "vlm": vlm_scores,
        "signal": signal,
        "video_path": video_path,
        "prompt": prompt,
    }
    report_path = os.path.join(out_dir, "quality_report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"[Quality]   report: {report_path}")
    return report


def run_t2i2v(args):
    if getattr(args, "review_runs", False):
        _review_t2i2v_runs(args)
        return

    # --- Resolve shared seed ---
    base_seed = getattr(args, "seed", 99) or 99
    t2i_seed = getattr(args, "t2i_seed", None) or base_seed
    video_seed = base_seed

    # --- Create dedicated output subfolder ---
    base_dir = getattr(args, "gen_output_dir", None) or cfg.OUTPUT_DIR
    run_name = f"t2i2v_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(base_dir, run_name)
    os.makedirs(out_dir, exist_ok=True)
    print(f"[t2i2v] Output dir: {out_dir}")

    # =========================================================
    # Stage 1 — T2I: ZImage generates base image (or reuse --from-image)
    # =========================================================
    prompt = args.prompt
    from_image = getattr(args, "from_image", None)
    t2i_transformer = getattr(args, "t2i_transformer", "moody-pro-mix")
    t2i_steps = getattr(args, "t2i_steps", 9)
    t2i_width = getattr(args, "t2i_width", 640)
    t2i_height = getattr(args, "t2i_height", 960)
    t2i_cfg_scale = getattr(args, "t2i_cfg_scale", None)
    t2i_lora_path = getattr(args, "t2i_lora_path", None)
    t2i_lora_scale = getattr(args, "t2i_lora_scale", 1.0)

    if from_image:
        if not os.path.isfile(from_image):
            print(f"[t2i2v] ERROR: --from-image path not found: {from_image}", file=sys.stderr)
            sys.exit(1)
        image_path = from_image
        print(f"\n[t2i2v] ── Stage 1/3: T2I skipped (--from-image) ──")
        print(f"[t2i2v] Using existing image: {image_path}")
    else:
        print(f"\n[t2i2v] ── Stage 1/3: T2I (ZImage) ──")
        t2i_cmd = build_run_py_cmd(
            "image", "t2i",
            "--prompt", prompt,
            "--transformer", t2i_transformer,
            "--steps", str(t2i_steps),
            "--seed", str(t2i_seed),
            "--width", str(t2i_width),
            "--height", str(t2i_height),
            "--gen-output-dir", out_dir,
        )
        if t2i_cfg_scale is not None:
            t2i_cmd += ["--cfg-scale", str(t2i_cfg_scale)]
        if t2i_lora_path:
            t2i_cmd += ["--lora-path", t2i_lora_path,
                        "--lora-scale", str(t2i_lora_scale)]

        try:
            # Stream (no capture): T2I runs minutes-to-tens-of-minutes, and capturing
            # would swallow MLX's live step progress. timeout still guards a hang.
            result = subprocess.run(t2i_cmd, cwd=os.path.dirname(t2i_cmd[1]), timeout=7200)
        except subprocess.TimeoutExpired:
            print("[t2i2v] ERROR: T2I stage timed out after 7200s", file=sys.stderr)
            sys.exit(124)
        if result.returncode != 0:
            # Child stderr already streamed live; just surface the exit summary.
            print(f"[t2i2v] ERROR: T2I stage failed (exit {result.returncode})", file=sys.stderr)
            sys.exit(result.returncode)

        # Find the generated image via its manifest
        manifests = glob.glob(os.path.join(out_dir, "*.manifest.json"))
        if not manifests:
            print("[t2i2v] ERROR: no manifest found after T2I stage", file=sys.stderr)
            sys.exit(1)
        try:
            with open(sorted(manifests)[0]) as f:
                t2i_manifest = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f"[t2i2v] ERROR: cannot read T2I manifest ({e})", file=sys.stderr)
            sys.exit(1)
        output_files = t2i_manifest.get("output_files", [])
        if not output_files:
            print("[t2i2v] ERROR: T2I manifest has no output_files", file=sys.stderr)
            sys.exit(1)
        image_path = output_files[0]["path"]
        print(f"[t2i2v] T2I image: {image_path}")

    # =========================================================
    # Stage 2 — VLM: generate LTX-optimized I2V prompt
    # =========================================================
    action = getattr(args, "vlm_action", None)
    video_prompt = prompt  # fallback: use raw T2I prompt
    vlm_ok = False  # tracks whether VLM successfully generated a prompt

    if action:
        print(f"\n[t2i2v] ── Stage 2/3: VLM prompt assistant ──")
        vlm_output = os.path.join(out_dir, "vlm_prompt.json")
        vlm_cmd = build_run_py_cmd(
            "caption", image_path,
            "--style", "ltx_i2v",
            "--action", action,
            "--lang", "en",  # VLM output language for LTX prompt (voice stays zh-TW per style)
            "--output", vlm_output,
            force=False,  # caption is CPU-bound (VLM), no GPU lock needed
        )
        if getattr(args, "vlm_api_url", None):
            vlm_cmd += ["--api-url", args.vlm_api_url]

        try:
            result = subprocess.run(vlm_cmd, cwd=os.path.dirname(vlm_cmd[1]), timeout=7200)
        except subprocess.TimeoutExpired:
            print("[t2i2v] WARNING: VLM stage timed out after 7200s — falling back to raw prompt",
                  file=sys.stderr)
            result = None
        if result is None:
            pass  # timed out — already warned, fall back to raw prompt
        elif result.returncode != 0:
            print(f"[t2i2v] WARNING: VLM stage failed — falling back to raw prompt",
                  file=sys.stderr)
        else:
            try:
                vlm_data = json.load(open(vlm_output))
                # ltx_i2v returns JSON inside caption; parse it
                ltx_caption = vlm_data.get("styles", {}).get("ltx_i2v", {}).get("caption", "")
                vlm_model = vlm_data.get("styles", {}).get("ltx_i2v", {}).get("model", "unknown")
                if isinstance(ltx_caption, str):
                    # VLM may return JSON string or already-parsed dict
                    try:
                        ltx_obj = json.loads(ltx_caption)
                    except (json.JSONDecodeError, TypeError):
                        ltx_obj = {}
                elif isinstance(ltx_caption, dict):
                    ltx_obj = ltx_caption
                else:
                    ltx_obj = {}
                generated_prompt = ltx_obj.get("prompt", "")
                if generated_prompt:
                    video_prompt = generated_prompt
                    vlm_ok = True
                    motion_summary = ltx_obj.get("motion_summary", "")
                    print(f"[t2i2v] VLM prompt ({vlm_model}): {video_prompt[:120]}...")
                    if motion_summary:
                        print(f"[t2i2v] Motion: {motion_summary}")
                else:
                    print(f"[t2i2v] WARNING: VLM ({vlm_model}) returned empty prompt — "
                          "using raw prompt (check LM Studio: is the VLM loaded and responding?)",
                          file=sys.stderr)
            except (OSError, json.JSONDecodeError, KeyError) as e:
                print(f"[t2i2v] WARNING: failed to parse VLM output ({e}) — using raw prompt",
                      file=sys.stderr)
    else:
        print(f"\n[t2i2v] ── Stage 2/3: VLM skipped (no --action) ──")

    # =========================================================
    # Stage 3 — I2V: LTX animates the image
    # =========================================================
    print(f"\n[t2i2v] ── Stage 3/3: I2V (LTX-2.3) ──")

    # Resolve LTX transformer: use --transformer if explicitly passed, else dev.
    # dev is the default for t2i2v: produces correct zh audio + higher signal
    # sharpness (279 vs 165). dasiwa/distilled both generate Japanese-sounding
    # audio for zh-TW prompts (Whisper detects 'ja') due to finetuning side-effects.
    ltx_transformer = getattr(args, "transformer", None) or "dev"
    frames = getattr(args, "frames", 97) or 97
    fps = getattr(args, "fps", 24) or 24
    cfg_scale = getattr(args, "cfg_scale", None)
    stg_scale = getattr(args, "stg_scale", None)
    stage1_steps = getattr(args, "stage1_steps", None)
    stage2_steps = getattr(args, "stage2_steps", None)
    hq = getattr(args, "hq", False)
    distilled = getattr(args, "distilled", False)
    teacache = getattr(args, "teacache", False)
    lora_path = getattr(args, "lora_path", None)
    lora_scale = getattr(args, "lora_scale", 1.0)

    video_cmd = build_run_py_cmd(
        "video", "generate",
        "--input-image", image_path,
        "--prompt", video_prompt,
        "--transformer", ltx_transformer,
        "--frames", str(frames),
        "--fps", str(fps),
        "--seed", str(video_seed),
        "--gen-output-dir", out_dir,
    )
    if cfg_scale is not None:
        video_cmd += ["--cfg-scale", str(cfg_scale)]
    if stg_scale is not None:
        video_cmd += ["--stg-scale", str(stg_scale)]
    if stage1_steps is not None:
        video_cmd += ["--stage1-steps", str(stage1_steps)]
    if stage2_steps is not None:
        video_cmd += ["--stage2-steps", str(stage2_steps)]
    if hq:
        video_cmd.append("--hq")
    if distilled:
        video_cmd.append("--distilled")
    if teacache:
        video_cmd.append("--teacache")
    if lora_path:
        video_cmd += ["--lora-path", lora_path, "--lora-scale", str(lora_scale)]

    try:
        # Stream (no capture): I2V is the longest stage; capturing would hide MLX
        # progress for tens of minutes. timeout guards a hang.
        result = subprocess.run(video_cmd, cwd=os.path.dirname(video_cmd[1]), timeout=7200)
    except subprocess.TimeoutExpired:
        print("[t2i2v] ERROR: I2V stage timed out after 7200s", file=sys.stderr)
        sys.exit(124)
    if result.returncode != 0:
        print(f"[t2i2v] ERROR: I2V stage failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(result.returncode)

    # Find the generated video for Stage 4
    video_files = glob.glob(os.path.join(out_dir, "*.mp4"))
    video_path = sorted(video_files)[0] if video_files else None

    # =========================================================
    # Stage 4 (optional) — Quality: VLM + signal gate  [+ auto-retry on WARN]
    # =========================================================
    quality_result = None
    max_retries = getattr(args, "max_retries", 0)
    if getattr(args, "quality_check", False) and video_path:
        quality_result = _run_quality_stage(args, video_path, video_prompt, out_dir)
        # Auto-retry I2V with incremented seed when quality is WARN
        for attempt in range(1, max_retries + 1):
            if quality_result and quality_result.get("verdict") in ("PASS", "SKIP"):
                break
            retry_seed = video_seed + attempt
            print(f"\n[t2i2v] ── Auto-retry {attempt}/{max_retries}: I2V with seed={retry_seed} ──")
            retry_video_cmd = build_run_py_cmd(
                "video", "generate",
                "--input-image", image_path,
                "--prompt", video_prompt,
                "--transformer", ltx_transformer,
                "--frames", str(frames),
                "--fps", str(fps),
                "--seed", str(retry_seed),
                "--gen-output-dir", out_dir,
            )
            if cfg_scale is not None:
                retry_video_cmd += ["--cfg-scale", str(cfg_scale)]
            if stg_scale is not None:
                retry_video_cmd += ["--stg-scale", str(stg_scale)]
            if stage1_steps is not None:
                retry_video_cmd += ["--stage1-steps", str(stage1_steps)]
            if stage2_steps is not None:
                retry_video_cmd += ["--stage2-steps", str(stage2_steps)]
            if hq:
                retry_video_cmd.append("--hq")
            if distilled:
                retry_video_cmd.append("--distilled")
            if teacache:
                retry_video_cmd.append("--teacache")
            if lora_path:
                retry_video_cmd += ["--lora-path", lora_path, "--lora-scale", str(lora_scale)]
            try:
                result = subprocess.run(retry_video_cmd, cwd=os.path.dirname(retry_video_cmd[1]),
                                        timeout=7200)
            except subprocess.TimeoutExpired:
                print(f"[t2i2v] WARNING: retry {attempt} I2V timed out — stopping retries",
                      file=sys.stderr)
                break
            if result.returncode != 0:
                print(f"[t2i2v] WARNING: retry {attempt} I2V failed — stopping retries",
                      file=sys.stderr)
                break
            # Pick the newest .mp4 (retry outputs a new file)
            retry_videos = sorted(glob.glob(os.path.join(out_dir, "*.mp4")))
            if retry_videos:
                video_path = retry_videos[-1]
                video_seed = retry_seed
            quality_result = _run_quality_stage(args, video_path, video_prompt, out_dir)
    elif getattr(args, "quality_check", False) and not video_path:
        print("[t2i2v] WARNING: --quality-check skipped — no .mp4 found in output dir",
              file=sys.stderr)

    # =========================================================
    # Stage 4b (optional) — TTS audio fix when audio lang gate fails
    # =========================================================
    tts_voice = getattr(args, "tts_voice", None)
    if (tts_voice and video_path and quality_result and
            not quality_result.get("audio_asr", {}).get("lang_ok", True)):
        asr = quality_result.get("audio_asr", {})
        expected_speech = asr.get("expected_speech", "")
        if not expected_speech:
            # Try to extract from the prompt directly
            expected_speech, _ = _extract_expected_speech(video_prompt)
        print(f"\n[t2i2v] ── Stage 4b: TTS audio fix (lang={asr.get('detected_lang')} → zh) ──")
        fixed = _apply_tts_fix(video_path, expected_speech, tts_voice)
        if fixed and getattr(args, "quality_check", False):
            # Re-run quality stage to verify fix
            print("[t2i2v] Re-running quality check after TTS fix...")
            quality_result = _run_quality_stage(args, video_path, video_prompt, out_dir)

    # =========================================================
    # Write combined manifest
    # =========================================================
    if from_image:
        t2i_section = {"skipped": True, "from_image": image_path}
    else:
        t2i_section = {
            "transformer": t2i_transformer,
            "prompt": prompt,
            "steps": t2i_steps,
            "seed": t2i_seed,
            "width": t2i_width,
            "height": t2i_height,
            "cfg_scale": t2i_cfg_scale,
            "image_path": image_path,
        }

    combined_manifest = {
        "pipeline": "t2i2v",
        "output_dir": out_dir,
        "stages": {
            "t2i": t2i_section,
            "vlm": {
                "action": action,
                "generated_prompt": video_prompt if action else None,
                "skipped": action is None,
                "vlm_ok": vlm_ok,  # False = VLM failed/empty, fell back to raw prompt
            },
            "i2v": {
                "transformer": ltx_transformer,
                "prompt": video_prompt,
                "frames": frames,
                "fps": fps,
                "seed": video_seed,  # final seed (may differ from base_seed after auto-retry)
            },
            "quality": quality_result if quality_result else {"skipped": True},
        },
    }
    manifest_path = os.path.join(out_dir, "t2i2v_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(combined_manifest, f, indent=2, ensure_ascii=False)

    print(f"\n[t2i2v] ✓ Done → {out_dir}")
    print(f"[t2i2v]   manifest: {manifest_path}")
