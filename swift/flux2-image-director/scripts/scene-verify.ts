#!/usr/bin/env bun
//
// scene-verify.ts — verify `flux2 scene` demo correctness with the caption VLM,
// and emit ONE self-contained HTML bundle (base64 images + verdicts) for review.
//
// "caption VLM" = the local VLM behind `run.py caption` (Qwen3-VL 4B / gemma via
// LM Studio). Per CLAUDE.md we prefer `run.py caption` over MCP (MCP can't read
// local paths). This script drives TWO complementary checks through that VLM:
//
//   1. Quality + prompt-adherence  — `run.py caption <img> --style score
//      --style review --prompt <scene>` → parses <img>.caption.json
//      (overall/detail/.../prompt_adherence/artifacts + review captured/missed).
//   2. Structured placement + ACTIVITY verdict — a direct call to the SAME VLM
//      (LM Studio OpenAI endpoint) with a custom question run.py's fixed styles
//      can't ask: "which girl is on which side, in which pose, doing what?".
//      Compared against EXPECTED to score placement/activity correctness.
//
// The decisive metric for a multi-character scene is #2: did each distinct
// identity land in its assigned region WITH its assigned pose/action. (Per the
// arch doc, placement is prompt-driven & probabilistic → seed-select; this
// verifier automates the "verified-correct" gate.)
//
// Output HTML is gitignored (lives under test_cases/). NOT added to git.
//
// Usage:
//   bun swift/flux2-image-director/scripts/scene-verify.ts \
//     --dir  swift/flux2-image-director/test_cases/scene-classroom-demo \
//     --out  swift/flux2-image-director/test_cases/scene-classroom-demo/verify.html \
//     [--open] [--no-caption]   # --no-caption = skip run.py caption, VLM-query only
//
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

// ── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  let dir = "", out = "", open = false, noCaption = false, apiUrl = "http://localhost:1234/v1/chat/completions";
  let model = "qwen/qwen3-vl-4b";
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--dir") dir = a[++i];
    else if (a[i] === "--out") out = a[++i];
    else if (a[i] === "--open") open = true;
    else if (a[i] === "--no-caption") noCaption = true;
    else if (a[i] === "--api-url") apiUrl = a[++i];
    else if (a[i] === "--model") model = a[++i];
    else if (!a[i].startsWith("-") && !dir) dir = a[i];
  }
  if (!dir) throw new Error("--dir <demo output dir> is required");
  if (!out) out = join(dir, "verify.html");
  return { dir: resolve(dir), out: resolve(out), open, noCaption, apiUrl, model };
}
const { dir, out, open, noCaption, apiUrl, model } = parseArgs(process.argv);

const REPO = resolve(process.argv[1]!, "../../../.."); // scripts → repo root
const PY = join(REPO, "python/venv/bin/python");
const RUN_PY = join(REPO, "python/mlx-movie-director/run.py");

// ── scene spec (the "correct" answer we verify against) ────────────────────
// Must match scene-classroom-demo.sh's REF_A/REF_B + SCENE routing.
const SCENE_PROMPT =
  "two young women in a bright modern classroom. LEFT: long straight BLACK hair, red-rim glasses, white shirt, navy skirt — SITTING at a desk writing/solving a MATH problem. RIGHT: short CURLY BROWN hair, yellow sweater, jeans — STANDING leaning on a desk holding an open BOOK.";
const EXPECTED = {
  left: { hair: "black", pose: "sitting", action: "writing-math" },
  right: { hair: "brown", pose: "standing", action: "reading-book" },
};

