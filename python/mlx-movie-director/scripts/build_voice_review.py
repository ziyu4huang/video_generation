#!/usr/bin/env python3
"""build_voice_review — ASR + audio-metric review HTML from a runs log.

Scores VOICE quality per cell two ways:
  1. ASR (mlx-whisper) transcribes the audio, then we score similarity to the
     expected spoken phrase (default "Time to create"). This is the real
     intelligibility metric — Phase 0 proved spectral flatness alone cannot
     measure it (the forge ambience floor swamps it).
  2. Spectral flatness / ZCR / RMS via app.audio_noise_detect.is_audio_noise —
     a secondary "is it white noise" sanity check (NOT an intelligibility rank).

Renders a playable <video> (audio) + the heard transcript + a match badge +
flatness per cell. Bilingual chrome (en / zh_TW). Auto-falls back to
flatness-only if mlx_whisper is not installed (pass --no-asr to force).

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

DEFAULT_TARGET = "Time to create"
DEFAULT_ASR_MODEL = "mlx-community/whisper-small-mlx"


# ---------------------------------------------------------------------------
# i18n chrome (en + zh_TW)
# ---------------------------------------------------------------------------

_I18N = {
    "en": {
        "guide": (
            "Each card plays the clip's audio. <b>match%</b> = how close the "
            "ASR transcript is to &ldquo;{target}&rdquo; (the intended line) &mdash; "
            "this is the real voice-intelligibility metric. "
            "&ge;70 clear, 40&ndash;69 partial, &lt;40 garbled. "
            "Spectral flatness is a secondary noise check (low = structured sound, "
            "not a speech-quality rank)."
        ),
        "col_cell": "cell", "col_transformer": "transformer", "col_steps": "steps",
        "col_prompt": "prompt", "col_heard": "ASR heard", "col_match": "match",
        "col_flatness": "flatness",
        "heard_label": "heard", "asr_failed": "(ASR failed)",
        "grade_clear": "clear", "grade_partial": "partial", "grade_garbled": "garbled",
        "noise": "NOISE", "speech": "SPEECH",
        "tag_opt": "optimized", "tag_orig": "original",
        "group_default_suffix": " (sorted by steps)",
        "title_default": "Voice review",
        "groups": {
            "primary": "Primary A/B — dasiwa vs dev @ 16 steps",
            "step": "Step control — 8 vs 16 steps (optimized prompt)",
            "prompt": "Prompt control — optimized vs original @ 16 steps",
            "baseline": "Baseline — original prompt, 8 steps",
        },
    },
    "zh_TW": {
        "guide": (
            "每張卡片可播放該片段聲音。<b>吻合度</b> = ASR 轉錄結果與目標台詞「{target}」的相似度"
            " &mdash; 這才是真正的語音可懂度指標。"
            "&ge;70 清楚、40&ndash;69 部分可懂、&lt;40 模糊難辨。"
            "頻譜平坦度僅為次要的噪音檢查（低＝有結構的聲音，非語音品質排名）。"
        ),
        "col_cell": "片段", "col_transformer": "轉換器", "col_steps": "步數",
        "col_prompt": "提示詞", "col_heard": "ASR 聽到", "col_match": "吻合度",
        "col_flatness": "平坦度",
        "heard_label": "聽到", "asr_failed": "（ASR 失敗）",
        "grade_clear": "清楚", "grade_partial": "部分", "grade_garbled": "模糊",
        "noise": "噪音", "speech": "語音",
        "tag_opt": "優化版", "tag_orig": "原始版",
        "group_default_suffix": "（依步數排序）",
        "title_default": "語音評測",
        "groups": {
            "primary": "主要 A/B — dasiwa vs dev @ 16 步",
            "step": "步數對照 — 8 vs 16 步（優化提示詞）",
            "prompt": "提示詞對照 — 優化 vs 原始 @ 16 步",
            "baseline": "基線 — 原始提示詞，8 步",
        },
    },
}


# ---------------------------------------------------------------------------
# Helpers
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


def _grade(sim: float | None, L: dict) -> tuple[str, str]:
    """(css class, localized label) for a match score."""
    if sim is None:
        return "noise", L["asr_failed"]
    if sim >= 70:
        return "speech", L["grade_clear"]
    if sim >= 40:
        return "warn", L["grade_partial"]
    return "noise", L["grade_garbled"]


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
        c["is_noise"], c["flatness"], c["zcr"], c["rms"] = is_noise, m["spectral_flatness"], m["zcr"], m["rms"]
        png = os.path.splitext(c["mp4"])[0] + ".png"
        c["png"] = os.path.basename(png) if _extract_first_frame(c["mp4"], png) else ""


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


def _grouped(cells: list[dict]) -> list[tuple[str, list[dict]]]:
    use_group = any(c.get("group") for c in cells)
    buckets: dict[str, list[dict]] = {}
    for c in cells:
        buckets.setdefault(c["group"] if use_group else c["transformer"], []).append(c)

    def step_key(c: dict) -> tuple:
        try:
            s = int(c["steps"])
        except ValueError:
            s = 9999
        try:
            cf = float(c["cfg"])
        except ValueError:
            cf = 0.0
        return (s, cf)

    return [(k, sorted(v, key=step_key)) for k, v in buckets.items()]


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

_STYLE = """
:root { --bg:#0f1115; --surface:#171a21; --accent:#6ea8fe; --ok:#3dd68c;
        --warn:#f0a04b; --err:#ff6b6b; --txt:#e6e6e6; --mut:#8b93a7; }
* { box-sizing:border-box; }
body { background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,
      BlinkMacSystemFont, 'Segoe UI', sans-serif; margin:0; padding:24px; }
h1 { font-size:20px; margin:0 0 4px; }
h2 { font-size:15px; color:var(--accent); margin:28px 0 10px;
     border-bottom:1px solid #2a2f3a; padding-bottom:6px; }
.guide { color:var(--mut); max-width:860px; margin:0 0 8px; font-size:13px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
.card { background:var(--surface); border:1px solid #262b36; border-radius:10px; padding:12px; }
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
.mval b { color:var(--txt); }
table { border-collapse:collapse; width:100%; max-width:920px; margin:18px 0; font-size:13px; }
th,td { text-align:left; padding:5px 8px; border-bottom:1px solid #232833; }
th { color:var(--accent); font-weight:600; }
td.num { font-variant-numeric:tabular-nums; }
td.heard-cell { color:var(--txt); font-style:italic; max-width:280px; }
"""


def _verdict_table_html(cells: list[dict], L: dict, has_asr: bool) -> str:
    if has_asr:
        rows = sorted(cells, key=lambda c: (c["similarity"] if c["similarity"] is not None else -1), reverse=True)
        head = (f"<th>{L['col_cell']}</th><th>{L['col_transformer']}</th>"
                f"<th>{L['col_steps']}</th><th>{L['col_prompt']}</th>"
                f"<th>{L['col_heard']}</th><th>{L['col_match']}</th>")
        body = []
        for c in rows:
            gcls, glabel = _grade(c["similarity"], L)
            tag = L["tag_opt"] if c["tag"] == "opt" else (L["tag_orig"] if c["tag"] == "orig" else c["tag"])
            match = f"{c['similarity']:.0f}% · {c['word_hits']}" if c["similarity"] is not None else "—"
            body.append(
                f"<tr><td>{html.escape(c['label'])}</td><td>{html.escape(c['transformer'])}</td>"
                f"<td class='num'>{html.escape(c['steps'])}</td><td>{html.escape(tag)}</td>"
                f"<td class='heard-cell'>{html.escape(c['transcript']) or '—'}</td>"
                f"<td><span class='badge {gcls}'>{match}</span></td></tr>"
            )
    else:
        rows = sorted(cells, key=lambda c: c["flatness"])
        head = (f"<th>{L['col_cell']}</th><th>{L['col_transformer']}</th>"
                f"<th>{L['col_steps']}</th><th>{L['col_prompt']}</th>"
                f"<th>{L['col_flatness']}</th><th>ZCR</th>")
        body = []
        for c in rows:
            tag = L["tag_opt"] if c["tag"] == "opt" else (L["tag_orig"] if c["tag"] == "orig" else c["tag"])
            body.append(
                f"<tr><td>{html.escape(c['label'])}</td><td>{html.escape(c['transformer'])}</td>"
                f"<td class='num'>{html.escape(c['steps'])}</td><td>{html.escape(tag)}</td>"
                f"<td class='num'>{c['flatness']:.3f}</td><td class='num'>{c['zcr']:.3f}</td></tr>"
            )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def _card_html(c: dict, L: dict, has_asr: bool) -> str:
    tag = L["tag_opt"] if c["tag"] == "opt" else (L["tag_orig"] if c["tag"] == "orig" else c["tag"])
    poster = f' poster="{html.escape(c["png"])}"' if c["png"] else ""
    src = html.escape(os.path.basename(c["mp4"]))
    ncls = "noise" if c["is_noise"] else "speech"
    nverdict = L["noise"] if c["is_noise"] else L["speech"]

    heard = ""
    if has_asr:
        gcls, glabel = _grade(c["similarity"], L)
        match = f"{c['similarity']:.0f}% · {c['word_hits']}" if c["similarity"] is not None else L["asr_failed"]
        heard = (
            f'<div class="heard"><span class="mut">{L["heard_label"]}:</span> '
            f'<span class="quote">{html.escape(c["transcript"]) or "—"}</span> '
            f'<span class="badge {gcls}">{glabel} · {match}</span></div>'
        )

    return (
        f'<div class="card">'
        f'<div class="card-meta"><span class="label">{html.escape(c["label"])}</span>'
        f'<span class="tag">{html.escape(tag or c["transformer"])}</span></div>'
        f'<video controls preload="none" playsinline{poster} src="{src}"></video>'
        f'{heard}'
        f'<div class="metrics">'
        f'<span class="badge {ncls}">{nverdict}</span>'
        f'<span class="mval">{L["col_flatness"]} <b>{c["flatness"]:.3f}</b></span>'
        f'<span class="mval">ZCR <b>{c["zcr"]:.3f}</b></span>'
        f'<span class="mval">RMS <b>{c["rms"]:.5f}</b></span>'
        f'</div></div>'
    )


def _build_html(cells: list[dict], lang: str, title: str, target: str, out_path: str, has_asr: bool) -> str:
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
    if has_asr:
        print(f"\n=== Voice verdict (target phrase: {target!r}) — sorted by match% ===")
        print(f"{'cell':<20}{'tf':<8}{'st':<5}{'tag':<6}{'match':<8}{'hits':<6}heard")
        for c in sorted(cells, key=lambda c: (c["similarity"] if c["similarity"] is not None else -1), reverse=True):
            s = f"{c['similarity']:.0f}%" if c["similarity"] is not None else "—"
            print(f"{c['label']:<20}{c['transformer']:<8}{c['steps']:<5}{c['tag']:<6}{s:<8}{c['word_hits']:<6}{c['transcript']!r}")
    else:
        print("\n=== Voice verdict (flatness-only; lower = more speech-like) ===")
        print(f"{'cell':<22}{'transformer':<12}{'steps':<7}{'tag':<8}{'flatness':<10}{'zcr':<9}verdict")
        for c in sorted(cells, key=lambda c: c["flatness"]):
            print(f"{c['label']:<22}{c['transformer']:<12}{c['steps']:<7}{c['tag']:<8}"
                  f"{c['flatness']:<10.3f}{c['zcr']:<9.3f}{'NOISE' if c['is_noise'] else 'speech'}")


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
    has_asr = _score_asr(cells, args.asr_model, args.target, use_asr=not args.no_asr)
    _print_verdict(cells, args.target, has_asr)

    base = os.path.splitext(os.path.basename(args.runs))[0].lstrip(".")
    out_en = args.out_en or os.path.join(PROJECT_DIR, "output", f"review_{base}_en.html")
    out_zh = args.out_zh or os.path.join(PROJECT_DIR, "output", f"review_{base}_zh.html")
    title_en = args.title_en or "Voice review"
    title_zh = args.title_zh or "語音評測"

    for lang, title, out_path in (("en", title_en, out_en), ("zh_TW", title_zh, out_zh)):
        print(f"  📄 [{lang}] {_build_html(cells, lang, title, args.target, out_path, has_asr)}")

    print(f"\nDone. {len(cells)} cells · open {out_en} (or _zh.html) to listen.")


if __name__ == "__main__":
    main()
