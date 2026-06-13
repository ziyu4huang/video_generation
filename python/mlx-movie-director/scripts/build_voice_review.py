#!/usr/bin/env python3
"""build_voice_review — ASR + rich voice-quality review HTML from a runs log.

Scores VOICE quality per cell three ways:
  1. ASR (mlx-whisper) transcribes the audio; we score similarity to the
     expected spoken phrase (default "Time to create") AND a true word-error
     rate (WER). This is the gold intelligibility metric — Phase 0 proved
     spectral flatness alone cannot measure it (the forge ambience floor swamps
     it).
  2. Rich voice metrics (app.voice_metrics.analyze_voice): SNR, speech activity,
     pitch F0 mean / std / semitone-spread (naturalness), dynamic range, onset
     rate, spectral centroid. These capture *quality/naturalness* on clips that
     all pass ASR at ~100%.
  3. Spectral flatness / ZCR / RMS (app.audio_noise_detect.is_audio_noise) — a
     secondary "is it white noise" sanity check.

A composite ``voice_score`` (0-100, documented weights + bounds) ranks cells so
the best config is identifiable at a glance; the top cell gets a ★ BEST badge.
Renders a playable <video> (audio) + the heard transcript + a match badge + all
metrics per cell. Bilingual chrome (en / zh_TW). Auto-falls back to flatness-only
if mlx_whisper is not installed (pass --no-asr to force).

Reads a runs log — one line per cell, pipe-separated:
    <mp4_path>|<label>|<transformer>|<steps>|<cfg>|<tag>[|<group>]

Usage:
    python scripts/build_voice_review.py --runs output/.voice_runs.txt \
        --target "Time to create" --asr-model mlx-community/whisper-small-mlx
"""

from __future__ import annotations

import argparse
import difflib
import html
import os
import re
import subprocess
import sys

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

from app.audio_noise_detect import is_audio_noise  # noqa: E402
from app.voice_metrics import analyze_voice  # noqa: E402

DEFAULT_TARGET = "Time to create"
DEFAULT_ASR_MODEL = "mlx-community/whisper-small-mlx"


# ---------------------------------------------------------------------------
# i18n chrome (en + zh_TW)
# ---------------------------------------------------------------------------

