#!/usr/bin/env bun
//
// scene-gallery.ts — combine scene images + their reference inputs into ONE
// self-contained HTML so you can see the relations (which ref fed which output).
//
// All images are base64-embedded (data URIs) → the HTML has zero external
// dependencies and can be opened / shared anywhere.
//
// With --gate, every image is also run through scripts/image_gate.py (basic
// stats: neighbor_diff / entropy / black / white / NaN) and bad images get a
// red/amber badge — a fast, VLM-free self-gated reviewer baked into the gallery.
//
// Usage:
//   bun swift/flux2-image-director/scripts/scene-gallery.ts \
//     --manifest swift/flux2-image-director/scripts/scene-relations.json \
//     --out ../video_generation__output/scene-gallery.html [--open] [--gate]
//
// Manifest schema (see scene-relations.json):
//   { "title","root"?, "refs":[{id,label,path,note?}],
//     "outputs":[{id,label,path,sources[],runJson?,note?}] }
//

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, extname, resolve } from "node:path";

interface Ref { id: string; label: string; path: string; note?: string }
interface Output {
  id: string; label: string; path: string; sources: string[];
  runJson?: string; note?: string;
}
interface Manifest { title?: string; root?: string; refs: Ref[]; outputs: Output[] }
interface GateVerdict { status: "PASS" | "WARN" | "FAIL"; reason: string; neighbor_diff?: number }

// --- arg parsing (zero-dep) -------------------------------------------------
function parseArgs(argv: string[]): { manifest: string; out: string; open: boolean; gate: boolean } {
  const args = argv.slice(2);
  let manifest = "scene-relations.json", out = "scene-gallery.html", open = false, gate = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--manifest" || a === "-m") manifest = args[++i];
    else if (a === "--out" || a === "-o") out = args[++i];
    else if (a === "--open") open = true;
    else if (a === "--gate") gate = true;
    else if (!a.startsWith("-") && manifest === "scene-relations.json") manifest = a;
  }
  return { manifest, out, open, gate };
}

// --- helpers ----------------------------------------------------------------
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
};
const REPO = resolve(process.argv[1]!, "../../../.."); // scripts/ -> swift/flux2-image-director/ -> swift/ -> repo
const DEFAULT_FLUX2 = join(REPO, "swift/flux2-image-director/.build/release/flux2");

