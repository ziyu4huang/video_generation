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

import argparse
import glob
import json
import os
import subprocess
import sys
import time
from typing import Any

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


def add_t2i2v_args(parser: argparse.ArgumentParser) -> None:
    # --- T2I stage ---
    parser.add_argument("--t2i-transformer", type=str, default="moody-pro-mix",
                        metavar="NAME",
                        help="ZImage transformer for T2I stage (default: moody-pro-mix)")
    parser.add_argument("--t2i-steps", type=int, default=9,
                        help="T2I denoising steps (default: 9)")
    parser.add_argument("--t2i-seed", type=int, default=None,
                        help="T2I seed (default: same as --seed)")
    parser.add_argument("--t2i-width", type=int, default=640,
                        help="T2I image width (default: 640)")
    parser.add_argument("--t2i-height", type=int, default=960,
                        help="T2I image height (default: 960)")
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

    # --- Quality gate (Stage 4) ---
    parser.add_argument("--quality-check", action="store_true",
                        help="Run VLM + signal quality gate after I2V (requires LM Studio)")
    parser.add_argument("--quality-threshold", type=float, default=5.5,
                        help="VLM score below which a dimension is flagged (default: 5.5)")

    # --- Run review / comparison ---
    parser.add_argument("--review-runs", action="store_true",
                        help="Scan past t2i2v_* output dirs and print a quality comparison table")
    parser.add_argument("--review-dir", type=str, default=None, metavar="DIR",
                        help="Directory to scan for t2i2v_* runs (default: OUTPUT_DIR)")
    parser.add_argument("--rescore", action="store_true",
                        help="With --review-runs: retroactively run Stage 4 on runs that have a "
                             "video but no quality_report.json (requires LM Studio)")


def _print_run_table(rows: list[dict[str, Any]], col_run: int = 28) -> None:
    """Print the t2i2v quality comparison table."""
    print(f"  {'Run':<{col_run}} Verdict   Overall  Artifacts  Coherence  Sharp(sig)  Flicker  "
          f"i2v-xfmr  Frames  Seed  VLM-ok  Static")
    print(f"  {'─' * col_run}  {'─' * 7}  {'─' * 7}  {'─' * 9}  {'─' * 9}  {'─' * 10}  "
          f"{'─' * 7}  {'─' * 8}  {'─' * 6}  {'─' * 4}  {'─' * 6}  {'─' * 6}")
    for r in rows:
        def _fmt(v, fmt=".1f"):
            return f"{v:{fmt}}" if v is not None else "  —  "
        verdict_icon = {"PASS": "✓ PASS", "WARN": "⚠ WARN", "SKIP": "— SKIP"}.get(
            r["verdict"], r["verdict"]
        )
        vlm_ok_str = "yes" if r["vlm_ok"] else ("no" if r["vlm_ok"] is False else "—")
        static_str = "⚠ yes" if r.get("static") else ("no" if r.get("static") is False else "—")
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
            f"  {vlm_ok_str:<6}"
            f"  {static_str}"
        )


def _review_t2i2v_runs(args: argparse.Namespace) -> None:
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


def _run_quality_stage(args: argparse.Namespace, video_path: str, prompt: str, out_dir: str) -> dict[str, Any]:
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

    # Step B — Signal metrics (direct import from quality_metrics, no subprocess)
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

    # Step C — Verdict (only count gates where we have data)
    gates: list[tuple[str, bool]] = []
    static_flag = False  # True when video is detected as nearly static
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

    # Step D — Print summary
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

    # Step E — Write quality_report.json
    report = {
        "verdict": verdict,
        "static_flag": static_flag,
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


def run_t2i2v(args: argparse.Namespace) -> None:
    if getattr(args, "review_runs", False):
        _review_t2i2v_runs(args)
        return

    # --- Resolve shared seed ---
    # Use explicit None-checks (never `or`) so a legitimate seed of 0 is honored.
    _s = getattr(args, "seed", None)
    base_seed = 99 if _s is None else int(_s)
    _t = getattr(args, "t2i_seed", None)
    t2i_seed = base_seed if _t is None else int(_t)
    video_seed = base_seed

    # --- Create dedicated output subfolder ---
    base_dir = getattr(args, "gen_output_dir", None) or cfg.OUTPUT_DIR
    run_name = f"t2i2v_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(base_dir, run_name)
    os.makedirs(out_dir, exist_ok=True)
    print(f"[t2i2v] Output dir: {out_dir}")

    # =========================================================
    # Stage 1 — T2I: ZImage generates base image
    # =========================================================
    print(f"\n[t2i2v] ── Stage 1/3: T2I (ZImage) ──")
    prompt = args.prompt
    t2i_transformer = getattr(args, "t2i_transformer", "moody-pro-mix")
    t2i_steps = getattr(args, "t2i_steps", 9)
    t2i_width = getattr(args, "t2i_width", 640)
    t2i_height = getattr(args, "t2i_height", 960)
    t2i_lora_path = getattr(args, "t2i_lora_path", None)
    t2i_lora_scale = getattr(args, "t2i_lora_scale", 1.0)

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
                          "using raw prompt (is Qwen3-VL loaded in LM Studio?)",
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

    # Resolve LTX transformer: use --transformer if explicitly passed, else dasiwa
    ltx_transformer = getattr(args, "transformer", None) or "dasiwa"
    _f = getattr(args, "frames", None)
    frames = 97 if _f is None else int(_f)
    _fp = getattr(args, "fps", None)
    fps = 24.0 if _fp is None else float(_fp)
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
    # Stage 4 (optional) — Quality: VLM + signal gate
    # =========================================================
    quality_result = None
    if getattr(args, "quality_check", False) and video_path:
        quality_result = _run_quality_stage(args, video_path, video_prompt, out_dir)
    elif getattr(args, "quality_check", False) and not video_path:
        print("[t2i2v] WARNING: --quality-check skipped — no .mp4 found in output dir",
              file=sys.stderr)

    # =========================================================
    # Write combined manifest
    # =========================================================
    combined_manifest = {
        "pipeline": "t2i2v",
        "output_dir": out_dir,
        "stages": {
            "t2i": {
                "transformer": t2i_transformer,
                "prompt": prompt,
                "steps": t2i_steps,
                "seed": t2i_seed,
                "width": t2i_width,
                "height": t2i_height,
                "image_path": image_path,
            },
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
                "seed": video_seed,
            },
            "quality": quality_result if quality_result else {"skipped": True},
        },
    }
    manifest_path = os.path.join(out_dir, "t2i2v_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(combined_manifest, f, indent=2, ensure_ascii=False)

    print(f"\n[t2i2v] ✓ Done → {out_dir}")
    print(f"[t2i2v]   manifest: {manifest_path}")
