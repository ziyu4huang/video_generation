/**
 * svg-theme.ts — archify's CSS-class vocabulary resolved into explicit style
 * tokens, without implementing a CSS engine (effort archify-view-pptx-bun, D3).
 *
 * ## Why a table and not real CSS resolution
 *
 * archify styles its SVG entirely by semantic class (`c-*` component, `t-*`
 * text, `a-*` arrow, `m-*` marker, `s-*` sigil color) whose values come from CSS
 * custom properties that are themselves re-declared per theme AND per visual
 * preset. Resolving that properly means implementing the cascade, custom
 * property inheritance, `color-mix()`, and preset scoping. The vocabulary is
 * bounded — 40 classes — so a hand-derived table is smaller, testable, and makes
 * the exported palette directly controllable. `__tests__/theme-drift.test.ts`
 * fails loudly if a vendored bump introduces a class this table does not know.
 *
 * ## Where the numbers come from (derived 2026-08-21 from
 * `vendored/assets/template.html`, archify@2.12.0)
 *
 * - **dark** = the base `:root, [data-theme="dark"]` block.
 * - **light** = the template's own `@media print` block, which deliberately
 *   forces the FULL light palette "so printing from dark theme doesn't put neon
 *   strokes and translucent dark fills on white paper". A slide deck is
 *   paper-like output, so archify's own print answer is the right anchor here
 *   rather than a palette we invent.
 *
 * **Deliberately not modelled**: the two visual presets (`blueprint`,
 * `signal-flow`) override these variables in the browser. Exports use the base /
 * print palettes regardless of `meta.visual_preset` — preset identity is a
 * screen-viewing concern. This is a recorded decision, not an oversight; revisit
 * it if decks are ever expected to mirror a preset's on-screen tint.
 */

export type Theme = "light" | "dark";

/** A resolved color. `a` is 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A resolved style. `null` means an explicit `none`/`transparent` (paint
 * nothing) — distinct from `undefined`, which means the property was never
 * specified and the consumer's own default applies.
 */
export interface Style {
  fill?: Rgba | null;
  stroke?: Rgba | null;
  strokeWidth?: number;
  /** stroke-dasharray in user units. */
  dash?: number[];
  /** The `color` property — the source of `currentColor` for descendants. */
  color?: Rgba;
  opacity?: number;
}

// ── theme variables ─────────────────────────────────────────────────────────

const DARK_VARS: Record<string, string> = {
  bg: "#020617",
  grid: "#1e293b",
  text: "#ffffff",
  "text-muted": "#94a3b8",
  "text-dim": "#475569",
  mask: "#020617",
  "lane-fill": "rgba(15, 23, 42, 0.22)",
  "lane-stroke": "#334155",
  arrow: "#64748b",
  "arrow-emphasis": "#34d399",
  "frontend-fill": "rgba(8, 51, 68, 0.4)",
  "frontend-stroke": "#22d3ee",
  "backend-fill": "rgba(6, 78, 59, 0.4)",
  "backend-stroke": "#34d399",
  "database-fill": "rgba(76, 29, 149, 0.4)",
  "database-stroke": "#a78bfa",
  "cloud-fill": "rgba(120, 53, 15, 0.3)",
  "cloud-stroke": "#fbbf24",
  "security-fill": "rgba(136, 19, 55, 0.4)",
  "security-stroke": "#fb7185",
  "messagebus-fill": "rgba(251, 146, 60, 0.3)",
  "messagebus-stroke": "#fb923c",
  "external-fill": "rgba(30, 41, 59, 0.5)",
  "external-stroke": "#94a3b8",
};