_I18N = {
    "en": {
        "guide": (
            "Each card plays the clip's audio. <b>match%</b> = how close the ASR "
            "transcript is to &ldquo;{target}&rdquo; (the intended line) &mdash; the "
            "real intelligibility metric. <b>voice</b> is a composite score "
            "(ASR&nbsp;40% · SNR&nbsp;20% · pitch-spread&nbsp;15% · "
            "brightness&nbsp;15% · dynamic-range&nbsp;10%) that ranks overall voice "
            "quality; the top cell is tagged ★&nbsp;BEST. Spectral flatness is a "
            "secondary noise check (low = structured sound, not a speech-quality rank)."
        ),
        "col_cell": "cell", "col_transformer": "transformer", "col_steps": "steps",
        "col_prompt": "prompt", "col_heard": "ASR heard", "col_match": "match",
        "col_voice": "voice", "col_flatness": "flatness",
        "heard_label": "heard", "asr_failed": "(ASR failed)",
        "grade_clear": "clear", "grade_partial": "partial", "grade_garbled": "garbled",
        "noise": "NOISE", "speech": "SPEECH", "best": "★ BEST",
        "tag_opt": "optimized", "tag_orig": "original",
        "group_default_suffix": " (sorted by voice score)",
        "title_default": "Voice review",
        "groups": {
            "primary": "Primary A/B — dasiwa vs dev @ 16 steps",
            "step": "Step control — 8 vs 16 steps (optimized prompt)",
            "prompt": "Prompt control — optimized vs original @ 16 steps",
            "baseline": "Baseline — original prompt, 8 steps",
            "cfg": "Audio-CFG axis — --audio-cfg-scale {default, 3.0, 5.0}",
            "stage1only": "Stage1-only axis — --audio-stage1-only",
            "tune": "dasiwa audio-knob tune — --audio-cfg-scale {default,3,5} × --audio-stage1-only {off,on}",
        },
    },
    "zh_TW": {
        "guide": (
            "每張卡片可播放該片段聲音。<b>吻合度</b> = ASR 轉錄結果與目標台詞「{target}」的相似度"
            " &mdash; 真正的語音可懂度指標。<b>voice</b> 為綜合分數"
            "（ASR&nbsp;40% · SNR&nbsp;20% · 音高離散&nbsp;15% · "
            "亮度&nbsp;15% · 動態範圍&nbsp;10%），排名整體語音品質；最高者標 ★&nbsp;BEST。"
            "頻譜平坦度僅為次要的噪音檢查（低＝有結構的聲音，非語音品質排名）。"
        ),
        "col_cell": "片段", "col_transformer": "轉換器", "col_steps": "步數",
        "col_prompt": "提示詞", "col_heard": "ASR 聽到", "col_match": "吻合度",
        "col_voice": "語音分", "col_flatness": "平坦度",
        "heard_label": "聽到", "asr_failed": "（ASR 失敗）",
        "grade_clear": "清楚", "grade_partial": "部分", "grade_garbled": "模糊",
        "noise": "噪音", "speech": "語音", "best": "★ 最佳",
        "tag_opt": "優化版", "tag_orig": "原始版",
        "group_default_suffix": "（依語音分排序）",
        "title_default": "語音評測",
        "groups": {
            "primary": "主要 A/B — dasiwa vs dev @ 16 步",
            "step": "步數對照 — 8 vs 16 步（優化提示詞）",
            "prompt": "提示詞對照 — 優化 vs 原始 @ 16 步",
            "baseline": "基線 — 原始提示詞，8 步",
            "cfg": "Audio-CFG 軸 — --audio-cfg-scale {預設, 3.0, 5.0}",
            "stage1only": "Stage1-only 軸 — --audio-stage1-only",
            "tune": "dasiwa 音訊旋鈕調校 — --audio-cfg-scale {預設,3,5} × --audio-stage1-only {關,開}",
        },
    },
}


# ---------------------------------------------------------------------------
# Text / scoring helpers
# ---------------------------------------------------------------------------

def _normalize_text(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return " ".join(s.split())


def _similarity(transcript: str, target: str) -> tuple[float, str]:
    """(0-100 sequence-match ratio, 'word_hits/total') vs the target phrase."""
    nt, ntarget = _normalize_text(transcript), _normalize_text(target)
    twords = ntarget.split()
    if twords:
        hits = sum(1 for w in twords if w in nt.split())
        word_hits = f"{hits}/{len(twords)}"
    else:
        word_hits = "-"
    ratio = difflib.SequenceMatcher(None, nt, ntarget).ratio()
    return ratio * 100.0, word_hits


def _wer(transcript: str, target: str) -> tuple[float, int, int]:
    """(wer in [0,1], ref_word_count, hyp_word_count) via Levenshtein over words."""
    ref = _normalize_text(target).split()
    hyp = _normalize_text(transcript).split()
    if not ref:
        return 0.0, 0, len(hyp)
    if not hyp:
        return 1.0, len(ref), 0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (0 if r == h else 1)))
        prev = cur
    return prev[-1] / len(ref), len(ref), len(hyp)


def _grade(sim: float | None, L: dict) -> tuple[str, str]:
    """(css class, localized label) for a match score."""
    if sim is None:
        return "noise", L["asr_failed"]
    if sim >= 70:
        return "speech", L["grade_clear"]
    if sim >= 40:
        return "warn", L["grade_partial"]
    return "noise", L["grade_garbled"]


# --- composite voice score ----------------------------------------------------
# Heuristic weights + bounds, calibrated from a Phase-0 pass over existing clips.
# Raw metrics are always shown next to the score so the ranking is auditable.
#
# Phase-0 finding: `--audio-volume 50` + alimiter normalizes loudness, so
# `speech_activity` saturates to ~1.0 for every clip (it only differentiates on
# the un-boosted latent). It is shown but NOT in the composite; spectral
# centroid (brightness/articulation) differentiates instead.
_VS_W = {"asr": 0.40, "snr": 0.20, "f0": 0.15, "centroid": 0.15, "dr": 0.10}