// ── helpers ────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};
function embed(path: string): string {
  const b64 = Buffer.from(readFileSync(path)).toString("base64");
  return `data:${MIME[extname(path).toLowerCase()] ?? "application/octet-stream"};base64,${b64}`;
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function b64raw(path: string): string { return Buffer.from(readFileSync(path)).toString("base64"); }

// ── caption VLM #1: quality + adherence via run.py caption ──────────────────
async function captionVLM(img: string): Promise<{
  scores?: { overall: number; detail: number; sharpness: number; composition: number; prompt_adherence: number; artifacts: number; issues: string[]; strengths: string[]; summary: string };
  review?: string;
}> {
  const captionJson = `${img}.caption.json`;
  // Force a fresh VLM call (run.py caption writes <img>.caption.json next to it).
  const args = [RUN_PY, "caption", img, "--style", "score", "--style", "review",
    "--prompt", SCENE_PROMPT, "--lang", "en", "--force"];
  try {
    const proc = Bun.spawn([PY, ...args], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch (e) { console.warn(`  ⚠ caption failed: ${e}`); }
  if (!existsSync(captionJson)) return {};
  try {
    const j = JSON.parse(readFileSync(captionJson, "utf8"));
    const styles = j.styles ?? {};
    let scores: any = undefined, review: string | undefined;
    if (styles.score?.caption) {
      try { scores = JSON.parse(styles.score.caption); } catch { /* not JSON */ }
    }
    if (styles.review?.caption) review = styles.review.caption;
    return { scores, review };
  } catch { return {}; }
}

// ── caption VLM #2: structured placement+activity (same VLM, custom Q) ─────
async function placementVLM(img: string): Promise<{
  raw: string; left: string; right: string; placementOK: boolean; activityOK: boolean;
}> {
  const q =
    "Look at this image of two girls in a classroom. For EACH side, report: " +
    "POSITION (LEFT/RIGHT), HAIR color+style, POSE (sitting/standing), ACTION (writing-math/reading-book/other). " +
    "Reply in EXACTLY this format and nothing else:\n" +
    "LEFT=<hair>,<pose>,<action>; RIGHT=<hair>,<pose>,<action>";
  const payload = {
    model, temperature: 0, max_tokens: 120,
    messages: [{ role: "user", content: [
      { type: "text", text: q },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64raw(img)}` } },
    ] }],
  };
  let raw = "";
  try {
    const r = await fetch(apiUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120000),
    });
    const j = await r.json() as any;
    raw = (j.choices?.[0]?.message?.content ?? "").trim().replace(/\n/g, " ");
  } catch (e: any) { raw = `VLM_ERROR: ${e.message}`; }

  const low = raw.toLowerCase();
  // crude parse: find LEFT=...; RIGHT=...
  const mL = low.match(/left=([^;]+)/); const mR = low.match(/right=([^;]+)/);
  const left = mL?.[1]?.trim() ?? ""; const right = mR?.[1]?.trim() ?? "";
  // placementOK  = black-hair on LEFT, brown-hair on RIGHT
  const blackLeft = left.includes("black") && !left.includes("brown");
  const brownRight = right.includes("brown");
  const placementOK = blackLeft && brownRight;
  // activityOK = left sitting+writing, right standing+reading
  const leftSit = left.includes("sit"); const leftWrite = left.includes("writ") || left.includes("math");
  const rightStand = right.includes("stand"); const rightRead = right.includes("read") || right.includes("book");
  const activityOK = leftSit && leftWrite && rightStand && rightRead;
  return { raw, left, right, placementOK, activityOK };
}

// ── discover images ────────────────────────────────────────────────────────
const all = readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
const refs = all.filter(f => /^girl[AB]\./i.test(f)).sort();
const seeds = all.filter(f => /^seed_\d+\.png$/i.test(f)).sort((a, b) => {
  const na = parseInt(a.match(/\d+/)![0]); const nb = parseInt(b.match(/\d+/)![0]); return na - nb;
});
if (seeds.length === 0) { console.error(`No seed_*.png scene outputs in ${dir}`); process.exit(1); }
console.log(`refs: ${refs.join(", ") || "(none)"} | seeds: ${seeds.length}`);

// ── verify each scene output ───────────────────────────────────────────────
type Verdict = {
  file: string; img: string;
  placement: Awaited<ReturnType<typeof placementVLM>>;
  cap: Awaited<ReturnType<typeof captionVLM>>;
  pass: boolean;
};
const verdicts: Verdict[] = [];
for (const f of seeds) {
  const img = join(dir, f);
  process.stdout.write(`verifying ${f} ... `);
  const placement = await placementVLM(img);
  const cap = noCaption ? {} : await captionVLM(img);
  const pass = placement.placementOK && placement.activityOK;
  verdicts.push({ file: f, img, placement, cap, pass });
  console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  placement=${placement.placementOK} activity=${placement.activityOK}  [${placement.left} | ${placement.right}]`);
}

const passed = verdicts.filter(v => v.pass).length;
console.log(`\n${passed}/${verdicts.length} seeds match target placement+activity`);

// ── HTML bundle (self-contained, base64) ───────────────────────────────────
function scoreCell(v: number | undefined, max = 10, invert = false): string {
  if (v === undefined) return `<td class="na">—</td>`;
  const good = invert ? v <= max / 2 : v >= max * 0.6;
  return `<td class="${good ? "ok" : "bad"}">${v}</td>`;
}
function verdictBadge(v: Verdict): string {
  if (v.pass) return `<span class="badge pass">✓ CORRECT</span>`;
  const why: string[] = [];
  if (!v.placement.placementOK) why.push("placement");
  if (!v.placement.activityOK) why.push("activity");
  return `<span class="badge fail">✗ ${why.join("+")}</span>`;
}

const refCards = refs.map(f => {
  const id = f.match(/girl([AB])/i)?.[1] ?? "?";
  const label = id === "A" ? "Girl A — long straight BLACK hair, glasses, white shirt + navy skirt (sits, writes math)"
                            : "Girl B — short CURLY BROWN hair, yellow sweater + jeans (stands, reads)";
  return `<div class="ref"><img src="${embed(join(dir, f))}"/><div class="cap"><b>ref ${id}</b><br/><span class="muted">${esc(label)}</span></div></div>`;
}).join("");

const cards = verdicts.map(v => {
  const s = v.cap.scores;
  const rows = s ? `
    <table class="scores">
      <tr><th>overall</th>${scoreCell(s.overall)}<th>detail</th>${scoreCell(s.detail)}<th>sharp</th>${scoreCell(s.sharpness)}</tr>
      <tr><th>composit</th>${scoreCell(s.composition)}<th>adherence</th>${scoreCell(s.prompt_adherence)}<th>artifacts</th>${scoreCell(s.artifacts, 10, true)}</tr>
    </table>` : `<div class="muted">(caption scores skipped)</div>`;
  const issues = s?.issues?.length ? `<div class="issues">⚠ ${s.issues.map(esc).join(" · ")}</div>` : "";
  return `<div class="card ${v.pass ? "card-pass" : "card-fail"}">
    <img class="hero" src="${embed(v.img)}"/>
    <div class="meta">
      <div class="row">${verdictBadge(v)} <b>${esc(v.file)}</b></div>
      <div class="vlm"><span class="muted">VLM verdict:</span><br/><code>${esc(v.placement.left)}<br/>${esc(v.placement.right)}</code></div>
      ${rows}${issues}
      ${v.cap.review ? `<details><summary>adherence review</summary><div class="muted small">${esc(v.cap.review)}</div></details>` : ""}
    </div>
  </div>`;
}).join("");

const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>flux2 scene classroom demo — VLM verification</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e6e6;padding:24px}
  h1{font-size:20px} h2{font-size:16px;margin-top:28px;border-bottom:1px solid #333;padding-bottom:6px}
  .muted{color:#9aa} .small{font-size:12px}
  .refs{display:flex;gap:16px;flex-wrap:wrap}
  .ref{width:200px;text-align:center}.ref img{width:100%;border-radius:6px;border:1px solid #333}
  .cap{font-size:12px;margin-top:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:18px;margin-top:12px}
  .card{background:#171a21;border:1px solid #2a2e37;border-radius:8px;overflow:hidden}
  .card-pass{border-color:#2f6b3a}.card-fail{border-color:#7a2e2e}
  .card img.hero{width:100%;display:block}
  .meta{padding:12px}
  .badge{padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px}
  .badge.pass{background:#2f6b3a;color:#bff0c6}.badge.fail{background:#7a2e2e;color:#f0c6c6}
  .row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .vlm{background:#0f1115;border:1px solid #2a2e37;border-radius:4px;padding:6px 8px;margin-bottom:8px}
  code{font-size:12px;white-space:pre-wrap}
  table.scores{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0}
  table.scores th{background:#1f232c;font-weight:600;text-align:right;padding:3px 6px;color:#9aa;width:18%}
  table.scores td{text-align:center;padding:3px 6px;width:14%}
  td.ok{color:#7fdFa0} td.bad{color:#f0a0a0} td.na{color:#666}
  .issues{font-size:12px;color:#f0c672;margin-top:6px}
  details{margin-top:8px} summary{cursor:pointer;color:#9aa;font-size:12px}
</style></head><body>
<h1>flux2 scene — classroom multi-character demo · VLM verification</h1>
<p class="muted">Target: <b>LEFT</b> = black-hair girl <b>sitting</b> + <b>writing math</b>; <b>RIGHT</b> = brown-hair girl <b>standing</b> + <b>reading</b>. &nbsp;
Result: <b>${passed}/${verdicts.length}</b> seeds match placement+activity.</p>
<h2>Reference identities (refs fed to <code>flux2 scene</code>)</h2>
<div class="refs">${refCards || '<p class="muted">no girlA/girlB refs found</p>'}</div>
<h2>Scene outputs — per-seed verdict</h2>
<div class="grid">${cards}</div>
<p class="muted small" style="margin-top:24px">Generated by scripts/scene-verify.ts · caption VLM = ${esc(model)} (LM Studio) + run.py caption (score/review). Self-contained; gitignored.</p>
</body></html>`;

writeFileSync(out, html);
console.log(`\n✓ bundle written: ${out}  (${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB)`);
if (open) Bun.spawn(["open", out]);