/** The template's `@media print` palette — see the module header. */
const LIGHT_VARS: Record<string, string> = {
  bg: "#ffffff",
  grid: "transparent",
  text: "#0f172a",
  "text-muted": "#475569",
  "text-dim": "#94a3b8",
  mask: "#ffffff",
  "lane-fill": "rgba(248, 250, 252, 0.65)",
  "lane-stroke": "#cbd5e1",
  arrow: "#94a3b8",
  "arrow-emphasis": "#059669",
  "frontend-fill": "rgba(34, 211, 238, 0.15)",
  "frontend-stroke": "#0891b2",
  "backend-fill": "rgba(52, 211, 153, 0.18)",
  "backend-stroke": "#059669",
  "database-fill": "rgba(167, 139, 250, 0.2)",
  "database-stroke": "#7c3aed",
  "cloud-fill": "rgba(251, 191, 36, 0.18)",
  "cloud-stroke": "#d97706",
  "security-fill": "rgba(251, 113, 133, 0.15)",
  "security-stroke": "#e11d48",
  "messagebus-fill": "rgba(251, 146, 60, 0.15)",
  "messagebus-stroke": "#ea580c",
  "external-fill": "rgba(148, 163, 184, 0.18)",
  "external-stroke": "#64748b",
};

export const THEME_VARS: Record<Theme, Record<string, string>> = {
  light: LIGHT_VARS,
  dark: DARK_VARS,
};

// ── color parsing ───────────────────────────────────────────────────────────

/**
 * Parse the CSS color forms archify actually emits: `#rgb`, `#rrggbb`,
 * `rgb(...)`, `rgba(...)`, `none`, `transparent`, and `currentColor`.
 * Returns `null` for "paint nothing", `undefined` for "unrecognized".
 */
export function parseCssColor(
  value: string | undefined,
  currentColor?: Rgba
): Rgba | null | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "none" || v === "transparent") return null;
  if (v === "currentcolor") return currentColor;
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
        ? { r, g, b, a }
        : undefined;
    }
    return undefined;
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter((s) => s !== "").map((s) => Number.parseFloat(s));
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return { r, g, b, a: a === undefined || !Number.isFinite(a) ? 1 : a };
  }
  return undefined;
}

/** Uppercase 6-digit hex without `#` — the form pptxgenjs wants. */
export function toHex(c: Rgba): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

/**
 * Flatten alpha against a background. PowerPoint shape fills carry a
 * transparency percentage, but archify leans on translucent fills over a page
 * background; compositing them up front keeps exported colors matching what the
 * browser shows.
 */
export function flatten(c: Rgba, bg: Rgba): Rgba {
  const a = c.a;
  return {
    r: c.r * a + bg.r * (1 - a),
    g: c.g * a + bg.g * (1 - a),
    b: c.b * a + bg.b * (1 - a),
    a: 1,
  };
}

// ── the class table ─────────────────────────────────────────────────────────

/**
 * A class's contribution, expressed against theme VARIABLE NAMES so the
 * derivation stays traceable back to the template. Literal values are used only
 * where the template itself hard-codes one.
 */
interface ClassRule {
  fillVar?: string;
  strokeVar?: string;
  colorVar?: string;
  fillLiteral?: string;
  /** `fill: currentColor` — resolved from this element's effective color. */
  fillCurrentColor?: boolean;
  /** `stroke: currentColor` — same, for the stroke channel. */
  strokeCurrentColor?: boolean;
  strokeNone?: boolean;
  fillNone?: boolean;
  strokeWidth?: number;
  dash?: number[];
  opacity?: number;
  /** `vector-effect: non-scaling-stroke` applies to this element's children. */
  nonScalingStrokeChildren?: boolean;
}