def _clip01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _voice_score(c: dict) -> float:
    asr = (c.get("similarity") or 0.0) / 100.0
    snr = _clip01((c.get("snr_db", 0.0) - 3.0) / 15.0)        # 3 dB→0, 18+ dB→1
    f0 = _clip01(c.get("f0_st_std", 0.0) / 3.0)               # >=3 st = fully natural
    cen = _clip01((c.get("spectral_centroid_hz", 0.0) - 800.0) / 2000.0)  # brighter→1
    dr = _clip01((c.get("dynamic_range_db", 0.0) - 6.0) / 12.0)
    w = _VS_W
    return 100.0 * (w["asr"] * asr + w["snr"] * snr + w["f0"] * f0
                    + w["centroid"] * cen + w["dr"] * dr)


# ---------------------------------------------------------------------------
# Run loading + per-cell scoring
# ---------------------------------------------------------------------------

def _extract_first_frame(mp4: str, png: str) -> bool:
    if os.path.exists(png):
        return True
    subprocess.run(["ffmpeg", "-y", "-i", mp4, "-vframes", "1", png],
                   capture_output=True, timeout=30)
    return os.path.exists(png)


def _load_runs(path: str) -> list[dict]:
    cells: list[dict] = []
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            parts = (line.split("|") + [""] * 7)[:7]
            mp4, label, transformer, steps, cfg, tag, group = parts
            if not mp4 or not os.path.exists(mp4):
                print(f"  ⚠️  skip {label or mp4}: mp4 missing", file=sys.stderr)
                continue
            cells.append({"mp4": mp4, "label": label, "transformer": transformer,
                          "steps": steps, "cfg": cfg, "tag": tag, "group": group})
    return cells


def _score_audio(cells: list[dict]) -> None:
    """Attach flatness/zcr/rms + is_noise + first-frame poster (in place)."""
    for c in cells:
        is_noise, m = is_audio_noise(c["mp4"])
        c["is_noise"], c["flatness"], c["zcr"], c["rms"] = (
            is_noise, m["spectral_flatness"], m["zcr"], m["rms"])
        png = os.path.splitext(c["mp4"])[0] + ".png"
        c["png"] = os.path.basename(png) if _extract_first_frame(c["mp4"], png) else ""


def _score_voice(cells: list[dict]) -> None:
    """Attach rich voice-quality metrics (app.voice_metrics) in place."""
    for c in cells:
        try:
            vm = analyze_voice(c["mp4"])
        except Exception as e:  # never let a metric failure abort the whole review
            print(f"  ⚠️  voice metrics failed for {c['label']}: {e}", file=sys.stderr)
            vm = {}
        for k in ("snr_db", "speech_activity", "f0_mean", "f0_std", "f0_st_std",
                  "dynamic_range_db", "onset_rate", "spectral_centroid_hz", "duration_s"):
            c[k] = float(vm.get(k, 0.0))


def _score_asr(cells: list[dict], model: str, target: str, use_asr: bool) -> bool:
    """Attach transcript/similarity/word_hits. Returns True if ASR ran."""
    for c in cells:
        c["transcript"], c["similarity"], c["word_hits"] = "", None, ""
    if not use_asr:
        return False
    try:
        import mlx_whisper
    except ImportError:
        print("  ⚠️  mlx_whisper not installed — flatness-only mode (pip install mlx-whisper)",
              file=sys.stderr)
        return False
    for c in cells:
        try:
            res = mlx_whisper.transcribe(c["mp4"], path_or_hf_repo=model,
                                         language="en", initial_prompt=target)
            text = (res.get("text") or "").strip()
            sim, wh = _similarity(text, target)
            c["transcript"], c["similarity"], c["word_hits"] = text, sim, wh
            print(f"  🎙  {c['label']}: {text!r}  (match {sim:.0f}%, {wh})")
        except Exception as e:
            print(f"  ⚠️  ASR failed for {c['label']}: {e}", file=sys.stderr)
    return True


