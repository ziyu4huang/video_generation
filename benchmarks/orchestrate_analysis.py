import json
import os
import subprocess
import cv2
import numpy as np
from skimage.metrics import structural_similarity as ssim

CONFIG_PATH = "benchmarks/image_gen_compare/config.json"
RAW_OUTPUT_BASE = "benchmarks/image_gen_compare/raw_output"
REPORT_PATH = "benchmarks/image_gen_compare/analysis/reports/benchmark_report.html"
PYTHON_ENV = "python/venv/bin/python"

def run_caption(image_path):
    """Runs the caption tool and returns the parsed JSON results."""
    cmd = [PYTHON_ENV, "python/mlx-movie-director/run.py", "caption", image_path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        # Check if the JSON file exists as the tool likely writes it to the same dir
        json_path = image_path.rsplit('.', 1)[0] + ".caption.json"
        if os.path.exists(json_path):
            with open(json_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        else:
            print(f"Warning: Caption file {json_path} not found for {image_path}")
            return None
    except Exception as e:
        print(f"Error captioning {image_path}: {e}")
        return None

def compute_metrics(img1_path, img2_path):
    img1 = cv2.imread(img1_path)
    img2 = cv2.imread(img2_path)

    if img1 is None or img2 is None:
        return None

    # Resize img2 to match img1 for SSIM/PSNR if necessary
    if img1.shape != img2.shape:
        img2 = cv2.resize(img2, (img1.shape[1], img1.shape[0]))

    img1_gray = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY)
    img2_gray = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY)

    ssim_val = ssim(img1_gray, img2_gray)
    psnr_val = cv2.PSNR(img1, img2)
    mse_val = np.mean((img1.astype(np.float32) - img2.astype(np.float32))**2)

    return {
        "ssim": round(float(ssim_val), 4),
        "psnr": round(float(psnr_val), 2),
        "mse": round(float(mse_val), 2)
    }

def main():
    if not os.path.exists(CONFIG_PATH):
        print(f"Config not found: {CONFIG_PATH}")
        return

    with open(CONFIG_PATH, "r") as f:
        config = json.load(f)

    results = []
    test_cases = config["tests"]

    for test in test_cases:
        test_id = test["id"]
        print(f"Processing Test Case: {test_id}")
        
        swift_img_path = os.path.join(RAW_OUTPUT_BASE, test_id, "swift", f"result_{test_id}.png")
        python_img_path = os.path.join(RAW_OUTPUT_BASE, test_id, "python", f"result_{test_id}.png")

        if not os.path.exists(swift_img_path) or not os.path.exists(python_img_path):
            print(f"Skipping {test_id}: Image files missing.")
            continue

        metrics = compute_metrics(swift_img_path, python_img_path)
        if not metrics:
            print(f"Skipping {test_id}: Metric computation failed.")
            continue

        # Captions
        swift_caption = run_caption(swift_img_path)
        python_caption = run_caption(python_img_path)

        results.append({
            "id": test_id,
            "name": test["name"],
            "metrics": metrics,
            "swift": {
                "path": swift_img_path,
                "caption": swift_caption
            },
            "python": {
                "path": python_img_path,
                "caption": python_caption
            }
        })

    generate_html_report(results, test_cases)

def generate_html_report(results, test_cases):
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Benchmark Report: Swift vs Python</title>
        <style>
            body {{ font-family: sans-serif; margin: 40px; background-color: #f4f4f9; }}
            h1 {{ color: #333; }}
            h2 {{ color: #555; border-bottom: 2px solid #333; padding-bottom: 10px; }}
            table {{ width: 100%; border-collapse: collapse; margin: 20px 0; background: #fff; }}
            th, td {{ border: 1px solid #ddd; padding: 12px; text-align: left; }}
            th {{ background-color: #333; color: white; }}
            .comparison-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 40px; }}
            .card {{ background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }}
            .img-container {{ text-align: center; }}
            .img-container img {{ max-width: 100%; border-radius: 4px; }}
            .metric-tag {{ display: inline-block; padding: 4px 8px; background: #eee; border-radius: 4px; margin-right: 5px; font-size: 0.9em; }}
            .caption {{ font-style: italic; color: #666; font-size: 0.9em; margin-top: 10px; }}
            .summary {{ background: #e7f3ff; padding: 20px; border-radius: 8px; margin-bottom: 30px; }}
        </style>
    </head>
    <body>
        <h1>Benchmark Report: Swift vs Python Image Generation</h1>
        
        <div class="summary">
            <h2>Summary Table</h2>
            <table>
                <tr>
                    <th>Test ID</th>
                    <th>Scenario</th>
                    <th>SSIM (↑)</th>
                    <th>PSNR (↑)</th>
                    <th>MSE (↓)</th>
                </tr>
    """

    for r in results:
        html += f"""
                <tr>
                    <td>{r['id']}</td>
                    <td>{r['name']}</td>
                    <td>{r['metrics']['ssim']}</td>
                    <td>{r['metrics']['psnr']}</td>
                    <td>{r['metrics']['mse']}</td>
                </tr>
        """

    html += """
            </table>
        </div>

        <h2>Detailed Comparisons</h2>
    """

    for r in results:
        html += f"""
        <div class="test-section">
            <h3>{r['id']}: {r['name']}</h3>
            <div class="comparison-grid">
                <div class="card">
                    <div class="img-container">
                        <strong>Swift (zimage)</strong><br><br>
                        <img src="{r['swift']['path']}" alt="Swift result">
                    </div>
                    <div class="caption">
                        <strong>Caption:</strong> {json.dumps(r['swift']['caption'], indent=None) if r['swift']['caption'] else 'N/A'}
                    </div>
                </div>
                <div class="card">
                    <div class="img-container">
                        <strong>Python (mlx)</strong><br><br>
                        <img src="{r['python']['path']}" alt="Python result">
                    </div>
                    <div class="caption">
                        <strong>Caption:</strong> {json.dumps(r['python']['caption'], indent=None) if r['python']['caption'] else 'N/A'}
                    </div>
                </div>
            </div>
            <div class="card">
                <strong>Structural Metrics:</strong><br>
                <span class="metric-tag">SSIM: {r['metrics']['ssim']}</span>
                <span class="metric-tag">PSNR: {r['metrics']['psnr']}</span>
                <span class="metric-tag">MSE: {r['metrics']['mse']}</span>
            </div>
        </div>
        """

    html += """
        </body>
        </html>
    """

    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Report generated: {REPORT_PATH}")

if __name__ == "__main__":
    main()
