/**
 * core/svg-text.ts — structural (text-mode / degrade) SVG extraction.
 *
 * An SVG has no "text layer" in the PDF sense, but its XML carries the
 * semantic text: <title>, <desc>, and the <text>/<tspan> label runs. This
 * module pulls those plus a shape census WITHOUT rendering anything — it is
 * the zero-dependency fallback for text mode and for machines where the
 * WebView rasterizer is unavailable, and the ground-truth base body the
 * smart-mode vision description is appended to.
 *
 * Honesty rule (SKILL.md truth rules): geometry, styling, and layout are
 * lost here and the emitted notice says so — never claim fidelity.
 */

/** Cap on extracted label lines (a label-heavy map can carry thousands). */
export const SVG_LABEL_MAX = 200;

export interface SvgStructure {
  title?: string;
  description?: string;
  /** Deduplicated, order-preserved <text>/<tspan> contents. */
  labels: string[];
  /** element name → occurrence count (shapes + containers). */
  shapes: Record<string, number>;
  /** Raw viewBox attribute when present. */
  viewBox?: string;
  width?: string;
  height?: string;
}

function decodeEntities(s: string): string {
  // &amp; LAST on purpose: decoding it first would double-decode
  // (&amp;lt; must yield &lt;, not <).
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pull one element's inner text (first match), entities decoded, trimmed. */
function innerText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  const text = m?.[1] ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
  return text || undefined;
}

/** Structural extraction from raw SVG text. Never throws; empty fields on garbage. */
export function parseSvgStructure(svgText: string): SvgStructure {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const m of svgText.matchAll(/<(?:text|tspan)\b[^>]*>([\s\S]*?)<\/(?:text|tspan)>/gi)) {
    const t = decodeEntities(m[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      labels.push(t);
    }
  }
  const shapes: Record<string, number> = {};
  for (const m of svgText.matchAll(/<([a-zA-Z]+)(?=[\s/>])/g)) {
    const tag = m[1]!.toLowerCase();
    shapes[tag] = (shapes[tag] ?? 0) + 1;
  }
  const attr = (name: string): string | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(svgText);
    return m?.[1] || undefined;
  };
  return {
    title: innerText(svgText, "title"),
    description: innerText(svgText, "desc"),
    labels,
    shapes,
    viewBox: attr("viewBox"),
    width: attr("width"),
    height: attr("height"),
  };
}

/** Shape elements worth reporting in the census (containers excluded from the table itself). */
const SHAPE_ELEMENTS = [
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "image",
  "use",
  "text",
  "g",
] as const;

/**
 * Structural SVG → markdown-lite: title, metadata, label list, shape census,
 * plus an explicit loss notice. Used by text mode and every raster-degrade path.
 */
export function svgToMarkdown(inputName: string, svgText: string): string {
  const s = parseSvgStructure(svgText);
  const lines: string[] = [`# ${s.title ?? inputName}`, ""];

  const meta: string[] = [];
  if (s.viewBox) meta.push(`viewBox \`${s.viewBox}\``);
  if (s.width || s.height) meta.push(`size \`${s.width ?? "?"} × ${s.height ?? "?"}\``);
  if (meta.length > 0) lines.push(`- ${meta.join(" · ")}`);
  if (s.description) lines.push(`- ${s.description}`);
  if (meta.length > 0 || s.description) lines.push("");

  lines.push(
    "> SVG structural extraction: labels and shape counts preserved; geometry, styling, and layout are lost. Render-capable modes (auto/ocr/vlm/smart) embed the rendered image.",
    "",
  );

  if (s.labels.length > 0) {
    lines.push("## Labels", "");
    for (const label of s.labels.slice(0, SVG_LABEL_MAX)) lines.push(`- ${label}`);
    if (s.labels.length > SVG_LABEL_MAX) {
      lines.push("", `> Label list truncated: ${SVG_LABEL_MAX} of ${s.labels.length} labels.`);
    }
    lines.push("");
  }

  const census = SHAPE_ELEMENTS.filter((el) => (s.shapes[el] ?? 0) > 0).map((el) => `| ${el} | ${s.shapes[el]} |`);
  if (census.length > 0) {
    lines.push("## Shape census", "", "| element | count |", "| --- | --- |", ...census, "");
  }

  if (s.labels.length === 0 && census.length === 0) {
    lines.push(
      "> No text labels or shape elements found — this may not be a readable SVG (binary/svgz inputs are not decoded).",
      "",
    );
  }
  return lines.join("\n");
}
