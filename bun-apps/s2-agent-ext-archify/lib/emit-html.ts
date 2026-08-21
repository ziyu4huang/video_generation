/**
 * emit-html.ts — `PlacedBlock[]` → one self-contained composed slide page.
 *
 * The HTML twin of `emit-pptx.ts`: same blocks, same boxes, same type scale, so
 * a composed slide reads the same in a browser and in PowerPoint. Neither
 * emitter measures text — a box is declared and CSS wraps inside it, exactly as
 * PowerPoint wraps inside a text box.
 *
 * ## Which slides come through here (effort decision D4)
 *
 * ONLY composed layouts. A `diagram` slide's `slide-N.html` stays the archify
 * artifact itself, byte-for-byte as before, because that file is what the webui
 * Diagram pane serves and its full-fidelity, interactive behaviour is a property
 * other code already depends on. A `split` slide's diagram is embedded as an
 * `<iframe>` pointing at that same artifact, written beside this page — so it
 * stays interactive there too.
 *
 * That iframe carries `?embed=1&theme=…`, which is the ARTIFACT'S OWN contract,
 * not a trick played on it: `vendored/assets/template.html` reads both params
 * and, for `embed=1`, hides its toolbar, header, cards, footer, nav and overview
 * map, leaving only the diagram surface. Without it a composed slide shows the
 * artifact's whole page UI — its own dark chrome and its own title — crammed
 * into a 60 % column and repeating the title already above it. Verified live in
 * `Bun.WebView`: a `file://` iframe of a sibling file renders (WebKit gives it
 * an opaque origin, so scripts cannot reach across, which is all we need).
 *
 * Self-contained means self-contained: one inline `<style>`, no external font,
 * no CDN, no network reference of any kind. `__tests__/emit-html.test.ts`
 * asserts that.
 *
 * ## The `--pt` trick
 *
 * The stage is 13.333 in = 960 pt wide. `--pt` is one typographic point
 * expressed in container-relative units, so every size in `deck-theme.ts` can be
 * written once, in points, and used unchanged by both emitters:
 *
 *     --pt: calc(100cqw / 960);   font-size: calc(var(--pt) * 26);
 */
import { bulletSizePt, TYPE_SCALE, type Palette, type Role, type Theme } from "./deck-theme.ts";
import type { PlacedBlock } from "./slide-model.ts";

export interface EmitHtmlCtx {
  palette: Palette;
  /** Forced on the embedded artifact so it matches the deck, not localStorage. */
  theme: Theme;
  font: string;
  /** Page `<title>`. */
  title: string;
  /**
   * Diagram `ir` path → how to embed it. Absent entries render as an empty
   * framed area rather than a broken frame.
   */
  diagramSrc: Map<string, DiagramEmbed>;
}

export interface DiagramEmbed {
  /** Sibling artifact filename, e.g. `slide-3.diagram.html`. */
  file: string;
  /**
   * The diagram's own width/height. The frame is shrunk to it and centred, so a
   * wide dataflow does not sit at the top of a tall column with dead space
   * under it. The PPTX side already scales uniformly and centres; this is the
   * HTML half of the same behaviour.
   */
  aspect?: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(4).replace(/\.?0+$/, "")}%`;
}

/** `box:` → the four positioning declarations. */
function place(b: PlacedBlock): string {
  return `left:${pct(b.box.x)};top:${pct(b.box.y)};width:${pct(b.box.w)};height:${pct(b.box.h)}`;
}

const JUSTIFY: Record<string, string> = { top: "flex-start", middle: "center", bottom: "flex-end" };

function typeCss(role: Role, palette: Palette): string {
  const spec = TYPE_SCALE[role];
  const parts = [
    `font-size:calc(var(--pt) * ${spec.sizePt})`,
    `color:#${palette[spec.color]}`,
  ];
  if (spec.bold) parts.push("font-weight:700");
  if (spec.tracking !== undefined) parts.push(`letter-spacing:calc(var(--pt) * ${spec.tracking})`);
  if (spec.lineSpacing !== undefined) parts.push(`line-height:${spec.lineSpacing}`);
  return parts.join(";");
}