function resolvePath(p: string, root: string | undefined, manifestDir: string): string {
  if (isAbsolute(p)) return p;
  if (root && existsSync(join(root, p))) return join(root, p);
  if (existsSync(join(manifestDir, p))) return join(manifestDir, p);
  return root ? join(root, p) : join(manifestDir, p);
}
function embed(path: string): string {
  const b64 = Buffer.from(readFileSync(path)).toString("base64");
  const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${b64}`;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function dirname(p: string): string { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(0, i) : "."; }

// --- gate -------------------------------------------------------------------
async function runGate(paths: string[], flux2: string): Promise<Map<string, GateVerdict>> {
  const map = new Map<string, GateVerdict>();
  if (paths.length === 0) return map;
  // Canonical Swift gate (`flux2 gate --json`). Exits 1 on FAIL but still prints JSON.
  const proc = Bun.spawn([flux2, "gate", "--json", ...paths], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  try {
    const arr = JSON.parse(stdout) as (GateVerdict & { path: string })[];
    for (const v of arr) map.set(v.path, { status: v.status, reason: v.reason, neighbor_diff: v.neighbor_diff });
  } catch {
    console.warn(`⚠ flux2 gate produced no JSON (exit ${code}); skipping badges`);
  }
  return map;
}
function badgeHtml(v: GateVerdict | undefined): string {
  if (!v) return "";
  const cls = v.status === "FAIL" ? "bg-fail" : v.status === "WARN" ? "bg-warn" : "bg-pass";
  const ico = v.status === "FAIL" ? "✖" : v.status === "WARN" ? "⚠" : "✓";
  const nbr = v.neighbor_diff !== undefined ? ` nbr=${v.neighbor_diff}` : "";
  return `<span class="badge ${cls}" title="${esc(v.reason)}">${ico} ${v.status}${nbr}</span>`;
}

// --- main -------------------------------------------------------------------
const { manifest: manifestPath, out: outPath, open, gate } = parseArgs(process.argv);
const manifestAbs = manifestPath.startsWith("/") ? manifestPath : join(process.cwd(), manifestPath);
const manifestDir = dirname(manifestAbs);
const man: Manifest = JSON.parse(readFileSync(manifestAbs, "utf8"));
const root = man.root;

const refById = new Map<string, Ref & { dataUri: string; abs: string }>();
for (const r of man.refs) {
  const abs = resolvePath(r.path, root, manifestDir);
  if (!existsSync(abs)) throw new Error(`reference image not found: ${abs}`);
  refById.set(r.id, { ...r, dataUri: embed(abs), abs });
}

const outCards = man.outputs.map((o) => {
  const abs = resolvePath(o.path, root, manifestDir);
  if (!existsSync(abs)) throw new Error(`output image not found: ${abs}`);
  let meta: Record<string, unknown> = {};
  if (o.runJson) {
    const rp = resolvePath(o.runJson, root, manifestDir);
    if (existsSync(rp)) meta = JSON.parse(readFileSync(rp, "utf8"));
  }
  const srcs = o.sources.map((s) => refById.get(s)).filter((r): r is NonNullable<typeof r> => !!r);
  const metaRows = [
    ["prompt", meta.prompt], ["seed", meta.seed], ["steps", meta.steps], ["cfg", meta.cfg_scale],
    ["size", meta.width && meta.height ? `${meta.width}×${meta.height}` : undefined],
    ["transformer", meta.transformer], ["created", meta.created_at],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  return { o, dataUri: embed(abs), abs, srcs, metaRows };
});

// Run the gate once over every unique image (refs + outputs).
const gateMap = gate
  ? await runGate(
      [...refById.values().map((r) => r.abs), ...outCards.map((c) => c.abs)],
      DEFAULT_FLUX2,
    )
  : new Map<string, GateVerdict>();

// --- HTML -------------------------------------------------------------------
const refPool = man.refs.map((r) => {
  const x = refById.get(r.id)!;
  return `<div class="ref">
      <div class="imgwrap">${badgeHtml(gateMap.get(x.abs))}<img src="${x.dataUri}" loading="lazy" title="${esc(x.label)}"/></div>
      <div class="cap"><span class="id">${esc(r.id)}</span> ${esc(x.label)}</div>
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}</div>`;
}).join("\n");

const relations = outCards.map(({ o, dataUri, abs, srcs, metaRows }) => {
  const srcThumbs = srcs.map((s) =>
    `<div class="src"><div class="imgwrap">${badgeHtml(gateMap.get(s.abs))}<img src="${s.dataUri}" title="${esc(s.label)}"/></div><span>${esc(s.id)}</span></div>`,
  ).join("");
  const metaHtml = metaRows.map(([k, v]) => `<tr><th>${esc(String(k))}</th><td>${esc(String(v))}</td></tr>`).join("");
  return `<section class="rel">
      <div class="srcs">${srcThumbs}</div>
      <div class="arrow">→</div>
      <div class="out">
        <div class="imgwrap">${badgeHtml(gateMap.get(abs))}<img src="${dataUri}" loading="lazy"/></div>
        <div class="cap"><strong>${esc(o.label)}</strong></div>
        ${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
        ${metaHtml ? `<table>${metaHtml}</table>` : ""}
      </div></section>`;
}).join("\n");

const generated = new Date().toISOString();
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(man.title ?? "scene gallery")}</title>
<style>
  :root{--bg:#0e0f13;--panel:#171922;--ink:#e6e8ee;--dim:#9aa0ad;--accent:#7ab7ff}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  header{padding:20px 24px;border-bottom:1px solid #262a36}
  header h1{margin:0;font-size:18px} header .sub{color:var(--dim);font-size:12px;margin-top:4px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:24px 24px 12px}
  .pool{display:flex;flex-wrap:wrap;gap:16px;padding:0 24px}
  .ref,.src,.out{background:var(--panel);border:1px solid #262a36;border-radius:10px;overflow:hidden}
  .ref{width:170px} .ref img,.src img,.out img{width:100%;height:auto;display:block}
  .cap{padding:8px 10px;font-size:12px} .cap .id{color:var(--accent);font-weight:600}
  .note{padding:0 10px 8px;font-size:11px;color:var(--dim)}
  .rels{display:flex;flex-direction:column;gap:20px;padding:0 24px 40px}
  .rel{display:flex;align-items:flex-start;gap:14px;background:#11131a;border:1px solid #262a36;border-radius:12px;padding:14px}
  .srcs{display:flex;gap:8px;flex-wrap:wrap;min-width:170px}
  .src{width:120px;text-align:center} .src span{display:block;padding:4px;font-size:11px;color:var(--accent)}
  .arrow{font-size:26px;color:var(--dim);align-self:center;padding:0 4px}
  .out{flex:1;min-width:0} .out img{max-width:520px;border-radius:6px}
  .out table{border-collapse:collapse;margin-top:8px;width:100%;max-width:520px;font-size:12px}
  .out th{color:var(--dim);text-align:left;padding:3px 8px 3px 0;white-space:nowrap}
  .out td{color:var(--ink);padding:3px 0;word-break:break-word}
  .imgwrap{position:relative}
  .badge{position:absolute;top:6px;left:6px;font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;
    background:#000a;color:#fff;backdrop-filter:blur(2px);z-index:2;font-family:ui-monospace,monospace}
  .bg-fail{background:#b3261e;color:#fff} .bg-warn{background:#7a5a00;color:#ffe9a8} .bg-pass{background:#1e6b3a;color:#bfffd0}
  footer{padding:16px 24px;color:var(--dim);font-size:11px;border-top:1px solid #262a36}
  @media(max-width:760px){.rel{flex-direction:column}.arrow{transform:rotate(90deg)}}
</style></head><body>
<header>
  <h1>${esc(man.title ?? "scene gallery")}</h1>
  <div class="sub">${man.refs.length} reference(s) · ${man.outputs.length} output run(s) · self-contained (base64)${gate ? " · self-gated (flux2 gate)" : ""} · ${esc(generated)}</div>
</header>
<h2>Reference pool</h2>
<div class="pool">${refPool}</div>
<h2>Relations — inputs → output</h2>
<div class="rels">${relations}</div>
<footer>inputs → arrow → generated output. Built by <code>scene-gallery.ts</code>${gate ? " · badges via <code>flux2 gate</code> (shared ImageGate)" : ""}.</footer>
</body></html>`;

writeFileSync(outPath, html);
console.log(`✅ wrote ${outPath}  (${Math.round(Buffer.byteLength(html) / 1024)} KB, ${man.refs.length} refs + ${man.outputs.length} outputs${gate ? `, gated ${gateMap.size} images` : ""})`);
if (open) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  Bun.spawn([cmd, outPath]);
  console.log("   opened in default browser");
}