/** Every archify SVG class, derived from `vendored/assets/template.html`. */
export const CLASS_RULES: Record<string, ClassRule> = {
  // components / frames
  "c-grid": { strokeVar: "grid", fillNone: true },
  "c-mask": { fillVar: "mask", strokeNone: true },
  "c-bg-rect": { fillVar: "bg" },
  "c-frontend": { fillVar: "frontend-fill", strokeVar: "frontend-stroke" },
  "c-backend": { fillVar: "backend-fill", strokeVar: "backend-stroke" },
  "c-database": { fillVar: "database-fill", strokeVar: "database-stroke" },
  "c-cloud": { fillVar: "cloud-fill", strokeVar: "cloud-stroke" },
  "c-security": { fillVar: "security-fill", strokeVar: "security-stroke" },
  "c-messagebus": { fillVar: "messagebus-fill", strokeVar: "messagebus-stroke" },
  "c-external": { fillVar: "external-fill", strokeVar: "external-stroke" },
  // dashed boundary variants (template hard-codes c-region's fill)
  "c-security-group": { fillNone: true, strokeVar: "security-stroke", dash: [4, 4] },
  "c-region": { fillLiteral: "rgba(251, 191, 36, 0.05)", strokeVar: "cloud-stroke", dash: [8, 4] },
  "c-lane": { fillVar: "lane-fill", strokeVar: "lane-stroke", dash: [6, 6] },
  // text
  "t-primary": { fillVar: "text" },
  "t-muted": { fillVar: "text-muted" },
  "t-dim": { fillVar: "text-dim" },
  "t-frontend": { fillVar: "frontend-stroke" },
  "t-backend": { fillVar: "backend-stroke" },
  "t-database": { fillVar: "database-stroke" },
  "t-cloud": { fillVar: "cloud-stroke" },
  "t-security": { fillVar: "security-stroke" },
  "t-messagebus": { fillVar: "messagebus-stroke" },
  "t-external": { fillVar: "external-stroke" },
  // arrows
  "a-default": { strokeVar: "arrow", fillNone: true },
  "a-emphasis": { strokeVar: "arrow-emphasis", fillNone: true },
  "a-security": { strokeVar: "security-stroke", fillNone: true, dash: [5, 5] },
  "a-dashed": { strokeVar: "database-stroke", fillNone: true, dash: [4, 4] },
  // arrowhead markers
  "m-default": { fillVar: "arrow" },
  "m-emphasis": { fillVar: "arrow-emphasis" },
  "m-security": { fillVar: "security-stroke" },
  "m-dashed": { fillVar: "database-stroke" },
  // sigils: `s-*` sets `color`, `sigil-fill` paints with `currentColor`
  "s-frontend": { colorVar: "frontend-stroke" },
  "s-backend": { colorVar: "backend-stroke" },
  "s-database": { colorVar: "database-stroke" },
  "s-cloud": { colorVar: "cloud-stroke" },
  "s-security": { colorVar: "security-stroke" },
  "s-messagebus": { colorVar: "messagebus-stroke" },
  "s-external": { colorVar: "external-stroke" },
  "sigil-fill": { fillCurrentColor: true, strokeNone: true },
  /**
   * NOT structural — this one bit us. `svg .semantic-sigil` sets
   * `fill:none; stroke:currentColor; stroke-width:1.35; opacity:0.76`, and its
   * UNCLASSED children (the little icon rects/paths/circles) get their paint
   * purely by SVG inheritance. Treating it as decoration left every sigil glyph
   * invisible in the export.
   */
  "semantic-sigil": {
    fillNone: true,
    strokeCurrentColor: true,
    strokeWidth: 1.35,
    opacity: 0.76,
    nonScalingStrokeChildren: true,
  },
};

/** True when this class list makes descendant strokes non-scaling. */
export function hasNonScalingStrokeChildren(classes: string[]): boolean {
  return classes.some((c) => CLASS_RULES[c]?.nonScalingStrokeChildren === true);
}

/** Classes this table knows. Used by the drift guard. */
export function knownClasses(): Set<string> {
  return new Set(Object.keys(CLASS_RULES));
}

/** The page background for a theme — the compositing base for translucent fills. */
export function themeBackground(theme: Theme): Rgba {
  return parseCssColor(THEME_VARS[theme]["bg"]) ?? { r: 255, g: 255, b: 255, a: 1 };
}

