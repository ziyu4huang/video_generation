/**
 * render-prototype.ts — CHEAP prototype of the offline Markdown->HTML converter
 * for the `improve-codebase-architecture` skill (deliverable C, ticket 04).
 *
 * Throwaway de-risking code, NOT production. Production will use a curated
 * static Tailwind build + a robust Markdown parser; see PROTOTYPE-FINDINGS.md.
 *
 * Usage: bun run render-prototype.ts <input.md> [output.html]
 * Emits ONE self-contained offline HTML (vendored mermaid inlined, no CDN).
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ── args ────────────────────────────────────────────────────────────────────
const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: bun run render-prototype.ts <input.md> [output.html]");
  process.exit(1);
}
const tmpdir = process.env.TMPDIR || "/tmp";
const outputPath = process.argv[3] || path.join(tmpdir, "architecture-review-prototype.html");

const md = fs.readFileSync(inputPath, "utf-8");

// ── vendor mermaid (inlined as <script>) ────────────────────────────────────
const mermaidPath = path.resolve(import.meta.dir, "vendor/mermaid.min.js");
let mermaidSource: string;
let mermaidVendored = true;
if (fs.existsSync(mermaidPath) && fs.statSync(mermaidPath).size > 1000) {
  mermaidSource = fs.readFileSync(mermaidPath, "utf-8");
} else {
  mermaidVendored = false;
  mermaidSource = "/* mermaid stub: real mermaid.min.js must be vendored for diagrams */";
}

// ── minimal block parser ────────────────────────────────────────────────────
type Block =
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "ul"; items: string[] }
  | { t: "p"; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ t: "code", lang, code: buf.join("\n") });
      continue;
    }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ t: "h", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "").trim());
        i++;
      }
      blocks.push({ t: "ul", items });
      continue;
    }
    // blank
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // paragraph (gather consecutive non-blank, non-special lines)
    const buf: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ t: "p", text: buf.join(" ").trim() });
  }
  return blocks;
}

// ── inline formatting (bold, code, em), HTML-escaped ────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return out;
}

// ── attach bold-only caption paragraphs to following code blocks ────────────
type Node =
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; code: string; caption?: string }
  | { t: "ul"; items: string[] }
  | { t: "p"; text: string };

function withCaptions(blocks: Block[]): Node[] {
  const nodes: Node[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.t === "p") {
      const m = /^\*\*([^*]+)\*\*\s*$/.exec(b.text.trim());
      if (m && k + 1 < blocks.length && blocks[k + 1].t === "code") {
        nodes.push({ t: "code", ...blocks[k + 1], caption: m[1] });
        k++; // consume the code block
        continue;
      }
    }
    nodes.push(b as Node);
  }
  return nodes;
}

// ── badge mapping ───────────────────────────────────────────────────────────
const BADGE: Record<string, { cls: string; label: string }> = {
  Strong: { cls: "emerald", label: "Strong" },
  "Worth exploring": { cls: "amber", label: "Worth exploring" },
  Speculative: { cls: "slate", label: "Speculative" },
};
const candidateRe = /^Candidate\s+(\d+):\s*(.+?)\s*[—-]\s*(Strong|Worth exploring|Speculative)$/;

// ── render nodes ────────────────────────────────────────────────────────────
function renderCode(n: Extract<Node, { t: "code" }>): string {
  const inner = escapeHtml(n.code);
  if (n.lang === "mermaid") {
    return `<pre class="mermaid">${inner}</pre>`;
  }
  const cap = n.caption ? `<div class="cap">${escapeHtml(n.caption)}</div>` : "";
  return `${cap}<pre class="ascii"><code>${inner}</code></pre>`;
}