/** Render the blocks of ONE composed slide into a standalone page. */
export function emitHtmlSlide(blocks: PlacedBlock[], ctx: EmitHtmlCtx): string {
  const p = ctx.palette;
  const body: string[] = [];

  for (const block of blocks) {
    const c = block.content;
    const align = block.align ?? "left";
    const justify = JUSTIFY[block.valign ?? "top"] ?? "flex-start";

    switch (c.kind) {
      case "panel":
        body.push(
          c.tone === "tag"
            ? `<div class="b panel tag" style="${place(block)}"></div>`
            : `<div class="b panel section" style="${place(block)}"></div>`
        );
        break;

      case "rule":
        body.push(`<div class="b rule" style="${place(block)}"></div>`);
        break;

      case "text":
        body.push(
          `<div class="b tx" style="${place(block)};justify-content:${justify};text-align:${align};${typeCss(
            c.role,
            p
          )}"><span>${esc(c.text)}</span></div>`
        );
        break;

      case "bullets": {
        const items = c.items
          .map((item) => {
            const level = item.level ?? 0;
            const style =
              `font-size:calc(var(--pt) * ${bulletSizePt(level)});` +
              `color:#${level > 0 ? p.muted : p.body};` +
              `margin-left:calc(var(--pt) * ${level * 18})`;
            return `<li style="${style}">${esc(item.text)}</li>`;
          })
          .join("");
        body.push(
          `<div class="b tx" style="${place(block)};justify-content:${justify}">` +
            `<ul style="line-height:${TYPE_SCALE.bullet.lineSpacing ?? 1.35}">${items}</ul></div>`
        );
        break;
      }

      case "diagram": {
        const embed = ctx.diagramSrc.get(c.ir);
        if (!embed) {
          body.push(`<div class="b frame" style="${place(block)}"></div>`);
          break;
        }
        // No `loading="lazy"`: a slide has exactly one diagram and it is always
        // in view, so lazy loading only delays the paint a screenshot races.
        const src = `${embed.file}?embed=1&theme=${ctx.theme}`;
        const ratio =
          embed.aspect && Number.isFinite(embed.aspect) && embed.aspect > 0
            ? `aspect-ratio:${embed.aspect.toFixed(4)};width:100%;height:auto;max-height:100%`
            : "width:100%;height:100%";
        body.push(
          `<div class="b frame" style="${place(block)}">` +
            `<iframe src="${esc(src)}" title="diagram" style="${ratio}"></iframe></div>`
        );
        break;
      }
    }
  }

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ctx.title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:#${p.slideBg}}
.wrap{container-type:inline-size;width:100%;max-width:100vw}
.stage{--pt:calc(100cqw / 960);position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;
  background:#${p.slideBg};font-family:${esc(ctx.font)},system-ui,sans-serif}
.b{position:absolute}
.tx{display:flex;flex-direction:column;overflow:hidden}
.tx>span{display:block;width:100%}
.panel.tag{background:#${p.tagBg};border:1px solid #${p.tagBorder};border-radius:calc(var(--pt) * 6)}
.panel.section{background:#${p.sectionBg}}
.rule{background:#${p.accent}}
/* No border or plate: the embedded artifact paints its own surface, and a
   second frame around a diagram that does not fill it reads as a mismatch. */
.frame{overflow:hidden;display:flex;align-items:center;justify-content:center}
.frame iframe{border:0;display:block;background:transparent}
ul{margin:0;padding:0;list-style:none;width:100%}
li{position:relative;padding-left:calc(var(--pt) * 18);margin:0 0 calc(var(--pt) * 6)}
li::before{content:"";position:absolute;left:0;top:0.55em;width:calc(var(--pt) * 5);
  height:calc(var(--pt) * 5);border-radius:50%;background:#${p.accent}}
</style>
<div class="wrap"><div class="stage">
${body.join("\n")}
</div></div>
`;
}
