import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Deterministic build-in animation, injected into a TEMP COPY of a slide
 * (never the shipped file). The injection does NOT self-animate: it computes
 * a reveal schedule and exposes window.__zbSeek(tMs) which applies the
 * schedule state for an exact timestamp. The capture loop drives __zbSeek at
 * chosen timestamps and screenshots each state — frame timing is exact and
 * narration-synced, with zero dependency on the browser's frame clock.
 *
 * Two modes, chosen by content:
 * - artifact pages (SVG diagrams): nodes appear left→right in flow order,
 *   each edge after both endpoints — the diagram draws itself.
 * - composed pages: the stage's children (title band, rule, blocks) stagger
 *   in top-down.
 */

const INJECT_CSS = `
html.zvideo [data-node-id], html.zvideo g[data-edge-id], html.zvideo .stage > * { opacity: 0; }
`;

const INJECT_JS = `
(function () {
  try {
    var ITEMS = []; // [{ el, at, fade }]
    function build() {
      var stage = document.querySelector('.stage') || document.body;
      var nodes = [].slice.call(stage.querySelectorAll('[data-node-id]'));
      var uniq = [], seen = {};
      nodes.forEach(function (n) {
        var id = n.getAttribute('data-node-id');
        if (!seen[id]) { seen[id] = 1; uniq.push(n); }
      });
      if (uniq.length) {
        uniq.sort(function (a, b) {
          return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
        });
        var order = {};
        uniq.forEach(function (n, i) {
          order[n.getAttribute('data-node-id')] = i;
          ITEMS.push({ el: n, at: 250 + i * 800, fade: 450 });
        });
        [].slice.call(stage.querySelectorAll('g[data-edge-id]')).forEach(function (g) {
          var f = order[g.getAttribute('data-edge-from')];
          var t = order[g.getAttribute('data-edge-to')];
          var k = Math.max(f == null ? 0 : f, t == null ? 0 : t);
          ITEMS.push({ el: g, at: 250 + (k + 1) * 800 + 200, fade: 350 });
        });
      } else {
        [].slice.call(stage.children).forEach(function (k, i) {
          ITEMS.push({ el: k, at: 200 + i * 300, fade: 350 });
        });
      }
      window.__zbSeek = function (tMs) {
        for (var i = 0; i < ITEMS.length; i++) {
          var it = ITEMS[i];
          var o = (tMs - it.at) / it.fade;
          it.el.style.opacity = o >= 1 ? '' + 1 : o <= 0 ? '0' : String(o);
        }
      };
      var last = 0;
      ITEMS.forEach(function (it) { last = Math.max(last, it.at + it.fade); });
      window.__zbBuildMs = last;
    }
    // Compute after load: the archify viewer's own init blocks the main
    // thread; measuring layout before it settles produces bad order. NO
    // requestAnimationFrame here — headless screenshot mode issues no
    // animation frames, so an rAF gate would never fire.
    function kick() {
      setTimeout(build, 400);
    }
    if (document.readyState === 'complete') kick();
    else window.addEventListener('load', kick);
  } catch (e) { /* a broken injection must never blank a slide */ }
})();
`;

export const INJECT_BLOCK = `<style data-zvideo>${INJECT_CSS}</style><script data-zvideo>document.documentElement.classList.add('zvideo');${INJECT_JS}</script>`;

/** Write an animated render copy of one slide. Returns the copy's path. */
export async function writeAnimatedCopy(slidePath: string, outPath: string): Promise<string> {
  const html = await Bun.file(slidePath).text();
  if (html.includes("data-zvideo")) return outPath; // already injected
  // Composed slides are HTML fragments (no <body>/<html> tags) — appending
  // lands the block inside the implicit body, after the stage exists.
  const injected = html.includes("</body>")
    ? html.replace("</body>", `${INJECT_BLOCK}</body>`)
    : html + INJECT_BLOCK;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, injected);
  return outPath;
}
