/**
 * architecture-render.ts — deterministic offline Markdown→HTML converter for
 * architecture-review reports. Pure core + CLI entry.
 *
 * renderReport(markdown, css, mermaidSource, options?) → self-contained HTML string
 *
 * CLI: architecture:render <report.md> [out.html]
 *       Default output: $TMPDIR/architecture-review-<timestamp>.html
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

// ── types ───────────────────────────────────────────────────────────────────

interface Tokenish {
  type: string;
  depth?: number;
  text?: string;
  lang?: string;
  raw?: string;
  items?: Tokenish[];
  tokens?: Tokenish[];
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "ul"; items: string[] }
  | { t: "p"; text: string };

type CodeNode = { t: "code"; lang: string; code: string; caption?: string };
type Node = Block | CodeNode;

export interface RenderOptions {
  mermaid?: boolean;
}

// ── helpers ─────────────────────────────────────────────────────────────────

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

// ── token → block flatten ──────────────────────────────────────────────────

function tokenToBlock(tok: Tokenish): Block | null {
  switch (tok.type) {
    case "heading": {
      const text = tok.tokens
        ? tok.tokens
            .filter((t: Tokenish) => t.type === "text")
            .map((t: Tokenish) => t.text ?? "")
            .join("")
        : (tok.text ?? "");
      return { t: "h", level: tok.depth ?? 1, text };
    }
    case "code":
      return { t: "code", lang: tok.lang ?? "", code: tok.text ?? "" };
    case "paragraph": {
      if (tok.tokens && tok.tokens.length > 0) {
        // Reconstruct raw text from inline tokens for our inline() renderer
        const raw = tok.tokens
          .map((t: Tokenish) => {
            switch (t.type) {
              case "strong":
                return `**${t.text ?? ""}**`;
              case "em":
                return `*${t.text ?? ""}*`;
              case "codespan":
                return `\`${t.text ?? ""}\``;
              default:
                return t.text ?? "";
            }
          })
          .join("");
        return { t: "p", text: raw };
      }
      return { t: "p", text: tok.text ?? "" };
    }
    case "list": {
      const items: string[] = [];
      if (tok.items) {
        for (const item of tok.items) {
          const raw = item.tokens
            ? item.tokens
                .filter((t: Tokenish) => t.type === "text")
                .map((t: Tokenish) => t.text ?? "")
                .join("")
            : (item.text ?? "");
          items.push(raw);
        }
      }
      return { t: "ul", items };
    }
    case "space":
      return null;
    default:
      return null;
  }
}

// ── attach bold-only caption paragraphs to following code blocks ────────────

function withCaptions(blocks: Block[]): Node[] {
  const nodes: Node[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.t === "p") {
      const m = /^\*\*([^*]+)\*\*\s*$/.exec(b.text.trim());
      if (m && k + 1 < blocks.length && blocks[k + 1].t === "code") {
        const codeBlock = blocks[k + 1] as { t: "code"; lang: string; code: string };
        nodes.push({ t: "code", lang: codeBlock.lang, code: codeBlock.code, caption: m[1] });
        k++; // consume the code block
        continue;
      }
    }
    nodes.push(b);
  }
  return nodes;
}

// ── render blocks to HTML ───────────────────────────────────────────────────

function renderCodeNode(n: CodeNode): string {
  const inner = escapeHtml(n.code);
  if (n.lang === "mermaid") {
    return `<pre class="mermaid">${inner}</pre>`;
  }
  const cap = n.caption ? `<div class="cap">${escapeHtml(n.caption)}</div>` : "";
  return `${cap}<pre class="ascii"><code>${inner}</code></pre>`;
}

function isCodeNode(n: Node): n is CodeNode {
  return n.t === "code";
}

function renderNodes(nodes: Node[]): string {
  let html = "";
  let k = 0;
  while (k < nodes.length) {
    const n = nodes[k];
    // before/after side-by-side: two captioned code blocks in a row
    if (isCodeNode(n) && n.caption && k + 1 < nodes.length) {
      const next = nodes[k + 1];
      if (isCodeNode(next) && next.caption) {
        html += `<div class="before-after">`;
        html += `<div class="diagram"><div class="cap">${escapeHtml(n.caption)}</div>${
          n.lang === "mermaid"
            ? `<pre class="mermaid">${escapeHtml(n.code)}</pre>`
            : `<pre class="ascii"><code>${escapeHtml(n.code)}</code></pre>`
        }</div>`;
        html += `<div class="diagram"><div class="cap">${escapeHtml(next.caption)}</div>${
          next.lang === "mermaid"
            ? `<pre class="mermaid">${escapeHtml(next.code)}</pre>`
            : `<pre class="ascii"><code>${escapeHtml(next.code)}</code></pre>`
        }</div>`;
        html += `</div>`;
        k += 2;
        continue;
      }
    }
    if (n.t === "code") {
      html += renderCodeNode(n);
    } else if (n.t === "ul") {
      html += `<ul>${n.items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`;
    } else if (n.t === "p") {
      const raw = n.text;
      const isAdr = /^\*\*ADR\*\*/.test(raw.trim());
      if (isAdr) {
        html += `<div class="adr">${inline(raw)}</div>`;
      } else {
        html += `<p>${inline(raw)}</p>`;
      }
    }
    k++;
  }
  return html;
}

