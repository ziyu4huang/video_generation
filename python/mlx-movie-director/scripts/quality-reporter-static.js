// quality-reporter-static.js — static Bun HTTP server + HTML template for quality reports
// This file is appended verbatim after the generated CONFIG block.
// Do NOT reference CONFIG here with const/let — it is declared in the prepended block.

// ---------------------------------------------------------------------------
// i18n — all UI strings in both languages
// ---------------------------------------------------------------------------

const I18N = {
  en: {
    // Page
    pageTitle: "Video Quality Analysis",
    selfTestTitle: "Quality Self-Test",
    seed: "Seed",

    // Sections
    summary: "Summary",
    comparison: "Comparison",
    perFrame: "Per-Frame Metrics",
    metricsGuide: "Metrics Guide",

    // Table
    metric: "Metric",
    winner: "Winner",

    // Summary card
    frames: "frames",

    // Metrics guide — detailed per-metric help
    sharpness: {
      name: "Sharpness (Laplacian σ²)",
      direction: "higher",
      directionLabel: "↑ higher is better",
      summary: "Measures image clarity and edge definition.",
      detail: "The Laplacian operator computes the second spatial derivative, detecting edges and fine details. The variance of the Laplacian across the frame reflects how many sharp edges exist. Higher values indicate sharper, more detailed images; low values suggest blurriness, defocus, or excessive smoothing.",
      range: "Typical: 100–800 for generated video. Below 150 = blurry; above 500 = very sharp.",
      method: "cv2.Laplacian(gray, cv2.CV_64F).var()",
    },
    noise_sigma: {
      name: "Noise (MAD σ)",
      direction: "lower",
      directionLabel: "↓ lower is better",
      summary: "Estimates random pixel noise level.",
      detail: "Uses the Median Absolute Deviation (MAD) of the Laplacian output as a robust noise estimator. Unlike standard deviation, MAD is resistant to edges — it measures the background noise floor without being inflated by legitimate image edges. Multiplied by 1.4826 (scaling factor for Gaussian equivalence).",
      range: "Typical: 2–20. Below 5 = very clean; above 15 = noticeable grain/noise.",
      method: "median(|Lap − median(Lap)|) × 1.4826",
    },
    snr_db: {
      name: "SNR (dB)",
      direction: "higher",
      directionLabel: "↑ higher is better",
      summary: "Signal-to-Noise Ratio — content vs. noise.",
      detail: "Compares the average signal brightness (mean pixel intensity) to the estimated noise level. Computed as 20·log10(mean_signal / noise_sigma). Higher SNR means the actual image content dominates over random noise. Very sensitive to the noise estimate quality.",
      range: "Typical: 10–40 dB. Above 30 dB = clean; below 15 dB = noisy.",
      method: "20 × log10(mean(gray) / noise_sigma)",
    },
    blockiness: {
      name: "Blockiness (8×8)",
      direction: "lower",
      directionLabel: "↓ lower is better",
      summary: "Detects compression artifacts at 8×8 block boundaries.",
      detail: "DCT-based video codecs (H.264, H.265, VP9) compress frames in 8×8 pixel blocks. At higher compression, discontinuities appear at block boundaries. This metric measures the average absolute pixel difference at block edges — both horizontal and vertical. Lower values indicate cleaner compression.",
      range: "Typical: 15–40. Below 20 = imperceptible; above 35 = visible blocking.",
      method: "mean(|diff at 8px boundaries|) for H and V",
    },
    color_sat_std: {
      name: "Color Saturation σ",
      direction: "neutral",
      directionLabel: "— contextual",
      summary: "Color saturation variation across the frame.",
      detail: "Standard deviation of the HSV saturation channel. Measures how varied the color intensity is across the frame. This is contextual — high values indicate vivid, diverse colors (common in anime/stylized content); low values indicate a uniform, possibly washed-out palette. Neither direction is inherently better.",
      range: "Typical: 30–80. Above 70 = very vivid; below 30 = muted/grayish.",
      method: "std(HSV saturation channel)",
    },
    flicker_mean: {
      name: "Flicker (mean)",
      direction: "lower",
      directionLabel: "↓ lower is better",
      summary: "Average frame-to-frame brightness instability.",
      detail: "Computes the mean absolute pixel difference between consecutive grayscale frames. High flicker indicates distracting visual pulsing — brightness jumping up and down between frames. Common in under-trained models or low-step distilled pipelines. This is the average across all frame pairs.",
      range: "Typical: 2–15. Below 5 = very stable; above 12 = noticeable pulsing.",
      method: "mean(|gray[t] − gray[t−1]|)",
    },
    flicker_max: {
      name: "Flicker (max)",
      direction: "lower",
      directionLabel: "↓ lower is better",
      summary: "Worst single-frame brightness jump.",
      detail: "The maximum frame-to-frame brightness difference across the entire video. Even with low mean flicker, a single high max-flicker frame can be visually jarring — often caused by scene transitions, flash frames, or denoising artifacts. Useful for detecting outlier frames.",
      range: "Typical: 10–60. Below 20 = smooth; above 40 = visible jump.",
      method: "max(|gray[t] − gray[t−1]|.mean())",
    },
    consistency_ncc: {
      name: "Consistency (NCC)",
      direction: "higher",
      directionLabel: "↑ higher is better",
      summary: "Visual similarity between consecutive frames.",
      detail: "Normalized Cross-Correlation (NCC) between adjacent frames. Measures structural similarity independent of overall brightness changes — two frames with different brightness but identical structure still score high. Ranges from −1 to 1, where 1 = pixel-identical. High consistency indicates smooth, stable temporal progression.",
      range: "Typical: 0.85–0.99. Above 0.95 = very stable; below 0.85 = inconsistent quality.",
      method: "cv2.matchTemplate(frame[t], frame[t−1], TM_CCOEFF_NORMED)",
    },

    // UI elements
    langToggle: "中文",
    showGuide: "Show Metrics Guide",
    hideGuide: "Hide Metrics Guide",
    whatItMeasures: "What it measures",
    interpretation: "Interpretation",
    typicalRange: "Typical range",
    methodLabel: "Method",
  },
  zh_TW: {
    // Page
    pageTitle: "影片品質分析",
    selfTestTitle: "品質自我測試",
    seed: "種子",

    // Sections
    summary: "摘要",
    comparison: "比較",
    perFrame: "逐幀指標",
    metricsGuide: "指標說明",

    // Table
    metric: "指標",
    winner: "勝者",

    // Summary card
    frames: "影格",

    // Metrics guide
    sharpness: {
      name: "清晰度 (Laplacian σ²)",
      direction: "higher",
      directionLabel: "↑ 越高越好",
      summary: "衡量影像清晰度與邊緣銳利度。",
      detail: "Laplacian 算子透過計算二階空間導數來偵測邊緣與細節。其在整個畫面的變異數反映了銳利邊緣的數量。數值越高代表影像越銳利、細節越豐富；低數值表示影像模糊、失焦或過度平滑。",
      range: "典型範圍：100–800。低於 150 = 模糊；超過 500 = 非常銳利。",
      method: "cv2.Laplacian(gray, cv2.CV_64F).var()",
    },
    noise_sigma: {
      name: "雜訊 (MAD σ)",
      direction: "lower",
      directionLabel: "↓ 越低越好",
      summary: "估算隨機像素雜訊等級。",
      detail: "使用 Laplacian 輸出的中位數絕對偏差 (MAD) 作為穩健的雜訊估算器。與標準差不同，MAD 對邊緣具有抗干擾性 — 它測量的是背景雜訊基底，不會被合法的影像邊緣所膨脹。乘以 1.4826（高斯等效縮放因子）。",
      range: "典型範圍：2–20。低於 5 = 非常乾淨；超過 15 = 可見的顆粒/雜訊。",
      method: "median(|Lap − median(Lap)|) × 1.4826",
    },
    snr_db: {
      name: "訊噪比 (dB)",
      direction: "higher",
      directionLabel: "↑ 越高越好",
      summary: "比較影像內容與雜訊的比例。",
      detail: "比較平均訊號亮度（平均像素強度）與估計的雜訊等級。計算公式為 20·log10(平均訊號 / 雜訊標準差)。SNR 越高表示實際影像內容相對隨機雜訊越強。對雜訊估算品質非常敏感。",
      range: "典型範圍：10–40 dB。超過 30 dB = 乾淨；低於 15 dB = 雜訊明顯。",
      method: "20 × log10(mean(gray) / noise_sigma)",
    },
    blockiness: {
      name: "方塊效應 (8×8)",
      direction: "lower",
      directionLabel: "↓ 越低越好",
      summary: "偵測 8×8 區塊邊界的壓縮偽影。",
      detail: "DCT 影片編碼器（H.264、H.265、VP9）以 8×8 像素區塊壓縮影格。在高壓縮率下，區塊邊界會出現不連續性。此指標測量區塊邊緣的平均絕對像素差異（水平和垂直）。數值越低代表壓縮品質越好。",
      range: "典型範圍：15–40。低於 20 = 肉眼不可見；超過 35 = 可見的方塊效應。",
      method: "mean(|8px 邊界差異|) — 水平 + 垂直",
    },
    color_sat_std: {
      name: "色彩飽和度 σ",
      direction: "neutral",
      directionLabel: "— 視情境而定",
      summary: "畫面中色彩飽和度的變化程度。",
      detail: "HSV 色彩空間中飽和度通道的標準差。衡量整個畫面中色彩強度的變化程度。此指標為情境相關 — 高數值表示鮮豔、多樣的色彩（常見於動畫/風格化內容）；低數值表示均勻、可能褪色的色彩。兩個方向都不是絕對更好。",
      range: "典型範圍：30–80。超過 70 = 非常鮮豔；低於 30 = 柔和/灰暗。",
      method: "std(HSV 飽和度通道)",
    },
    flicker_mean: {
      name: "閃爍 (平均)",
      direction: "lower",
      directionLabel: "↓ 越低越好",
      summary: "影格間亮度不穩定的平均值。",
      detail: "計算連續灰階影格之間的平均絕對像素差異。高閃爍值表示令人分心的視覺脈動 — 亮度在影格之間上下跳動。常見於訓練不足的模型或低步數蒸餾管線。這是所有影格對的平均值。",
      range: "典型範圍：2–15。低於 5 = 非常穩定；超過 12 = 明顯的脈動。",
      method: "mean(|gray[t] − gray[t−1]|)",
    },
    flicker_max: {
      name: "閃爍 (最大)",
      direction: "lower",
      directionLabel: "↓ 越低越好",
      summary: "最嚴重的單一影格亮度跳動。",
      detail: "整部影片中影格間亮度差異的最大值。即使平均閃爍很低，單一高最大閃爍影格也可能造成視覺衝擊 — 通常由場景轉換、閃光影格或去雜訊偽影引起。適合用來偵測異常影格。",
      range: "典型範圍：10–60。低於 20 = 平順；超過 40 = 可見的跳動。",
      method: "max(|gray[t] − gray[t−1]|.mean())",
    },
    consistency_ncc: {
      name: "一致性 (NCC)",
      direction: "higher",
      directionLabel: "↑ 越高越好",
      summary: "連續影格之間的視覺相似度。",
      detail: "相鄰影格之間的正規化互相關 (NCC)。衡量結構相似度，不受整體亮度變化影響 — 兩個亮度不同但結構相同的影格仍會得到高分。範圍從 −1 到 1，1 = 像素完全相同。高一致性表示平順、穩定的時序推進。",
      range: "典型範圍：0.85–0.99。超過 0.95 = 非常穩定；低於 0.85 = 品質不一致。",
      method: "cv2.matchTemplate(frame[t], frame[t−1], TM_CCOEFF_NORMED)",
    },

    // UI elements
    langToggle: "English",
    showGuide: "顯示指標說明",
    hideGuide: "隱藏指標說明",
    whatItMeasures: "測量內容",
    interpretation: "解讀方式",
    typicalRange: "典型範圍",
    methodLabel: "計算方法",
  },
};