def _finalize(cells: list[dict], target: str) -> None:
    """Attach WER, word count, composite voice_score, and the BEST flag."""
    for c in cells:
        wer, ref_n, hyp_n = _wer(c.get("transcript", ""), target)
        c["wer"], c["word_count"] = wer, hyp_n
        c["voice_score"] = round(_voice_score(c), 1)
    if cells:
        best = max(cells, key=lambda c: c["voice_score"])
        best["_best"] = True


def _grouped(cells: list[dict]) -> list[tuple[str, list[dict]]]:
    use_group = any(c.get("group") for c in cells)
    buckets: dict[str, list[dict]] = {}
    for c in cells:
        buckets.setdefault(c["group"] if use_group else c["transformer"], []).append(c)

    def voice_key(c: dict) -> tuple:
        return (c.get("voice_score", 0.0),)

    return [(k, sorted(v, key=voice_key, reverse=True)) for k, v in buckets.items()]


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

_STYLE = """
:root { --bg:#0f1115; --surface:#171a21; --accent:#6ea8fe; --ok:#3dd68c;
        --warn:#f0a04b; --err:#ff6b6b; --gold:#ffd166; --txt:#e6e6e6; --mut:#8b93a7; }
* { box-sizing:border-box; }
body { background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,
      BlinkMacSystemFont, 'Segoe UI', sans-serif; margin:0; padding:24px; }
h1 { font-size:20px; margin:0 0 4px; }
h2 { font-size:15px; color:var(--accent); margin:28px 0 10px;
     border-bottom:1px solid #2a2f3a; padding-bottom:6px; }
.guide { color:var(--mut); max-width:880px; margin:0 0 8px; font-size:13px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:14px; }
.card { background:var(--surface); border:1px solid #262b36; border-radius:10px; padding:12px; }
.card.best { border-color:var(--gold); box-shadow:0 0 0 1px var(--gold) inset; }
.card video { width:100%; border-radius:6px; background:#000; display:block; }
.card-meta { display:flex; justify-content:space-between; align-items:center;
             margin-bottom:8px; gap:8px; }
.label { font-weight:600; font-size:13px; word-break:break-all; }
.tag { font-size:11px; padding:2px 7px; border-radius:10px; background:#222838;
       color:var(--mut); white-space:nowrap; }
.heard { margin-top:9px; font-size:13px; }
.heard .mut { color:var(--mut); }
.heard .quote { color:var(--txt); font-style:italic; }
.metrics { margin-top:8px; font-size:11.5px; color:var(--mut);
           display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.badge { font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; }
.badge.noise { background:rgba(255,107,107,.15); color:var(--err); }
.badge.speech { background:rgba(61,214,140,.15); color:var(--ok); }
.badge.warn { background:rgba(240,160,75,.15); color:var(--warn); }
.badge.best { background:rgba(255,209,102,.18); color:var(--gold); }
.voice-score { font-size:12px; font-weight:700; padding:2px 9px; border-radius:10px;
               background:rgba(110,168,254,.16); color:var(--accent); }
.mval b { color:var(--txt); }
table { border-collapse:collapse; width:100%; max-width:1040px; margin:18px 0; font-size:13px; }
th,td { text-align:left; padding:5px 8px; border-bottom:1px solid #232833; }
th { color:var(--accent); font-weight:600; }
td.num { font-variant-numeric:tabular-nums; }
td.heard-cell { color:var(--txt); font-style:italic; max-width:240px; }
tr.best td { color:var(--gold); }
"""


def _fmt(x, fmt=".1f") -> str:
    try:
        return format(float(x), fmt)
    except (TypeError, ValueError):
        return "—"