// ── badge mapping ───────────────────────────────────────────────────────────

const BADGE: Record<string, { cls: string; label: string }> = {
  Strong: { cls: "emerald", label: "Strong" },
  "Worth exploring": { cls: "amber", label: "Worth exploring" },
  Speculative: { cls: "slate", label: "Speculative" },
};

const candidateRe = /^Candidate\s+(\d+):\s*(.+?)\s*[—-]\s*(Strong|Worth exploring|Speculative)$/;

// ── main render function ────────────────────────────────────────────────────

export function renderReport(markdown: string, css: string, mermaidSource: string, options?: RenderOptions): string {
  const tokens = marked.lexer(markdown);
  const blocks: Block[] = [];
  for (const tok of tokens as unknown as Tokenish[]) {
    const b = tokenToBlock(tok);
    if (b) blocks.push(b);
  }

  const nodes = withCaptions(blocks);

  // ── split into header + h2 sections ───────────────────────────────────────
  const headerNodes: Node[] = [];
  const sections: { heading: string; nodes: Node[] }[] = [];
  let cur: { heading: string; nodes: Node[] } | null = null;
  for (const n of nodes) {
    if (n.t === "h" && n.level === 1) {
      headerNodes.push(n);
      continue;
    }
    if (n.t === "h" && n.level === 2) {
      cur = { heading: n.text ?? "", nodes: [] };
      sections.push(cur);
      continue;
    }
    if (n.t === "h") {
      if (!cur) {
        cur = { heading: "", nodes: [] };
        sections.push(cur);
      }
      cur.nodes.push(n);
      continue;
    }
    if (cur) cur.nodes.push(n);
    else headerNodes.push(n);
  }

  const title = headerNodes.find((n) => n.t === "h")?.text || "Architecture review";

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

  const showMermaid = options?.mermaid !== false;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main>
${body}
</main>
${
  showMermaid
    ? `<script>
${mermaidSource}
</script>
<script>
  if (typeof mermaid !== "undefined") {
    mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
  }
</script>`
    : ""
}
</body>
</html>
`;
  return html;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const inputPath = argv[2];
  if (!inputPath) {
    console.error("usage: architecture:render <report.md> [out.html]");
    return 1;
  }

  const tmpdir = process.env.TMPDIR || "/tmp";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const outputPath = argv[3] || join(tmpdir, `architecture-review-${ts}.html`);

  const markdown = readFileSync(inputPath, "utf-8");

  const vendorDir = join(import.meta.dir, "..", "vendored");
  const css = readFileSync(join(vendorDir, "tailwind.css"), "utf-8");
  const mermaidSource = existsSync(join(vendorDir, "mermaid.min.js"))
    ? readFileSync(join(vendorDir, "mermaid.min.js"), "utf-8")
    : "/* mermaid not vendored */";

  const html = renderReport(markdown, css, mermaidSource);

  writeFileSync(outputPath, html, "utf-8");
  const size = statSync(outputPath).size;
  console.log(`wrote ${outputPath} (${size} bytes)`);
  return 0;
}

// ── run CLI when executed directly ──────────────────────────────────────────
if (import.meta.main) {
  const code = await main(process.argv);
  process.exit(code);
}
