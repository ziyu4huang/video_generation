/**
 * deck-combine — one build artifact to rule the handoff: a SINGLE self-contained
 * HTML file that plays the whole deck.
 *
 * Why: `buildDeck` persists per-slide HTML (composed plates + interactive
 * diagram artifacts) and a .pptx — but nothing in-tree strings the slides
 * together into a portable file. The webui deck pane needs a live session;
 * emailing a folder is not a handoff. This module emits `deck.html`: every
 * slide inlined as a sandboxed srcdoc iframe (interactive diagram artifacts
 * keep their zoom/present UI), with keyboard paging, deep links, an overview
 * grid, and a shell that inherits the deck's own palette.
 *
 * Purity contract: `combineDeckHtml` is a string→string function — it reads no
 * files, writes nothing, and embeds no timestamps, so two builds of the same
 * deck produce byte-identical deck.html (the deck-determinism discipline).
 *
 * Embedding rules (inherited from the proven 48-line operator script in
 * examples/decks/as5200-pcie/combine.ts):
 *   - each slide is `<iframe sandbox="allow-scripts" srcdoc="…">` — scripts
 *     run inside, but the slide cannot reach the parent page;
 *   - external font `<link>`s (fonts.googleapis/fonts.gstatic/preconnect) are
 *     stripped per slide so the file works with ZERO network — the slides'
 *     font stacks degrade gracefully offline;
 *   - composed slides are 16:9 plates; diagram artifacts are scrollable
 *     documents — both live in the same fixed-aspect stage and scroll
 *     internally when taller.
 */
import { PALETTES, type Palette, type Theme } from "./deck-theme.ts";

/** One persisted slide's contribution to the combined file. */
export interface CombineSlide {
  /** Slide title (manifest order); shown in the overview grid + header. */
  title: string;
  /** The slide's own HTML (slide-N.html as persisted). */
  html: string;
}

export interface CombineOptions {
  deckTitle: string;
  theme: Theme;
}

/** Escape a string for safe embedding inside a double-quoted srcdoc attribute. */
function escapeSrcdoc(html: string): string {
  return html
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Escape for text content positions (headers, titles). */
function escapeText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Strip external font stylesheet/preconnect links — the file must be offline. */
function stripExternalFontLinks(html: string): string {
  return html
    .replace(/<link[^>]+fonts\.g?oogleapis[^>]*>/g, "")
    .replace(/<link[^>]+fonts\.gstatic[^>]*>/g, "")
    .replace(/<link[^>]+rel="preconnect"[^>]*>/g, "");
}

function frame(srcdoc: string, index: number, palette: Palette): string {
  const bg = `#${palette.slideBg}`;
  return (
    `<div class="slide" id="s${index}" data-index="${index}">` +
    `<iframe sandbox="allow-scripts" loading="lazy" title="slide ${index + 1}" ` +
    `srcdoc="${escapeSrcdoc(srcdoc)}" style="background:${bg}"></iframe></div>`
  );
}

/**
 * Build the combined deck.html. Deterministic: same inputs → same string.
 */
export function combineDeckHtml(slides: CombineSlide[], opts: CombineOptions): string {
  const palette = PALETTES[opts.theme];
  const frames = slides
    .map((s, i) => frame(stripExternalFontLinks(s.html), i, palette))
    .join("\n");
  const items = slides.map((s, i) => `<a href="#s${i}">${i + 1} · ${escapeText(s.title)}</a>`).join("");
  const shell = {
    pageBg: opts.theme === "dark" ? "#070d18" : "#eef2f7",
    ink: `#${palette.title}`,
    muted: `#${palette.subtitle}`,
    accent: `#${palette.accent}`,
    border: `#${palette.panelBorder}`,
  };
  const total = slides.length;

  return `<!doctype html>
<!-- archify combined deck: self-contained, offline, deterministic. -->
<!-- ← → / space / Home / End page; g toggles the overview grid; #n deep-links. -->
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(opts.deckTitle)}</title>
<style>
  :root { color-scheme: ${opts.theme}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: ${shell.pageBg}; color: ${shell.ink};
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "PingFang TC", sans-serif; }
  header { position: fixed; inset: 0 0 auto 0; display: flex; justify-content: space-between;
           align-items: center; padding: 10px 18px; z-index: 5;
           background: color-mix(in srgb, ${shell.pageBg} 86%, transparent);
           border-bottom: 1px solid ${shell.border}; }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; white-space: nowrap;
              overflow: hidden; text-overflow: ellipsis; }
  header .count { font: 600 12px ui-monospace, monospace; color: ${shell.accent}; }
  .stage { padding-top: 44px; }
  .slide { display: none; margin: 0 auto; width: min(96vw, calc((100vh - 76px) * 16 / 9)); }
  .slide.active { display: block; }
  .slide iframe { display: block; width: 100%; aspect-ratio: 16 / 9; border: 1px solid ${shell.border};
                  border-radius: 8px; background: #fff; }
  body.grid .stage { visibility: hidden; }
  footer { position: fixed; inset: auto 0 0 0; display: flex; justify-content: center; gap: 14px;
           padding: 8px; font: 12px ui-monospace, monospace; color: ${shell.muted};
           border-top: 1px solid ${shell.border};
           background: color-mix(in srgb, ${shell.pageBg} 86%, transparent); }
  footer a { color: ${shell.muted}; text-decoration: none; }
  .grid-nav { display: none; position: fixed; inset: 44px 0 0 0; overflow: auto; padding: 12px 4vw;
              background: ${shell.pageBg}; z-index: 4; }
  body.grid .grid-nav { display: block; }
  .grid-nav a { display: block; margin: 6px 0; color: ${shell.ink}; text-decoration: none;
                font-size: 13px; border-bottom: 1px solid ${shell.border}; padding: 6px 2px; }
  body.grid .stage { visibility: hidden; }
</style></head><body class="paged">
<header><h1>${escapeText(opts.deckTitle)}</h1>
<span class="count"><span id="cur">1</span> / ${total}</span></header>
<nav class="grid-nav">${items}</nav>
<div class="stage">
${frames}
</div>
<footer><span>← → pages · g grid · #n deep-link</span><a href="#" id="top">top</a></footer>
<script>
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  var cur = 0;
  function clamp(n) { return Math.max(0, Math.min(slides.length - 1, n)); }
  function show(n, push) {
    cur = clamp(n);
    slides.forEach(function (s, i) { s.classList.toggle("active", i === cur); });
    document.getElementById("cur").textContent = String(cur + 1);
    if (push) history.replaceState(null, "", "#" + (cur + 1));
    window.scrollTo(0, 0);
  }
  function fromHash() {
    var m = /^#(\\d+)$/.exec(location.hash);
    show(m ? parseInt(m[1], 10) - 1 : 0, false);
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { show(cur + 1, true); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { show(cur - 1, true); e.preventDefault(); }
    else if (e.key === "Home") { show(0, true); }
    else if (e.key === "End") { show(slides.length - 1, true); }
    else if (e.key === "g" || e.key === "G") { document.body.classList.toggle("grid"); }
  });
  window.addEventListener("hashchange", fromHash);
  document.getElementById("top").addEventListener("click", function (e) { e.preventDefault(); show(0, true); });
  fromHash();
</script>
</body></html>`;
}