function renderNodes(nodes: Node[]): string {
  let html = "";
  let k = 0;
  while (k < nodes.length) {
    const n = nodes[k];
    // before/after side-by-side: two captioned code blocks in a row
    if (
      n.t === "code" &&
      n.caption &&
      k + 1 < nodes.length &&
      nodes[k + 1].t === "code" &&
      (nodes[k + 1] as Extract<Node, { t: "code" }>).caption
    ) {
      const a = n as Extract<Node, { t: "code" }>;
      const b = nodes[k + 1] as Extract<Node, { t: "code" }>;
      html += `<div class="before-after">`;
      html += `<div class="diagram"><div class="cap">${escapeHtml(a.caption)}</div>${
        a.lang === "mermaid"
          ? `<pre class="mermaid">${escapeHtml(a.code)}</pre>`
          : `<pre class="ascii"><code>${escapeHtml(a.code)}</code></pre>`
      }</div>`;
      html += `<div class="diagram"><div class="cap">${escapeHtml(b.caption)}</div>${
        b.lang === "mermaid"
          ? `<pre class="mermaid">${escapeHtml(b.code)}</pre>`
          : `<pre class="ascii"><code>${escapeHtml(b.code)}</code></pre>`
      }</div>`;
      html += `</div>`;
      k += 2;
      continue;
    }
    switch (n.t) {
      case "code":
        html += renderCode(n);
        break;
      case "ul":
        html += `<ul>${n.items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`;
        break;
      case "p": {
        const adr = /^\*\*ADR\*\*/.test(n.text.trim());
        if (adr) {
          html += `<div class="adr">${inline(n.text)}</div>`;
        } else {
          html += `<p>${inline(n.text)}</p>`;
        }
        break;
      }
      default:
        break;
    }
    k++;
  }
  return html;
}

// ── split into header + h2 sections ─────────────────────────────────────────
const blocks = withCaptions(parse(md));
const headerNodes: Node[] = [];
const sections: { heading: string; nodes: Node[] }[] = [];
let cur: { heading: string; nodes: Node[] } | null = null;
for (const n of blocks) {
  if (n.t === "h" && n.level === 1) {
    headerNodes.push(n);
    continue;
  }
  if (n.t === "h" && n.level === 2) {
    cur = { heading: n.text, nodes: [] };
    sections.push(cur);
    continue;
  }
  if (n.t === "h") {
    // h3+ live inside current section as headings
    (cur ?? (cur = { heading: "", nodes: [] }, sections.push(cur))).nodes.push(n);
    continue;
  }
  if (cur) cur.nodes.push(n);
  else headerNodes.push(n);
}

const title = (headerNodes.find((n) => n.t === "h") as Extract<Node, { t: "h" }> | undefined)?.text ||
  "Architecture review";

let body = "";
body += `<header class="doc-head"><h1>${escapeHtml(title)}</h1></header>`;
body += `<div class="legend"><span class="lg lg-mod">solid box = module</span><span class="lg lg-seam">dashed line = seam</span><span class="lg lg-leak">red = leakage</span><span class="lg lg-deep">dark box = deep module</span></div>`;
body += `<section class="cards">`;

for (const s of sections) {
  const cand = candidateRe.exec(s.heading);
  if (cand) {
    const num = cand[1];
    const ctitle = cand[2].trim();
    const badge = BADGE[cand[3]] || { cls: "slate", label: cand[3] };
    body += `<article class="card" data-strength="${badge.cls}">`;
    body += `<div class="card-head"><h2><span class="num">${num}</span>${escapeHtml(ctitle)}</h2>`;
    body += `<span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span></div>`;
    body += `<div class="card-body">${renderNodes(s.nodes)}</div>`;
    body += `</article>`;
  } else if (/top recommendation/i.test(s.heading)) {
    body += `</section>`; // close cards
    body += `<section class="top"><h2>${escapeHtml(s.heading)}</h2>${renderNodes(s.nodes)}</section>`;
  } else {
    body += `<section><h2>${escapeHtml(s.heading)}</h2>${renderNodes(s.nodes)}</section>`;
  }
}
if (!body.includes(`<section class="top">`)) body += `</section>`;