def _verdict_table_html(cells: list[dict], L: dict, has_asr: bool) -> str:
    rows = sorted(cells, key=lambda c: c.get("voice_score", 0.0), reverse=True)
    head = (f"<th>{L['col_cell']}</th><th>{L['col_transformer']}</th>"
            f"<th>{L['col_steps']}</th><th>{L['col_prompt']}</th>")
    if has_asr:
        head += f"<th>{L['col_heard']}</th><th>{L['col_match']}</th>"
    head += (f"<th>{L['col_voice']}</th><th>SNR</th><th>F0σ(st)</th>"
             f"<th>centroid</th><th>{L['col_flatness']}</th>")
    body = []
    for c in rows:
        tag = L["tag_opt"] if c["tag"] == "opt" else (L["tag_orig"] if c["tag"] == "orig" else c["tag"])
        bcls = "best" if c.get("_best") else ""
        match = (f"{c['similarity']:.0f}% · {c['word_hits']}"
                 if has_asr and c["similarity"] is not None else "—")
        heard_cell = (f"<td class='heard-cell'>{html.escape(c['transcript']) or '—'}</td>"
                      f"<td><span class='badge {_grade(c['similarity'], L)[0]}'>{match}</span></td>"
                      ) if has_asr else ""
        body.append(
            f"<tr class='{bcls}'><td>{html.escape(c['label'])}</td>"
            f"<td>{html.escape(c['transformer'])}</td>"
            f"<td class='num'>{html.escape(c['steps'])}</td><td>{html.escape(tag)}</td>"
            f"{heard_cell}"
            f"<td class='num'><b>{_fmt(c.get('voice_score'), '.0f')}</b></td>"
            f"<td class='num'>{_fmt(c.get('snr_db'))}</td>"
            f"<td class='num'>{_fmt(c.get('f0_st_std'), '.2f')}</td>"
            f"<td class='num'>{_fmt(c.get('spectral_centroid_hz'), '.0f')}</td>"
            f"<td class='num'>{_fmt(c.get('flatness'), '.3f')}</td></tr>"
        )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def _card_html(c: dict, L: dict, has_asr: bool) -> str:
    tag = L["tag_opt"] if c["tag"] == "opt" else (L["tag_orig"] if c["tag"] == "orig" else c["tag"])
    poster = f' poster="{html.escape(c["png"])}"' if c["png"] else ""
    src = html.escape(os.path.basename(c["mp4"]))
    ncls = "noise" if c["is_noise"] else "speech"
    nverdict = L["noise"] if c["is_noise"] else L["speech"]
    best_cls = " best" if c.get("_best") else ""
    best_badge = f'<span class="badge best">{L["best"]}</span>' if c.get("_best") else ""

    heard = ""
    if has_asr:
        gcls, glabel = _grade(c["similarity"], L)
        match = (f"{c['similarity']:.0f}% · {c['word_hits']}"
                 if c["similarity"] is not None else L["asr_failed"])
        heard = (
            f'<div class="heard"><span class="mut">{L["heard_label"]}:</span> '
            f'<span class="quote">{html.escape(c["transcript"]) or "—"}</span> '
            f'<span class="badge {gcls}">{glabel} · {match}</span></div>'
        )

    return (
        f'<div class="card{best_cls}">'
        f'<div class="card-meta"><span class="label">{html.escape(c["label"])}</span>'
        f'<span class="tag">{html.escape(tag or c["transformer"])}</span></div>'
        f'<video controls preload="none" playsinline{poster} src="{src}"></video>'
        f'{heard}'
        f'<div class="metrics">'
        f'{best_badge}'
        f'<span class="voice-score">{L["col_voice"]} {_fmt(c.get("voice_score"), ".0f")}</span>'
        f'<span class="badge {ncls}">{nverdict}</span>'
        f'<span class="mval">SNR <b>{_fmt(c.get("snr_db"))}</b></span>'
        f'<span class="mval">F0 <b>{_fmt(c.get("f0_mean"), ".0f")}</b>Hz</span>'
        f'<span class="mval">F0σ <b>{_fmt(c.get("f0_st_std"), ".2f")}</b>st</span>'
        f'<span class="mval">centroid <b>{_fmt(c.get("spectral_centroid_hz"), ".0f")}</b></span>'
        f'<span class="mval">DR <b>{_fmt(c.get("dynamic_range_db"), ".1f")}</b>dB</span>'
        f'<span class="mval">onset <b>{_fmt(c.get("onset_rate"), ".1f")}</b>/s</span>'
        f'<span class="mval">{L["col_flatness"]} <b>{_fmt(c.get("flatness"), ".3f")}</b></span>'
        f'</div></div>'
    )


