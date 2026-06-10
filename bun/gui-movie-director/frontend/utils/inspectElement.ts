// DOM element metadata extraction for the inspector

const STYLE_PROPS = [
  "display", "position", "width", "height",
  "overflow", "overflowX", "overflowY",
  "margin", "padding", "flexDirection",
  "flex", "gap", "zIndex", "opacity",
  "visibility", "transform",
];

export interface ElementInfo {
  tag: string;
  id: string | null;
  className: string | null;
  textContent: string | null;
  cssPath: string;
  computedStyles: Record<string, string>;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function buildCssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  const root = document.getElementById("root");

  while (current && current !== root?.parentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
    } else if (current.className && typeof current.className === "string") {
      const classes = current.className.trim().split(/\s+/).filter(Boolean);
      if (classes.length > 0) {
        selector += `.${classes.join(".")}`;
      }
    }
    parts.unshift(selector);
    if (current.id || current === root) break;
    current = current.parentElement;
  }

  return parts.join(" > ");
}

export function inspectElement(el: Element): ElementInfo {
  const computed = window.getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    const val = computed.getPropertyValue(prop);
    if (val) styles[prop] = val;
  }

  const rawText = el.textContent?.trim() || null;

  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: (el.className && typeof el.className === "string") ? el.className.trim() || null : null,
    textContent: rawText ? truncate(rawText, 100) : null,
    cssPath: buildCssPath(el),
    computedStyles: styles,
  };
}