// ── CSS (hand-written, stone/slate editorial) ───────────────────────────────
const CSS = `
:root{
  --stone-50:#fafaf9;--stone-100:#f5f5f4;--stone-200:#e7e5e4;--stone-300:#d6d3d1;
  --slate-600:#475569;--slate-800:#1e293b;--slate-900:#0f172a;
  --emerald-600:#059669;--emerald-50:#ecfdf5;--emerald-200:#a7f3d0;
  --amber-600:#d97706;--amber-50:#fffbeb;--amber-200:#fde68a;
  --slate-badge:#64748b;--slate-badge-bg:#f1f5f9;
}
*{box-sizing:border-box}
body{margin:0;background:var(--stone-50);color:var(--slate-900);
  font-family:ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  line-height:1.6;-webkit-font-smoothing:antialiased}
main{max-width:1000px;margin:0 auto;padding:40px 24px 80px}
.doc-head h1{font-size:2rem;font-weight:700;letter-spacing:-.02em;margin:0 0 8px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.72rem;text-transform:uppercase;
  letter-spacing:.08em;color:var(--slate-600);border-bottom:1px solid var(--stone-200);
  padding-bottom:16px;margin-bottom:32px}
.lg:before{content:"";display:inline-block;width:14px;height:10px;margin-right:6px;vertical-align:middle}
.lg-mod:before{background:var(--slate-900)}
.lg-seam:before{background:transparent;border-top:2px dashed var(--slate-600);height:0}
.lg-leak:before{background:var(--emerald-600);background:#dc2626}
.lg-deep:before{background:var(--slate-800)}
section.cards{display:flex;flex-direction:column;gap:28px}
.card{background:#fff;border:1px solid var(--stone-200);border-radius:14px;overflow:hidden;
  box-shadow:0 1px 2px rgba(15,23,42,.04)}
.card[data-strength="emerald"]{border-left:5px solid var(--emerald-600)}
.card[data-strength="amber"]{border-left:5px solid var(--amber-600)}
.card[data-strength="slate"]{border-left:5px solid var(--slate-badge)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:18px 22px;border-bottom:1px solid var(--stone-200);background:var(--stone-50)}
.card-head h2{margin:0;font-size:1.15rem;font-weight:650;letter-spacing:-.01em;display:flex;align-items:baseline;gap:10px}
.card-head .num{font-size:.8rem;color:var(--slate-600);font-weight:700}
.badge{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
  padding:5px 11px;border-radius:999px;white-space:nowrap}
.badge.emerald{background:var(--emerald-50);color:var(--emerald-600);border:1px solid var(--emerald-200)}
.badge.amber{background:var(--amber-50);color:var(--amber-600);border:1px solid var(--amber-200)}
.badge.slate{background:var(--slate-badge-bg);color:var(--slate-badge);border:1px solid var(--stone-300)}
.card-body{padding:20px 22px}
.card-body p{margin:.4rem 0 .9rem}
.card-body strong{color:var(--slate-900);font-weight:650}
.card-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;
  background:var(--stone-100);padding:.1em .4em;border-radius:5px}
.card-body ul{margin:.3rem 0 .9rem;padding-left:1.1rem}
.card-body li{margin:.18rem 0}
.cap{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
  color:var(--slate-600);margin:6px 0 2px}
.before-after{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:.6rem 0 1rem}
.diagram{background:var(--stone-50);border:1px solid var(--stone-200);border-radius:10px;padding:10px;
  display:flex;flex-direction:column;min-width:0}
.diagram .cap{margin:0 0 6px}
pre.ascii{margin:0;background:transparent;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.74rem;line-height:1.45;color:var(--slate-800);white-space:pre}
pre.mermaid{margin:0;background:transparent;text-align:center}
.adr{background:var(--amber-50);border:1px solid var(--amber-200);border-radius:8px;
  padding:10px 14px;font-size:.86rem;color:#92400e;margin-top:.6rem}
section.top{margin-top:40px;background:var(--slate-900);color:var(--stone-50);
  border-radius:14px;padding:28px 30px}
section.top h2{margin:0 0 .5rem;font-size:1.3rem}
section.top p{margin:.4rem 0;color:var(--stone-200)}
section.top strong{color:#fff}
@media(max-width:720px){.before-after{grid-template-columns:1fr}}
`;

// ── assemble self-contained HTML ────────────────────────────────────────────
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
<script>
${mermaidSource}
</script>
<script>
  if (typeof mermaid !== "undefined") {
    mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
  }
</script>
</body>
</html>
`;

fs.writeFileSync(outputPath, html, "utf-8");
const size = fs.statSync(outputPath).size;
console.log(`wrote ${outputPath} (${size} bytes)`);
if (!mermaidVendored) {
  console.error("NOTE: mermaid.min.js was NOT vendored (stub embedded). Diagrams will not render.");
}