/**
 * Resolve a class list into a style. Later classes win on conflicting
 * properties (source order within one element is not meaningful in archify's
 * output — no element carries two paint-bearing classes of the same family).
 *
 * `color` is resolved in a FIRST PASS, before any paint rule runs, because
 * `currentColor` on an element must see that element's own `color` regardless
 * of class order — `class="semantic-sigil s-backend"` sets
 * `stroke: currentColor` in the first class and the color itself in the second.
 * `inheritedColor` is the fallback when no class on this element sets one.
 */
export function resolveStyle(
  classes: string[],
  theme: Theme,
  inheritedColor?: Rgba
): Style {
  const vars = THEME_VARS[theme];
  const style: Style = {};

  // Pass 1 — the `color` property (the source of currentColor).
  let color = inheritedColor;
  for (const cls of classes) {
    const rule = CLASS_RULES[cls];
    if (rule?.colorVar) {
      const c = parseCssColor(vars[rule.colorVar]);
      if (c) {
        color = c;
        style.color = c;
      }
    }
  }

  // Pass 2 — paint.
  for (const cls of classes) {
    const rule = CLASS_RULES[cls];
    if (!rule) continue;
    if (rule.fillNone) style.fill = null;
    if (rule.strokeNone) style.stroke = null;
    if (rule.fillVar) style.fill = parseCssColor(vars[rule.fillVar]) ?? null;
    if (rule.fillLiteral) style.fill = parseCssColor(rule.fillLiteral) ?? null;
    if (rule.fillCurrentColor) style.fill = color;
    if (rule.strokeCurrentColor) style.stroke = color;
    if (rule.strokeVar) style.stroke = parseCssColor(vars[rule.strokeVar]) ?? null;
    if (rule.strokeWidth !== undefined) style.strokeWidth = rule.strokeWidth;
    if (rule.dash) style.dash = rule.dash;
    if (rule.opacity !== undefined) style.opacity = rule.opacity;
  }
  return style;
}

/**
 * SVG's inherited presentation properties, merged parent → child. `own` wins on
 * every property it actually specifies; `undefined` in `own` means "inherit".
 *
 * archify genuinely depends on this: the sigil glyphs are UNCLASSED shapes whose
 * only paint comes from the `.semantic-sigil` group above them.
 */
export function inheritStyle(parent: Style, own: Style): Style {
  const out: Style = {};
  // Explicitly omit absent keys rather than writing `undefined` — callers
  // compare styles structurally, and a key holding undefined is not the same
  // thing as an absent key.
  const pick = <K extends keyof Style>(k: K): void => {
    const v = own[k] !== undefined ? own[k] : parent[k];
    if (v !== undefined) out[k] = v;
  };
  pick("fill");
  pick("stroke");
  pick("strokeWidth");
  pick("dash");
  pick("color");
  pick("opacity");
  return out;
}

/**
 * Overlay inline presentation attributes, which WIN over the class table —
 * archify sets `stroke-width`, `stroke-dasharray`, `fill`, `stroke` and
 * `opacity` inline on top of semantic classes.
 */
export function applyInlineAttrs(
  style: Style,
  read: (name: string) => string | undefined,
  currentColor?: Rgba
): Style {
  const out: Style = { ...style };
  const fill = parseCssColor(read("fill"), currentColor ?? style.color);
  if (fill !== undefined) out.fill = fill;
  const stroke = parseCssColor(read("stroke"), currentColor ?? style.color);
  if (stroke !== undefined) out.stroke = stroke;
  const sw = read("stroke-width");
  if (sw !== undefined) {
    const n = Number.parseFloat(sw);
    if (Number.isFinite(n)) out.strokeWidth = n;
  }
  const dash = read("stroke-dasharray");
  if (dash !== undefined) {
    const parts = dash.split(/[\s,]+/).map((s) => Number.parseFloat(s)).filter(Number.isFinite);
    if (parts.length > 0) out.dash = parts;
  }
  const op = read("opacity");
  if (op !== undefined) {
    const n = Number.parseFloat(op);
    if (Number.isFinite(n)) out.opacity = n;
  }
  const color = parseCssColor(read("color"));
  if (color !== undefined && color !== null) out.color = color;
  return out;
}