// Metric key order (for guide section)
const METRIC_KEYS = [
  "sharpness", "noise_sigma", "snr_db", "blockiness",
  "color_sat_std", "flicker_mean", "flicker_max", "consistency_ncc",
];

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function renderHTML(config) {
  const videos = config.videos || [];
  const mode = config.mode || "single";
  const generatedAt = config.generatedAt || "";
  const defaultLang = config.lang || "en";
  const n = videos.length;
  const isCompare = n > 1;

  // Serialize i18n for client-side use
  const i18nJSON = JSON.stringify(I18N);
  const metricKeysJSON = JSON.stringify(METRIC_KEYS);

  // Chart colors
  const colors = ["#4a9eff", "#f5c518", "#4caf50", "#f44336", "#9c27b0", "#ff9800"];

  // Build comparison table rows
  let tableRows = "";
  const allMetrics = [
    { key: "sharpness", source: "per_frame" },
    { key: "noise_sigma", source: "per_frame" },
    { key: "snr_db", source: "per_frame" },
    { key: "blockiness", source: "per_frame" },
    { key: "color_sat_std", source: "per_frame" },
    { key: "flicker_mean", source: "temporal" },
    { key: "flicker_max", source: "temporal" },
    { key: "consistency_ncc", source: "temporal" },
  ];

  for (const m of allMetrics) {
    const values = videos.map(v => {
      if (m.source === "per_frame") return v.per_frame_summary[m.key]?.mean ?? 0;
      return v.temporal_summary[m.key] ?? 0;
    });
    // Direction from i18n
    const dir = I18N.en[m.key]?.direction || "neutral";
    let winnerIdx = -1;
    if (dir === "higher") winnerIdx = values.indexOf(Math.max(...values));
    else if (dir === "lower") winnerIdx = values.indexOf(Math.min(...values));

    tableRows += `<tr data-metric="${m.key}">`;
    tableRows += `<td class="metric-name" data-i18n-metric-name="${m.key}"></td>`;
    for (let i = 0; i < n; i++) {
      const isWin = i === winnerIdx && isCompare;
      const v = values[i];
      const fmt = (m.key === "consistency_ncc") ? v.toFixed(3)
                : (Math.abs(v) < 10) ? v.toFixed(2) : v.toFixed(1);
      tableRows += `<td class="${isWin ? 'winner' : ''}">${fmt}</td>`;
    }
    if (isCompare) {
      tableRows += `<td class="winner-badge" data-winner="${winnerIdx >= 0 ? videos[winnerIdx].label : ''}"></td>`;
    }
    tableRows += `<td class="hint" data-i18n-metric-dir="${m.key}"></td>`;
    tableRows += `</tr>`;
  }

  // Build per-frame chart sections
  const frameChartKeys = [
    { key: "sharpness", yLabel: "Sharpness" },
    { key: "noise_sigma", yLabel: "Noise σ" },
    { key: "snr_db", yLabel: "SNR (dB)" },
    { key: "blockiness", yLabel: "Blockiness" },
    { key: "color_sat_std", yLabel: "Saturation σ" },
  ];
  let chartSections = "";
  for (const { key } of frameChartKeys) {
    chartSections += `
    <div class="chart-card">
      <h3><span data-i18n-metric-name="${key}"></span> <span class="dir-hint" data-i18n-metric-dir="${key}"></span></h3>
      <canvas id="chart-${key}"></canvas>
    </div>`;
  }
  // Flicker chart
  chartSections += `
    <div class="chart-card">
      <h3><span data-i18n-metric-name="flicker_mean"></span> <span class="dir-hint" data-i18n-metric-dir="flicker_mean"></span></h3>
      <canvas id="chart-flicker"></canvas>
    </div>`;

  // Summary cards (will be populated by JS for i18n)
  let summaryCards = "";
  for (let vi = 0; vi < n; vi++) {
    const v = videos[vi];
    const pf = v.per_frame_summary;
    const tp = v.temporal_summary;
    summaryCards += `
    <div class="summary-card">
      <div class="card-label">${v.label}</div>
      <div class="card-file">${v.video_basename}</div>
      <div class="card-info">${v.resolution[0]}×${v.resolution[1]} · ${v.frames_analyzed} <span data-i18n="frames"></span></div>
      <div class="card-metrics">
        <div><span class="metric-label" data-i18n-metric-name="sharpness"></span> <span class="metric-value">${pf.sharpness?.mean.toFixed(1) ?? '—'}</span> <span class="dir" data-i18n-metric-dir="sharpness"></span></div>
        <div><span class="metric-label" data-i18n-metric-name="noise_sigma"></span> <span class="metric-value">${pf.noise_sigma?.mean.toFixed(2) ?? '—'}</span> <span class="dir" data-i18n-metric-dir="noise_sigma"></span></div>
        <div><span class="metric-label" data-i18n-metric-name="snr_db"></span> <span class="metric-value">${pf.snr_db?.mean.toFixed(1) ?? '—'} dB</span> <span class="dir" data-i18n-metric-dir="snr_db"></span></div>
        <div><span class="metric-label" data-i18n-metric-name="blockiness"></span> <span class="metric-value">${pf.blockiness?.mean.toFixed(1) ?? '—'}</span> <span class="dir" data-i18n-metric-dir="blockiness"></span></div>
        <div><span class="metric-label" data-i18n-metric-name="flicker_mean"></span> <span class="metric-value">${tp.flicker_mean?.toFixed(1) ?? '—'}</span> <span class="dir" data-i18n-metric-dir="flicker_mean"></span></div>
        <div><span class="metric-label" data-i18n-metric-name="consistency_ncc"></span> <span class="metric-value">${tp.consistency_ncc?.toFixed(3) ?? '—'}</span> <span class="dir" data-i18n-metric-dir="consistency_ncc"></span></div>
      </div>
    </div>`;
  }

  // Metrics guide section (populated by JS)
  let guideCards = "";
  for (const key of METRIC_KEYS) {
    guideCards += `
    <div class="guide-card" data-guide-metric="${key}">
      <div class="guide-header" onclick="toggleGuideDetail('${key}')">
        <span class="guide-name" data-i18n-metric-name="${key}"></span>
        <span class="guide-dir-badge" data-i18n-metric-dir="${key}"></span>
        <span class="guide-toggle">▼</span>
      </div>
      <div class="guide-summary" data-i18n-metric-summary="${key}"></div>
      <div class="guide-detail" id="guide-detail-${key}" style="display:none;">
        <div class="guide-section">
          <div class="guide-section-title" data-i18n="whatItMeasures"></div>
          <div data-i18n-metric-detail="${key}"></div>
        </div>
        <div class="guide-section">
          <div class="guide-section-title" data-i18n="interpretation"></div>
          <div data-i18n-metric-range="${key}"></div>
        </div>
        <div class="guide-section">
          <div class="guide-section-title" data-i18n="methodLabel"></div>
          <code data-i18n-metric-method="${key}"></code>
        </div>
      </div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Video Quality Analysis</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f0f0f; --bg2: #1a1a1a; --bg3: #242424;
  --border: #333; --text: #e0e0e0; --muted: #777;
  --accent: #4a9eff; --gold: #f5c518; --green: #4caf50; --red: #f44336;
  --radius: 8px;
}
body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif;
       font-size: 14px; line-height: 1.5; }

header { background: var(--bg2); border-bottom: 1px solid var(--border);
         padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
header h1 { font-size: 18px; font-weight: 600; color: var(--accent); }
header .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }

.header-actions { display: flex; gap: 8px; align-items: center; }
.lang-btn, .guide-btn {
  background: var(--bg3); border: 1px solid var(--border); color: var(--text);
  padding: 6px 14px; border-radius: var(--radius); cursor: pointer; font-size: 12px;
  font-weight: 600; transition: background 0.2s, border-color 0.2s;
}
.lang-btn:hover, .guide-btn:hover { background: var(--border); border-color: var(--muted); }

.container { max-width: 1200px; margin: 0 auto; padding: 20px; }

/* Summary cards */
.summary-row { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
.summary-card { flex: 1; min-width: 250px; background: var(--bg2); border: 2px solid var(--border);
                border-radius: var(--radius); padding: 16px; }
.summary-card .card-label { font-size: 18px; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
.summary-card .card-file { font-size: 11px; color: var(--muted); margin-bottom: 2px; word-break: break-all; }
.summary-card .card-info { font-size: 11px; color: var(--muted); margin-bottom: 10px; }
.card-metrics div { display: flex; justify-content: space-between; padding: 3px 0;
                    border-bottom: 1px solid var(--bg3); }
.metric-label { color: var(--muted); }
.metric-value { font-weight: 600; font-variant-numeric: tabular-nums; }
.dir { font-size: 11px; color: var(--muted); width: 16px; text-align: center; }

/* Comparison table */
table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: var(--bg2);
        border-radius: var(--radius); overflow: hidden; }
th, td { padding: 8px 12px; text-align: right; border-bottom: 1px solid var(--bg3); }
th { background: var(--bg3); color: var(--muted); font-weight: 600; font-size: 12px;
     text-transform: uppercase; letter-spacing: 0.5px; }
td:first-child, th:first-child { text-align: left; }
td.winner { color: var(--gold); font-weight: 700; }
.winner-badge { color: var(--gold); font-weight: 700; }
.hint { color: var(--muted); font-size: 11px; }
.dir-hint { font-size: 11px; color: var(--muted); }

/* Charts */
.charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
               gap: 16px; margin-bottom: 24px; }
.chart-card { background: var(--bg2); border: 1px solid var(--border);
              border-radius: var(--radius); padding: 16px; }
.chart-card h3 { font-size: 13px; color: var(--muted); margin-bottom: 10px; font-weight: 600; }
.chart-card canvas { max-height: 250px; }

.section-title { font-size: 14px; font-weight: 600; color: var(--accent);
                 margin: 24px 0 12px 0; padding-bottom: 6px; border-bottom: 1px solid var(--border);
                 display: flex; justify-content: space-between; align-items: center; }

/* Metrics guide */
.guide-section-wrap { display: none; }
.guide-section-wrap.visible { display: block; }
.guide-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
              gap: 12px; margin-bottom: 24px; }
.guide-card { background: var(--bg2); border: 1px solid var(--border);
              border-radius: var(--radius); padding: 14px; }
.guide-header { display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 6px; }
.guide-name { font-weight: 700; font-size: 13px; color: var(--text); }
.guide-dir-badge { font-size: 11px; color: var(--muted); background: var(--bg3);
                   padding: 2px 8px; border-radius: 4px; }
.guide-toggle { font-size: 10px; color: var(--muted); margin-left: auto; transition: transform 0.2s; }
.guide-toggle.open { transform: rotate(180deg); }
.guide-summary { font-size: 12px; color: var(--muted); line-height: 1.4; }
.guide-detail { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--bg3); }
.guide-section { margin-bottom: 8px; }
.guide-section-title { font-size: 11px; font-weight: 700; color: var(--accent);
                       text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }
.guide-detail .guide-section div { font-size: 12px; color: #bbb; line-height: 1.5; }
.guide-detail code { font-size: 11px; color: var(--gold); background: var(--bg3);
                     padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', Menlo, monospace; }
</style>
</head>
<body>
<header>
  <div>
    <h1 data-i18n="pageTitle"></h1>
    <div class="meta">${generatedAt}${mode === 'self-test' ? ` · <span data-i18n="seed"></span>: ${config.seed}` : ''}</div>
  </div>
  <div class="header-actions">
    <button class="guide-btn" onclick="toggleGuideSection()" id="guide-btn" data-i18n="showGuide"></button>
    <button class="lang-btn" onclick="toggleLang()" id="lang-btn"></button>
  </div>
</header>

<div class="container">
  <h2 class="section-title"><span data-i18n="summary"></span></h2>
  <div class="summary-row">
    ${summaryCards}
  </div>

  ${isCompare ? `
  <h2 class="section-title"><span data-i18n="comparison"></span></h2>
  <table>
    <thead><tr><th data-i18n="metric"></th>${videos.map(v => `<th>${v.label}</th>`).join('')}<th data-i18n="winner"></th><th></th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="charts-grid">
    <div class="chart-card">
      <h3>Comparison Overview</h3>
      <canvas id="chart-comparison"></canvas>
    </div>
  </div>
  ` : ''}

  <h2 class="section-title"><span data-i18n="perFrame"></span></h2>
  <div class="charts-grid">
    ${chartSections}
  </div>

  <div class="guide-section-wrap" id="guide-section">
    <h2 class="section-title"><span data-i18n="metricsGuide"></span></h2>
    <div class="guide-grid">
      ${guideCards}
    </div>
  </div>
</div>

<script>
// ---- Config & i18n data ----
const configData = ${JSON.stringify(config)};
const I18N = ${i18nJSON};
const METRIC_KEYS = ${metricKeysJSON};
const colors = ${JSON.stringify(colors)};

let currentLang = "${defaultLang}";

function t(key) { return I18N[currentLang][key] || I18N.en[key] || key; }
function tm(key, field) { return I18N[currentLang][key]?.[field] || I18N.en[key]?.[field] || key; }

// ---- Apply i18n to all elements ----
function applyI18n() {
  document.documentElement.lang = currentLang === "zh_TW" ? "zh-TW" : "en";

  // Simple text keys
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // Metric names
  document.querySelectorAll("[data-i18n-metric-name]").forEach(el => {
    el.textContent = tm(el.dataset.i18nMetricName, "name");
  });

  // Metric direction
  document.querySelectorAll("[data-i18n-metric-dir]").forEach(el => {
    el.textContent = tm(el.dataset.i18nMetricDir, "directionLabel");
  });

  // Metric summary
  document.querySelectorAll("[data-i18n-metric-summary]").forEach(el => {
    el.textContent = tm(el.dataset.i18nMetricSummary, "summary");
  });

  // Metric detail
  document.querySelectorAll("[data-i18n-metric-detail]").forEach(el => {
    el.textContent = tm(el.dataset.i18nMetricDetail, "detail");
  });

  // Metric range
  document.querySelectorAll("[data-i18n-metric-range]").forEach(el => {
    el.textContent = tm(el.dataset.i18nMetricRange, "range");
  });

  // Metric method
  document.querySelectorAll("[data-i18n-metric-method]").forEach(el => {
    el.textContent = tm(el.dataset.i18nMetricMethod, "method");
  });

  // Update lang toggle button
  document.getElementById("lang-btn").textContent = t("langToggle");

  // Update guide toggle button
  const guideBtn = document.getElementById("guide-btn");
  const guideVisible = document.getElementById("guide-section").classList.contains("visible");
  guideBtn.textContent = guideVisible ? t("hideGuide") : t("showGuide");
}

function toggleLang() {
  currentLang = currentLang === "en" ? "zh_TW" : "en";
  applyI18n();
}

function toggleGuideSection() {
  const section = document.getElementById("guide-section");
  const btn = document.getElementById("guide-btn");
  section.classList.toggle("visible");
  btn.textContent = section.classList.contains("visible") ? t("hideGuide") : t("showGuide");
}

function toggleGuideDetail(key) {
  const detail = document.getElementById("guide-detail-" + key);
  const card = detail.closest(".guide-card");
  const toggle = card.querySelector(".guide-toggle");
  const isOpen = detail.style.display !== "none";
  detail.style.display = isOpen ? "none" : "block";
  toggle.classList.toggle("open", !isOpen);
  toggle.textContent = isOpen ? "▼" : "▲";
}

// ---- Initial i18n apply ----
applyI18n();

// ---- Charts ----
const videos = configData.videos || [];
const n = videos.length;

// Per-frame charts
const frameChartKeys = ["sharpness", "noise_sigma", "snr_db", "blockiness", "color_sat_std"];
for (const key of frameChartKeys) {
  const datasets = videos.map((v, i) => ({
    label: v.label,
    data: v.per_frame_values[key] || [],
    borderColor: colors[i % colors.length],
    backgroundColor: colors[i % colors.length] + "22",
    borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3,
  }));
  const len = (videos[0]?.per_frame_values[key]?.length || 0);
  new Chart(document.getElementById("chart-" + key), {
    type: "line",
    data: { labels: Array.from({length: len}, (_, i) => i), datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#e0e0e0" } } },
      scales: {
        x: { title: { display: true, text: "Frame", color: "#777" }, ticks: { color: "#555" }, grid: { color: "#222" } },
        y: { title: { display: true, text: tm(key, "name"), color: "#777" }, ticks: { color: "#555" }, grid: { color: "#222" } },
      },
    },
  });
}

// Flicker chart
const flickerDatasets = videos.map((v, i) => ({
  label: v.label,
  data: v.temporal_summary.flicker_values || [],
  borderColor: colors[i % colors.length],
  borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3,
}));
const flickerLen = (videos[0]?.temporal_summary?.flicker_values?.length || 0);
new Chart(document.getElementById("chart-flicker"), {
  type: "line",
  data: { labels: Array.from({length: flickerLen}, (_, i) => i), datasets: flickerDatasets },
  options: {
    responsive: true,
    plugins: { legend: { labels: { color: "#e0e0e0" } } },
    scales: {
      x: { title: { display: true, text: "Frame pair", color: "#777" }, ticks: { color: "#555" }, grid: { color: "#222" } },
      y: { title: { display: true, text: tm("flicker_mean", "name"), color: "#777" }, ticks: { color: "#555" }, grid: { color: "#222" } },
    },
  },
});

// Comparison bar chart
if (n > 1) {
  const allMetrics = [
    ...frameChartKeys.map(k => ({ key: k, source: "per_frame" })),
    { key: "flicker_mean", source: "temporal" },
    { key: "flicker_max", source: "temporal" },
    { key: "consistency_ncc", source: "temporal" },
  ];
  const metricLabels = allMetrics.map(m => tm(m.key, "name"));
  const barDatasets = videos.map((v, i) => {
    const vals = allMetrics.map(m => {
      if (m.source === "per_frame") return v.per_frame_summary[m.key]?.mean ?? 0;
      return v.temporal_summary[m.key] ?? 0;
    });
    return {
      label: v.label,
      data: vals,
      backgroundColor: colors[i % colors.length] + "cc",
      borderColor: colors[i % colors.length],
      borderWidth: 1,
    };
  });
  new Chart(document.getElementById("chart-comparison"), {
    type: "bar",
    data: { labels: metricLabels, datasets: barDatasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#e0e0e0" } } },
      scales: {
        x: { ticks: { color: "#555", maxRotation: 45 }, grid: { color: "#222" } },
        y: { ticks: { color: "#555" }, grid: { color: "#222" } },
      },
    },
  });
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Bun HTTP server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: 0, // random available port
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      const html = renderHTML(CONFIG);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Serving at http://localhost:${server.port}`);
