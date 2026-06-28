import json
import os
import subprocess
import glob
import base64

CONFIG_PATH = "benchmarks/image_gen_compare/config.json"
RAW_OUTPUT_BASE = "benchmarks/image_gen_compare/raw_output"
REPORT_PATH = "benchmarks/image_gen_compare/analysis/reports/benchmark_report.html"
SWIFT_METRICS = ["swift", "run", "--package-path", "swift/image-gen-utils", "image-gen-utils", "metrics"]
REPO_ROOT = os.path.abspath(".")

def run_swift_metrics(img1, img2, width, height):
    cmd = SWIFT_METRICS + [img1, img2, "--width", str(width), "--height", str(height)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        output = result.stdout
        start = output.find("{")
        end = output.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(output[start:end])
    except Exception as e:
        print(f"  metrics error: {e}")
    return {"ssim": 0.0, "psnr": 0.0, "mse": 0.0}

def load_score(test_id, system):
    """Load score JSON — prefer Swift .score.json, fall back to Python .caption.json."""
    base = os.path.join(RAW_OUTPUT_BASE, test_id, system, f"result_{test_id}")
    # Swift score JSON (flat: overall/detail/sharpness/...)
    for ext in [".score.json"]:
        p = base + ext
        if os.path.exists(p):
            with open(p) as f:
                data = json.load(f)
            # Swift score JSON is already the flat score object
            return _normalize_score(data)
    # Python caption.json (nested: .styles.score.caption is a JSON string)
    p = base + ".caption.json"
    if os.path.exists(p):
        with open(p) as f:
            data = json.load(f)
        return _normalize_caption(data)
    return None

def _normalize_score(data):
    """Swift score JSON — already flat."""
    out = {}
    for k in ["overall","detail","sharpness","composition","promptAdherence","prompt_adherence","artifacts"]:
        if k in data:
            key = "promptAdherence" if k.startswith("prompt") else k
            out[key] = data[k]
    out["summary"] = data.get("summary","")
    out["issues"] = data.get("issues",[])
    out["strengths"] = data.get("strengths",[])
    return out

def _normalize_caption(data):
    """Python caption.json — nested, caption is a JSON string."""
    styles = data.get("styles", {})
    score_style = styles.get("score", {})
    raw = score_style.get("caption", "")
    if not raw:
        return None
    try:
        inner = json.loads(raw)
        return _normalize_score(inner)
    except:
        return None

def main():
    with open(CONFIG_PATH) as f:
        config = json.load(f)

    results = []
    for test in config["tests"]:
        test_id = test["id"]
        print(f"=== {test_id}: {test['name']} ===")
        swift_img = os.path.join(RAW_OUTPUT_BASE, test_id, "swift", f"result_{test_id}.png")
        python_img = os.path.join(RAW_OUTPUT_BASE, test_id, "python", f"result_{test_id}.png")
        if not (os.path.exists(swift_img) and os.path.exists(python_img)):
            print("  SKIP — missing images"); continue

        print(f"  metrics (Swift Accelerate)...")
        metrics = run_swift_metrics(swift_img, python_img, test["width"], test["height"])
        print(f"  SSIM={metrics['ssim']:.4f}  PSNR={metrics['psnr']:.2f}dB  MSE={metrics['mse']:.4f}")

        swift_score = load_score(test_id, "swift")
        python_score = load_score(test_id, "python")

        results.append({
            "id": test_id, "name": test["name"], "desc": test.get("desc",""),
            "width": test["width"], "height": test["height"],
            "metrics": metrics,
            "swift": {"path": swift_img, "score": swift_score},
            "python": {"path": python_img, "score": python_score},
        })

    generate_html(results)
    print(f"\n✅ Report: {REPORT_PATH}")

def img_data_uri(path, max_dim=768):
    """Read image, optionally downscale large images, return base64 data URI."""
    try:
        with open(path, 'rb') as f:
            raw = f.read()
        # Quick size guard: if >2MB, downscale via sips (macOS built-in)
        if len(raw) > 1_500_000:
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
                tmp_path = tmp.name
            subprocess.run(['sips', '-Z', str(max_dim), path, '--out', tmp_path],
                           capture_output=True, timeout=30)
            with open(tmp_path, 'rb') as f:
                raw = f.read()
            os.unlink(tmp_path)
        ext = os.path.splitext(path)[1].lstrip('.').lower()
        mime = 'jpeg' if ext in ('jpg','jpeg') else 'png'
        b64 = base64.b64encode(raw).decode('ascii')
        return f"data:image/{mime};base64,{b64}"
    except Exception as e:
        print(f"  img embed error ({path}): {e}")
        return ""

def generate_html(results):
    def score_tags(score):
        if not score: return "<span class='tag dim'>no score</span>"
        tags = ""
        for k in ["overall","detail","sharpness","composition","promptAdherence","artifacts"]:
            v = score.get(k)
            if v is not None:
                cls = "good" if (isinstance(v,(int,float)) and v>=7) else ("mid" if isinstance(v,(int,float)) and v>=5 else "low")
                tags += f"<span class='tag {cls}'>{k}: <b>{v}</b></span>"
        return tags

    def score_summary(score):
        if not score: return ""
        s = score.get("summary","")
        issues = score.get("issues",[])
        html = ""
        if s: html += f"<p class='sum'>{s}</p>"
        if issues: html += f"<p class='issues'>⚠ {'; '.join(issues[:3])}</p>"
        return html

    html = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmark: Swift zimage vs Python mlx</title>
<style>
*{{box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:linear-gradient(180deg,#0d1117,#010409);color:#c9d1d9;line-height:1.6;min-height:100vh}}
header{{padding:36px 32px 24px;background:linear-gradient(135deg,#1f6feb22,#23863611);border-bottom:1px solid #30363d}}
h1{{margin:0;font-size:26px;background:linear-gradient(90deg,#58a6ff,#3fb950);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}}
h1 code{{-webkit-text-fill-color:#79c0ff;background:#21262d;padding:2px 8px;border-radius:6px}}
.sub{{margin:12px 0 0;color:#8b949e;font-size:13px}}
.sub code{{background:#21262d;padding:2px 6px;border-radius:4px;color:#79c0ff}}
.summary-wrap{{padding:24px 32px}}
.summary-wrap h2{{color:#c9d1d9;font-size:18px;margin:0 0 16px}}
table{{width:100%;border-collapse:collapse;background:#161b22;border-radius:12px;overflow:hidden;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.3)}}
th,td{{padding:14px 16px;text-align:left;border-bottom:1px solid #21262d}}
th{{background:#21262d;color:#58a6ff;font-size:11px;text-transform:uppercase;letter-spacing:.8px}}
tr:hover td{{background:#1c2128}}
tr:last-child td{{border-bottom:none}}
.good{{color:#3fb950}}.mid{{color:#d29922}}.low{{color:#f85149}}
.metric-good{{color:#3fb950;font-weight:700}}.metric-mid{{color:#d29922;font-weight:700}}.metric-low{{color:#f85149;font-weight:700}}
.test{{margin:0 32px 32px;padding:28px;background:#161b22;border-radius:16px;border:1px solid #30363d;box-shadow:0 8px 24px rgba(0,0,0,.2);transition:border-color .2s,transform .2s}}
.test:hover{{border-color:#388bfd66;transform:translateY(-2px)}}
.test h2{{margin:0 0 4px;color:#58a6ff;font-size:19px}}
.test .meta{{color:#8b949e;font-size:12px;margin-bottom:16px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px}}
@media(max-width:900px){{.grid{{grid-template-columns:1fr}}}}
.card{{background:#0d1117;border-radius:12px;padding:16px;border:1px solid #21262d;transition:border-color .2s}}
.card:hover{{border-color:#2f81f7}}
.card h3{{margin:0 0 12px;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:.8px}}
.card img{{width:100%;border-radius:10px;display:block;margin-bottom:12px;box-shadow:0 4px 12px rgba(0,0,0,.4);transition:transform .2s}}
.card img:hover{{transform:scale(1.02)}}
.scores{{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}}
.tag{{background:#21262d;padding:4px 10px;border-radius:12px;font-size:11px;white-space:nowrap}}
.tag b{{color:#c9d1d9}}.tag.dim{{color:#484f58}}.tag.good{{background:#23863622}}.tag.good b{{color:#3fb950}}.tag.mid{{background:#bb800922}}.tag.mid b{{color:#d29922}}.tag.low{{background:#da363322}}.tag.low b{{color:#f85149}}
.sum{{font-size:12px;color:#8b949e;margin:8px 0;font-style:italic;line-height:1.5}}
.issues{{font-size:11px;color:#f85149;margin:6px 0;line-height:1.5}}
.metrbar{{display:flex;gap:10px;margin:14px 0;flex-wrap:wrap}}
.metrbar .tag{{background:#1f6feb22;border:1px solid #1f6feb44;color:#79c0ff}}
.metrbar .tag b{{color:#58a6ff}}
footer{{padding:24px 32px 48px;color:#484f58;font-size:12px;text-align:center}}
</style></head><body>
<header>
<h1>🔬 Benchmark: Swift <code>zimage</code> vs Python <code>mlx-movie-director</code></h1>
<p class="sub">Same transformer (<b>moody-pro-mix</b>) · identical prompt &amp; seed (<b>42</b>) · CFG off on both sides (Swift <code>--cfg-scale 1.0</code>)<br>
Structural metrics via Swift <code>Accelerate</code> (SSIM/PSNR/MSE) · Quality scores via Qwen3-VL <code>image-gen-utils score</code> · Images embedded base64 (portable)</p>
</header>
<div class="summary-wrap"><table>
<tr><th>ID</th><th>Scenario</th><th>Resolution</th><th>SSIM ↑</th><th>PSNR ↑</th><th>MSE ↓</th><th>Swift overall</th><th>Python overall</th></tr>
"""
    for r in results:
        m = r["metrics"]
        s = m["ssim"]
        cls = "metric-good" if s>0.98 else ("metric-mid" if s>0.9 else "metric-low")
        so = r["swift"]["score"].get("overall","—") if r["swift"]["score"] else "—"
        po = r["python"]["score"].get("overall","—") if r["python"]["score"] else "—"
        html += f"<tr><td><b>{r['id']}</b></td><td>{r['name']}</td><td>{r['width']}×{r['height']}</td>"
        html += f"<td class='{cls}'>{s:.4f}</td><td>{m['psnr']:.2f}</td><td>{m['mse']:.4f}</td>"
        html += f"<td>{so}</td><td>{po}</td></tr>\n"

    html += "</table></div>\n"

    for r in results:
        m = r["metrics"]
        html += f"""<div class="test">
<h2>{r['id']}: {r['name']}</h2>
<div class="meta">{r['desc']} — {r['width']}×{r['height']}</div>
<div class="metrbar">
<span class="tag">SSIM: <b>{m['ssim']:.4f}</b></span>
<span class="tag">PSNR: <b>{m['psnr']:.2f} dB</b></span>
<span class="tag">MSE: <b>{m['mse']:.4f}</b></span>
</div>
<div class="grid">
<div class="card"><h3>⚡ Swift (zimage)</h3>
<img src="{img_data_uri(r['swift']['path'])}">
<div class="scores">{score_tags(r['swift']['score'])}</div>
{score_summary(r['swift']['score'])}
</div>
<div class="card"><h3>🐍 Python (mlx)</h3>
<img src="{img_data_uri(r['python']['path'])}">
<div class="scores">{score_tags(r['python']['score'])}</div>
{score_summary(r['python']['score'])}
</div>
</div></div>\n"""

    html += "<footer>Generated by benchmarks/run_analysis.py · Swift Accelerate + Qwen3-VL · images embedded as base64</footer>\n"
    html += "</body></html>"
    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(html)

if __name__ == "__main__":
    main()