def _build_html(cells: list[dict], lang: str, title: str, target: str,
                out_path: str, has_asr: bool) -> str:
    L = _I18N[lang]
    guide = L["guide"].format(target=html.escape(target))
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width,initial-scale=1'>",
        f"<title>{html.escape(title)}</title><style>{_STYLE}</style></head><body>",
        f"<h1>{html.escape(title)}</h1>",
        f"<p class='guide'>{guide}</p>",
        _verdict_table_html(cells, L, has_asr),
    ]
    for name, group_cells in _grouped(cells):
        if any(c.get("group") for c in cells):
            display = L["groups"].get(name, name or L["title_default"])
        else:
            display = (name or L["title_default"]) + L["group_default_suffix"]
        parts.append(f"<h2>{html.escape(display)}</h2><div class='grid'>")
        parts.extend(_card_html(c, L, has_asr) for c in group_cells)
        parts.append("</div>")
    parts.append("</body></html>")
    with open(out_path, "w") as f:
        f.write("\n".join(parts))
    return out_path


def _print_verdict(cells: list[dict], target: str, has_asr: bool) -> None:
    print(f"\n=== Voice verdict (target: {target!r}) — sorted by voice score ===")
    hdr = (f"{'cell':<22}{'tf':<9}{'st':<5}{'tag':<6}"
           f"{'voice':<7}{'snr':<7}{'f0st':<7}{'cent':<8}{'flat':<7}")
    if has_asr:
        hdr += f"{'match':<7}{'wer':<6}heard"
    print(hdr)
    for c in sorted(cells, key=lambda c: c.get("voice_score", 0.0), reverse=True):
        line = (f"{c['label']:<22}{c['transformer']:<9}{c['steps']:<5}{c['tag']:<6}"
                f"{c.get('voice_score', 0):<7.0f}{c.get('snr_db', 0):<7.1f}"
                f"{c.get('f0_st_std', 0):<7.2f}{c.get('spectral_centroid_hz', 0):<8.0f}"
                f"{c.get('flatness', 0):<7.3f}")
        if has_asr:
            s = f"{c['similarity']:.0f}%" if c["similarity"] is not None else "—"
            line += f"{s:<7}{c['wer']:<6.2f}{c['transcript']!r}"
        mark = "  ★ BEST" if c.get("_best") else ""
        print(line + mark)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", required=True)
    ap.add_argument("--target", default=DEFAULT_TARGET, help="expected spoken phrase")
    ap.add_argument("--asr-model", default=DEFAULT_ASR_MODEL)
    ap.add_argument("--no-asr", action="store_true", help="skip ASR, flatness-only")
    ap.add_argument("--out-en", default=None)
    ap.add_argument("--out-zh", default=None)
    ap.add_argument("--title-en", default=None)
    ap.add_argument("--title-zh", default=None)
    args = ap.parse_args()

    if not os.path.exists(args.runs):
        sys.exit(f"ERROR: runs log not found: {args.runs}")

    cells = _load_runs(args.runs)
    if not cells:
        sys.exit("ERROR: no cells parsed from runs log")
    print(f"Loaded {len(cells)} cells from {args.runs}")

    _score_audio(cells)
    _score_voice(cells)
    has_asr = _score_asr(cells, args.asr_model, args.target, use_asr=not args.no_asr)
    _finalize(cells, args.target)
    _print_verdict(cells, args.target, has_asr)

    base = os.path.splitext(os.path.basename(args.runs))[0].lstrip(".")
    out_en = args.out_en or os.path.join(PROJECT_DIR, "output", f"review_{base}_en.html")
    out_zh = args.out_zh or os.path.join(PROJECT_DIR, "output", f"review_{base}_zh.html")
    title_en = args.title_en or "Voice review"
    title_zh = args.title_zh or "語音評測"

    for lang, title, out_path in (("en", title_en, out_en), ("zh_TW", title_zh, out_zh)):
        print(f"  📄 [{lang}] {_build_html(cells, lang, title, args.target, out_path, has_asr)}")

    best = max(cells, key=lambda c: c.get("voice_score", 0.0))
    print(f"\nDone. {len(cells)} cells · best voice_score = {best['label']} "
          f"({best['voice_score']:.0f}) · open {out_en} (or _zh.html) to listen.")


if __name__ == "__main__":
    main()
