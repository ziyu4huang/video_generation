#!/usr/bin/env bun
//
// archify deck — IR[] → PPTX slide deck (Bun-native; dev-only).
//
// Pipeline: deck-manifest JSON → for each slide, render the IR via archify's own
// `deliver` (lib/run.ts, same path as archify_render) → raster the <svg> via
// Playwright (forced theme, chrome hidden) → assemble a 16:9 .pptx with
// title / accent / footer chrome via pptxgenjs.
//
//   bun run deck [manifest] [--theme light|dark] [--output out.pptx]
//
// Manifest (default deck.config.json):
//   {
//     "output": "out.pptx",
//     "theme": "light",
//     "tag": "archify deck",
//     "defaults": { "font": "PingFang TC", "scale": 2 },
//     "slides": [
//       { "ir": "slide1.json", "title": "…", "subtitle": "…" }
//     ]
//   }
//
// `ir` and `output` resolve relative to the manifest dir (portable manifest);
// `--output` resolves relative to cwd. This script is NOT imported by
// extensions/archify.ts — the registered bundle stays thin.
//
import PptxGenJS from "pptxgenjs";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runArchify } from "../lib/run.ts";
import { loadIrMeta } from "../lib/load-ir.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED_BIN = join(PKG_ROOT, "vendored", "bin", "archify.mjs");

// ---------- manifest types ----------
interface ManifestSlide { ir: string; title: string; subtitle?: string }
interface Manifest {
  output?: string;
  theme?: "light" | "dark";
  tag?: string;
  defaults?: { font?: string; scale?: number };
  slides: ManifestSlide[];
}

// ---------- CLI ----------
function parseArgs(argv: string[]): { manifest: string; theme?: "light" | "dark"; output?: string } {
  const positional: string[] = [];
  let theme: "light" | "dark" | undefined;
  let output: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--theme") { theme = argv[++i] as "light" | "dark"; continue; }
    if (a === "--output") { output = argv[++i]; continue; }
    if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    positional.push(a);
  }
  if (theme && theme !== "light" && theme !== "dark") {
    throw new Error(`--theme must be light|dark, got "${theme}"`);
  }
  return { manifest: positional[0] ?? "deck.config.json", theme, output };
}

function fail(msg: string): never {
  console.error(`deck: ${msg}`);
  process.exit(1);
}

// ---------- theme palettes ----------
interface Palette {
  svgBg: string;       // css hex (with #)
  slideBg: string;     // pptxgenjs hex (no #)
  title: string; accent: string; subtitle: string;
  tagBg: string; tagBorder: string; dataTheme: "light" | "dark";
}
const PALETTES: Record<"light" | "dark", Palette> = {
  light: { svgBg: "#f8fafc", slideBg: "FFFFFF", title: "0F2740", accent: "2563EB", subtitle: "6B7280", tagBg: "EFF4FA", tagBorder: "CBD5E1", dataTheme: "light" },
  dark: { svgBg: "#0f172a", slideBg: "0B1220", title: "E2E8F0", accent: "60A5FA", subtitle: "94A3B8", tagBg: "1E293B", tagBorder: "334155", dataTheme: "dark" },
};

