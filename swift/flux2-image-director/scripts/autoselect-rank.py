#!/usr/bin/env python3
"""autoselect-rank.py — verify placement (qwen3-vl-4b) + read gemma scores,
rank seeds, write a self-contained HTML gallery with the winner highlighted.

Usage: autoselect-rank.py <OUT_DIR> <seed1> <seed2> ...
"""
import base64, json, os, re, sys, urllib.request, html

VLM = "http://localhost:1234/v1/chat/completions"
EXPECT = "pink LEFT / teal RIGHT"


def b64(p):
    with open(p, "rb") as f:
        return base64.b64encode(f.read()).decode()


def placement(path):
    q = ("Two women side by side. Reply EXACTLY one line:\n"
         "LEFT=<pink|teal> RIGHT=<pink|teal> HANDS=<ok|bad>")
    payload = {"model": "qwen/qwen3-vl-4b", "messages": [{"role": "user", "content": [
        {"type": "text", "text": q},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64(path)}"}},
    ]}], "max_tokens": 60, "temperature": 0.1}
    req = urllib.request.Request(VLM, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip().lower()


def score(path):
    cap = path[:-4] if path.endswith(".png") else path
    d = json.load(open(cap + ".caption.json"))
    m = re.search(r"\{.*\}", d.get("caption", ""), re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except Exception:
        return {}


def main():
    out = sys.argv[1]
    seeds = sys.argv[2:]
    rows = []
    for s in seeds:
        p = os.path.join(out, f"seed_{s}.png")
        if not os.path.exists(p):
            continue
        pl = placement(p)
        sc = score(p)
        correct = ("left" in pl and "pink" in pl.split("left")[1].split("right")[0]
                   and "teal" in pl.split("right")[1])
        rows.append({"seed": s, "path": p, "place": pl, "correct": correct,
                     "overall": sc.get("overall", 0), "artifacts": sc.get("artifacts", 0),
                     "adherence": sc.get("prompt_adherence", 0),
                     "issue": (sc.get("issues") or [""])[0]})
    # rank: correct placement first, then artifacts desc, then overall desc
    rows.sort(key=lambda r: (not r["correct"], -r["artifacts"], -r["overall"]))
    winner = rows[0] if rows else None

    css = ("body{font-family:-apple-system,sans-serif;background:#1a1a1a;color:#eee;margin:20px}"
           ".card{display:inline-block;vertical-align:top;background:#262626;border:1px solid #444;"
           "border-radius:8px;padding:10px;margin:8px;width:280px}"
           ".card.win{border:2px solid #6e6;background:#2a3a2a}"
           ".card h3{margin:0 0 6px;font-size:13px;color:#8cf}"
           ".card.win h3{color:#6e6}"
           ".imgwrap{width:260px;height:260px;display:flex;align-items:center;justify-content:center;background:#111;border-radius:4px;overflow:hidden}"
           ".imgwrap img{width:100%;height:100%;object-fit:contain}"
           ".meta{font-size:11px;color:#aaa;margin-top:5px;line-height:1.5}"
           ".ok{color:#6e6}.bad{color:#f88}")

    parts = [f"<h1>flux2 multi-ref — multi-seed auto-select</h1>",
             f"<p>Expect: <b>{EXPECT}</b>. Rank = placement-correct first, then artifacts, then overall. "
             f"Verified by local LLM (qwen3-vl-4b placement + gemma-4-26b score). No MCP.</p>"]
    if winner:
        parts.append(f"<h2 style='color:#6e6'>★ WINNER: seed {winner['seed']} "
                     f"(artifacts {winner['artifacts']}, adherence {winner['adherence']})</h2>")
    parts.append("<div>")
    for r in rows:
        cls = "card win" if r is winner else "card"
        tag = "<span class='ok'>placement OK</span>" if r["correct"] else "<span class='bad'>placement WRONG</span>"
        parts.append(
            f'<div class="{cls}"><h3>{"★ " if r is winner else ""}seed {r["seed"]}</h3>'
            f'<div class="imgwrap"><img src="data:image/png;base64,{b64(r["path"])}"></div>'
            f'<div class="meta">{tag}<br>overall:{r["overall"]} artifacts:{r["artifacts"]} '
            f'adherence:{r["adherence"]}<br>VLM: {html.escape(r["place"])}'
            f'{("<br>"+html.escape(r["issue"])) if r["issue"] else ""}</div></div>')
    parts.append("</div>")
    parts.append("<p style='color:#666;margin-top:20px;font-size:11px'>"
                 "Improvement: instead of --regional (architecturally fights global-ref tokens → "
                 "ghosting/bad hands), exploit that prompt placement is reliable-but-probabilistic "
                 "by sweeping seeds and keeping the LLM-verified-correct best.</p>")

    htmlpath = os.path.join(out, "autoselect-report.html")
    with open(htmlpath, "w") as f:
        f.write(f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style>"
                f"</head><body>{''.join(parts)}</body></html>")

    print(f"ranked {len(rows)} seeds:")
    for r in rows:
        print(f"  {'★' if r is winner else ' '} seed {r['seed']}: "
              f"{'OK ' if r['correct'] else 'WRONG'} artifacts={r['artifacts']} "
              f"overall={r['overall']}  ({r['place']})")
    print(f"\nwinner: seed {winner['seed']}" if winner else "no seeds")
    print(f"HTML: {htmlpath}")


if __name__ == "__main__":
    main()
