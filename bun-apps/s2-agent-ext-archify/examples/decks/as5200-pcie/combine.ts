// Combine the per-slide HTML files into ONE self-contained deck file:
// every slide is inlined as a srcdoc iframe (scripts allowed, zero network —
// external font links are stripped from the inlined copies).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dir, "..", "..", "..", "..", "..", "output", "as5200-pcie");
const dir = join(outDir, "as5200-pcie.slides");
const titles = (JSON.parse(readFileSync(`${import.meta.dir}/deck.config.json`, "utf8")).slides as { title: string }[]).map((s) => s.title);
const files = readdirSync(dir)
  .filter((f) => /^slide-\d+\.html$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

let total = 0;
const frames = files.map((f, i) => {
  let html = readFileSync(`${dir}/${f}`, "utf8");
  total += statSync(`${dir}/${f}`).size;
  html = html
    .replace(/<link[^>]+fonts\.g?oogleapis[^>]*>/g, "")
    .replace(/<link[^>]+fonts\.gstatic[^>]*>/g, "")
    .replace(/<link[^>]+rel="preconnect"[^>]*>/g, "");
  const esc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const label = (titles[i] ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `  <section class="slide"><header><span>${String(i + 1).padStart(2, "0")}</span><h2>${label}</h2></header>\n  <iframe loading="lazy" sandbox="allow-scripts" srcdoc="${esc}"></iframe></section>`;
}).join("\n");

const out = `<!doctype html>
<!-- AS5200 automotive SoC deck — self-contained: every slide is inlined (srcdoc), no network needed. -->
<!-- Diagram slides open in map detail; zoom inside a slide to reveal labels, or use Present. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AS5200 — automotive SoC bring-up review</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0f14; color: #e6edf3; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "PingFang TC", sans-serif; }
  .slide { margin: 0 auto 28px; max-width: 1280px; padding: 0 16px; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 10px 4px 6px; }
  header span { font: 600 12px ui-monospace, monospace; color: #58a6ff; letter-spacing: .08em; }
  header h2 { margin: 0; font-size: 14px; font-weight: 500; color: #9aa7b4; }
  iframe { width: 100%; border: 0; border-radius: 10px; background: #fff; height: min(72vw, 720px); box-shadow: 0 8px 30px rgba(0,0,0,.45); }
  .top { max-width: 1280px; margin: 0 auto; padding: 22px 16px 4px; }
  .top h1 { font-size: 20px; margin: 0 0 2px; } .top p { margin: 0; color: #9aa7b4; font-size: 13px; }
</style></head><body>
<div class="top"><h1>AS5200 — the car program is won on the bus</h1><p>17 slides · automotive SoC bring-up review · diagram slides are interactive (zoom inside for labels)</p></div>
${frames}
</body></html>`;

await Bun.write(join(outDir, "as5200-pcie-deck.html"), out);
console.log(`combined: ${files.length} slides, ${(statSync(join(outDir, "as5200-pcie-deck.html")).size / 1e6).toFixed(1)} MB (sources ${(total / 1e6).toFixed(1)} MB)`);