/** Read PNG pixel dimensions from the IHDR chunk (bytes 16–23, big-endian). */
function pngDims(path: string) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ---------- main ----------
async function main() {
  const { manifest: manifestRel, theme: themeFlag, output: outputFlag } = parseArgs(process.argv.slice(2));
  const manifestAbs = isAbsolute(manifestRel) ? manifestRel : resolve(process.cwd(), manifestRel);
  if (!existsSync(manifestAbs)) fail(`manifest not found: ${manifestAbs}`);

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestAbs, "utf8")) as Manifest;
  } catch (e) {
    fail(`manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(manifest.slides) || manifest.slides.length === 0) fail("manifest missing non-empty `slides`");
  if (!manifest.output && !outputFlag) fail("manifest missing `output` (and no --output given)");

  const manifestDir = dirname(manifestAbs);
  const theme: "light" | "dark" = themeFlag ?? manifest.theme ?? "light";
  const pal = PALETTES[theme];
  const font = manifest.defaults?.font ?? "Arial";
  const scale = manifest.defaults?.scale ?? 2;
  const tagText = manifest.tag ?? "archify deck";
  const outAbs = outputFlag
    ? (isAbsolute(outputFlag) ? outputFlag : resolve(process.cwd(), outputFlag))
    : (isAbsolute(manifest.output!) ? manifest.output! : resolve(manifestDir, manifest.output!));

  if (!existsSync(VENDORED_BIN)) fail(`vendored archify bin not found at ${VENDORED_BIN} (set PI_ARCHIFY_BIN to override)`);

  // validate slide fields up front
  manifest.slides.forEach((s, i) => {
    if (!s.ir) fail(`slide ${i + 1}: missing \`ir\``);
    if (!s.title) fail(`slide ${i + 1}: missing \`title\``);
  });

  const work = mkdtempSync(join(tmpdir(), "archify-deck-"));
  const htmls: string[] = [];
  const pngs: string[] = [];
  try {
    // 1) render each IR → HTML via `deliver` (validates + renders + commits)
    for (let i = 0; i < manifest.slides.length; i++) {
      const s = manifest.slides[i]!;
      const irAbs = isAbsolute(s.ir) ? s.ir : resolve(manifestDir, s.ir);
      if (!existsSync(irAbs)) fail(`slide ${i + 1}: IR not found: ${irAbs}`);

      const loaded = loadIrMeta({ irPath: irAbs, cwd: manifestDir });
      if (!loaded.ok) fail(`slide ${i + 1}: ${loaded.error}`);
      const type = loaded.meta.type;
      if (!type) fail(`slide ${i + 1}: IR has no \`diagram_type\``);

      const htmlPath = join(work, `slide-${i + 1}.html`);
      const { stdout, stderr, status } = await runArchify(["deliver", type, irAbs, htmlPath, "--json"], PKG_ROOT, undefined, VENDORED_BIN);

      let receipt: { ok?: boolean; error?: string; diagnostics?: { code?: string; message?: string }[] };
      try { receipt = JSON.parse(stdout); }
      catch { fail(`slide ${i + 1}: archify deliver produced non-JSON output (exit ${status}). ${stderr || stdout}`); }
      if (receipt.ok !== true || status !== 0) {
        const diag = receipt.diagnostics?.length
          ? receipt.diagnostics.map((d) => `[${d.code ?? "?"}] ${d.message ?? ""}`).join("\n")
          : receipt.error ?? "";
        fail(`slide ${i + 1}: archify render failed: ${receipt.error ?? "see diagnostics"}.\nValidate the IR first with archify_validate.\n${diag}`);
      }
      if (!existsSync(htmlPath)) fail(`slide ${i + 1}: deliver reported ok but wrote no HTML to ${htmlPath}`);
      htmls.push(htmlPath);
      console.log(`rendered  slide ${i + 1}/${manifest.slides.length} (${type})`);
    }

    // 2) raster each HTML <svg> → PNG (force theme; hide chrome)
    let browser;
    try { browser = await chromium.launch(); }
    catch (e) {
      fail(`could not launch chromium: ${e instanceof Error ? e.message : String(e)}\n  (browsers missing? run: bunx --cwd ${PKG_ROOT} playwright install chromium)`);
    }
    try {
      const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1900, height: 1300 } });
      const page = await ctx.newPage();
      for (let i = 0; i < htmls.length; i++) {
        await page.goto(`file://${htmls[i]}`, { waitUntil: "load" });
        await page.addStyleTag({
          content: `html,body{background:#${pal.slideBg}!important} svg{background:${pal.svgBg}!important} .no-print,[class*="toolbar"],[class*="menu"],[class*="controls"]{display:none!important}`,
        });
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), pal.dataTheme);
        await page.waitForSelector("svg", { timeout: 10000 });
        await page.waitForTimeout(300);
        const svg = await page.$("svg");
        if (!svg) fail(`slide ${i + 1}: no <svg> in rendered HTML`);
        const pngPath = join(work, `slide-${i + 1}.png`);
        await svg.screenshot({ path: pngPath, omitBackground: false });
        pngs.push(pngPath);
        const d = pngDims(pngPath);
        console.log(`rasterized slide ${i + 1}/${htmls.length} (${d.w}x${d.h})`);
      }
    } finally { await browser.close(); }

    // 3) assemble 16:9 PPTX
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
    pptx.layout = "WIDE";
    const CX = 0.5, CY = 1.18, CW = 12.333, CH = 5.70;
    pngs.forEach((png, i) => {
      const s = manifest.slides[i]!;
      const slide = pptx.addSlide();
      slide.background = { color: pal.slideBg };
      slide.addShape("roundRect", { x: 9.7, y: 0.28, w: 3.13, h: 0.4, fill: { color: pal.tagBg }, line: { color: pal.tagBorder, width: 0.5 } });
      slide.addText(tagText, { x: 9.7, y: 0.28, w: 3.13, h: 0.4, fontFace: font, fontSize: 10, color: pal.title, align: "center", valign: "middle" });
      slide.addText(s.title, { x: 0.5, y: 0.22, w: 9.0, h: 0.75, fontFace: font, fontSize: 26, bold: true, color: pal.title, valign: "middle" });
      slide.addShape("rect", { x: 0.5, y: 1.02, w: 12.333, h: 0.035, fill: { color: pal.accent } });
      slide.addImage({ path: png, x: CX, y: CY, w: CW, h: CH, sizing: { type: "contain", w: CW, h: CH } });
      slide.addText(s.subtitle ?? "", { x: 0.5, y: 7.0, w: 11.4, h: 0.4, fontFace: font, fontSize: 11, color: pal.subtitle, valign: "middle" });
      slide.addText(`${i + 1} / ${pngs.length}`, { x: 11.9, y: 7.0, w: 0.94, h: 0.4, fontFace: font, fontSize: 11, color: pal.subtitle, align: "right", valign: "middle" });
    });

    const data = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
    await Bun.write(outAbs, data);
    console.log(`saved ${outAbs} (${(data.length / 1024).toFixed(0)} KB, ${pngs.length} slides, theme=${theme})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Exported for unit tests (see __tests__/deck.test.ts). Runs only as the entry module.
export { parseArgs };

if (import.meta.main) main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
