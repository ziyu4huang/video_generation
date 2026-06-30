#!/usr/bin/env python3
"""gen-results-html.py — build a self-contained HTML report embedding the
scene/regional test outputs (base64) + the local-LLM verdicts/scores."""
import base64, json, os, html

BASE = "/Users/huangziyu/proj/video_generation/swift/flux2-image-director/test_cases"


def b64img(rel):
    p = os.path.join(BASE, rel)
    if not p.endswith(".png"):
        p += ".png"
    if not os.path.exists(p):
        return None
    with open(p, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


def score(rel):
    p = os.path.join(BASE, rel + ".caption.json")
    if not os.path.exists(p):
        return None
    import re
    d = json.load(open(p))
    m = re.search(r"\{.*\}", d.get("caption", ""), re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


def imgdims(rel):
    from PIL import Image
    p = os.path.join(BASE, rel + ".png")
    if os.path.exists(p):
        w, h = Image.open(p).size
        return f"{w}×{h}"
    return "?"


def card(title, rel, note=""):
    img = b64img(rel)
    sc = score(rel)
    body = []
    dims = imgdims(rel)
    if img:
        body.append(f'<div class="imgwrap"><img src="{img}"></div>')
        body.append(f'<div class="dims">true size: {dims}</div>')
    else:
        body.append('<div class="missing">(image not found)</div>')
    if sc:
        body.append(
            f'<div class="score">overall:{sc.get("overall")} '
            f'artifacts:{sc.get("artifacts")} '
            f'adherence:{sc.get("prompt_adherence")}'
            f'{(" — "+sc["issues"][0]) if sc.get("issues") else ""}</div>'
        )
    if note:
        body.append(f'<div class="note">{html.escape(note)}</div>')
    return f'<div class="card"><h3>{html.escape(title)}</h3>{"".join(body)}</div>'


css = """
body{font-family:-apple-system,sans-serif;background:#1a1a1a;color:#eee;margin:20px}
h2{border-bottom:1px solid #444;padding-bottom:4px;margin-top:30px}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.card{background:#262626;border:1px solid #444;border-radius:8px;padding:10px;width:300px}
.card h3{margin:0 0 8px;font-size:14px;color:#8cf}
.card .imgwrap{width:280px;height:280px;display:flex;align-items:center;justify-content:center;background:#111;border:1px solid #333;border-radius:4px;overflow:hidden}
.card img{width:100%;height:100%;object-fit:contain;display:block}
.card .dims{font-size:10px;color:#888;margin-top:4px;text-align:center}
.score{font-size:12px;color:#fc6;margin-top:6px}
.note{font-size:11px;color:#999;margin-top:4px}
.missing{color:#f66;padding:20px;text-align:center}
table{border-collapse:collapse;margin:10px 0}
td,th{border:1px solid #555;padding:5px 10px;font-size:13px}
.verdict{background:#332;padding:8px;border-radius:6px;font-family:monospace;font-size:12px;margin:8px 0}
"""

rows = []
rows.append("<h1>flux2 scene / regional — local-LLM test results</h1>")
rows.append("<p>2026-06-30 · verified with run.py caption (gemma-4-26b) + qwen3-vl-4b · no MCP</p>")

rows.append("<h2>Placement verdict (qwen3-vl-4b direct)</h2>")
rows.append('<div class="verdict">All runs: <b>LEFT = pink hair / RIGHT = teal hair</b> — placement correct on '
            "every seed (baseline s42/77/123 + regional), closeup AND full-body.</div>")

rows.append('<table><tr><th>run</th><th>overall</th><th>artifacts</th><th>adherence</th></tr>')
for label, rel in [
    ("baseline s42", "fullbody/scene_base_s42"),
    ("baseline s77", "fullbody/scene_base_s77"),
    ("baseline s123", "fullbody/scene_base_s123"),
    ("regional", "fullbody/scene_regional_fb"),
]:
    sc = score(rel) or {}
    rows.append(f'<tr><td>{label}</td><td>{sc.get("overall","?")}</td>'
                f'<td>{sc.get("artifacts","?")}</td><td>{sc.get("prompt_adherence","?")}</td></tr>')
rows.append("</table>")
rows.append("<p><b>Finding:</b> --regional is net-negative (artifacts 3 vs base-best 9; "
            "ghosting + fused fingers). Baseline placement reliable across seeds. "
            "Hands are the real ceiling (platform artifact).</p>")

rows.append("<h2>Test 1 — closeup 2-person (head-shot refs)</h2>")
rows.append('<div class="row">')
rows.append(card("ref A — pink hair", "regional/refA_pink"))
rows.append(card("ref B — teal hair", "regional/refB_teal"))
rows.append(card("baseline (no --regional)", "regional/scene_baseline"))
rows.append(card("--regional", "regional/scene_regional"))
rows.append("</div>")

rows.append("<h2>Test 2 — full-body (hands stress, small face proportion)</h2>")
rows.append('<div class="row">')
rows.append(card("ref A — pink, hands on hips", "fullbody/refA_pink_fb"))
rows.append(card("ref B — teal, arms crossed", "fullbody/refB_teal_fb"))
rows.append(card("baseline s42", "fullbody/scene_base_s42"))
rows.append(card("baseline s77", "fullbody/scene_base_s77"))
rows.append(card("baseline s123 (best)", "fullbody/scene_base_s123"))
rows.append(card("--regional (worst)", "fullbody/scene_regional_fb", "ghosting + fused fingers"))
rows.append("</div>")

rows.append('<p style="color:#888;margin-top:30px;font-size:11px">Reproduce: '
            '<code>bash scripts/regional-placement-test.sh &amp;&amp; bash scripts/fullbody-stress-test.sh</code>. '
            "Outputs gitignored (regenerable). See TEST-CASES.md.</p>")

out = "/Users/huangziyu/proj/video_generation/swift/flux2-image-director/test_cases/results-report-v2.html"
with open(out, "w") as f:
    f.write(f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style>"
            f"</head><body>{''.join(rows)}</body></html>")
print("wrote", out, f"({os.path.getsize(out)//1024} KB)")
