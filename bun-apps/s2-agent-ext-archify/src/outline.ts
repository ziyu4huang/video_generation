/**
 * outline.ts — Markdown outline → DeckManifest (ticket 08).
 *
 * The authoring door for a deck that is mostly prose with a few templates on
 * it: YAML frontmatter carries the deck-level fields, and the body's markers
 * cover the six CODE layouts only —
 *
 *   # H1            title slide (a following `> line` becomes its subtitle)
 *   ## NN Text      section slide, sectionNumber = NN
 *   ### Text        content slide; Text is its action title
 *   ^ text          takeaway        ~ text   source
 *   - / ␣␣-         bullets level 0 / 1
 *   !ir <path>      diagram; WITH bullets ⇒ split, without ⇒ diagram
 *   ```:::<name>    fenced JSON payload → layout <name>, JSON merged as slots
 *
 * That last marker is the ONLY route to a layout template: no marker per
 * template, ever — the dialect would have to grow one every time someone
 * drops a file on the search path. An unknown layout name fails through the
 * registry's available-list message, not a JSON error.
 *
 * Precedence: a fenced payload's explicit layout always wins — the `!ir`
 * split-vs-diagram inference applies only when a slide carries no layout. An
 * `ir` on a template slide that never binds it (`quote`, `bullets`, …) is
 * simply unused.
 *
 * Every failure names its line number: an outline is written top to bottom,
 * so an error should point at the line to fix.
 */
import { isAbsolute, resolve } from "node:path";
import {
  DeckError,
  parseManifest,
  type DeckManifest,
  type DeckSlide,
  type LayoutNames,
} from "./deck-build.ts";
import { loadRegistry } from "./layout-registry.ts";
import type { Theme } from "./deck-theme.ts";

export interface OutlineFrontmatter {
  output?: string;
  theme?: Theme;
  tag?: string;
  defaults?: { font?: string };
}

const FRONTMATTER_KEYS = ["output", "theme", "tag", "defaults"] as const;

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse the `--- … ---` head of an outline. Absent frontmatter is fine. */
export function parseFrontmatter(lines: string[]): { fields: OutlineFrontmatter; end: number } {
  // `end: -1` when absent: the body loop starts at `end + 1`, so a
  // no-frontmatter outline must start at line 0 — never drop the first line.
  if ((lines[0] ?? "").trim() !== "---") return { fields: {}, end: -1 };
  const fields: OutlineFrontmatter = {};
  let inDefaults = false;
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "---") return { fields, end: i };
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new DeckError(
        `outline line ${i + 1}: malformed frontmatter ${JSON.stringify(raw)} — expected \`key: value\``
      );
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const where = `outline line ${i + 1}`;
    if (key === "defaults" && !inDefaults) {
      if (value !== "") {
        throw new DeckError(`${where}: \`defaults\` takes nested keys (\`font:\`), not a value`);
      }
      inDefaults = true;
      fields.defaults = {};
      continue;
    }
    if (inDefaults && /^\s/.test(raw)) {
      if (key !== "font") {
        throw new DeckError(`${where}: unknown \`defaults\` key ${JSON.stringify(key)} — only \`font\``);
      }
      if (value === "") throw new DeckError(`${where}: \`defaults.font\` needs a value`);
      fields.defaults = { ...fields.defaults, font: unquote(value) };
      continue;
    }
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      throw new DeckError(
        `${where}: unknown frontmatter key ${JSON.stringify(key)} — expected one of ${FRONTMATTER_KEYS.join(", ")}`
      );
    }
    if (value === "") {
      throw new DeckError(`${where}: frontmatter key ${JSON.stringify(key)} needs a value`);
    }
    if (key === "theme") {
      if (value !== "light" && value !== "dark") {
        throw new DeckError(`${where}: \`theme\` must be light|dark, got ${JSON.stringify(value)}`);
      }
      fields.theme = value;
    } else {
      (fields as Record<string, string>)[key] = unquote(value);
    }
  }
  throw new DeckError(
    "outline line 1: frontmatter opened with `---` but never closed — add a closing `---`"
  );
}

/** `​```​:::<name>` per the spec table; bare `:::<name>` accepted as the same fence. */
const FENCE_OPEN = /^(?:```)?\s*:::(\S+)$/;
const FENCE_CLOSE = /^(?:```|:::)$/;

function absolutize(p: string, baseDir: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/**
 * Parse an outline document into a manifest.
 *
 * `baseDir` is what `!ir` paths and `output` resolve against — the outline
 * file's own directory when it came from disk (`outlinePath`), the cwd for an
 * inline `outline`. It also scopes the template search path, so a fenced
 * payload naming a template from `$ARCHIFY_TEMPLATES` or `<baseDir>/templates`
 * validates instead of failing.
 */
export function parseOutline(md: string, baseDir: string): DeckManifest {
  const lines = md.split(/\r?\n/);

  const fm = parseFrontmatter(lines);
  const fields = fm.fields;
  // Scoped to baseDir so the fenced-payload check sees the same template set a
  // build from this directory would — one source of truth for the message.
  const registry: LayoutNames = loadRegistry({ manifestDir: baseDir });

  const slides: DeckSlide[] = [];
  /** The slide later markers attach to; undefined before the first heading. */
  let current: DeckSlide | undefined;
  /** True only directly after a `# H1`, waiting for its optional subtitle. */
  let expectingSubtitle = false;

  for (let n = fm.end + 1; n < lines.length; n++) {
    const lineNo = n + 1;
    const line = lines[n]!.trimEnd();

    if (line.trim() === "") continue;

    // ── fenced template payload ──────────────────────────────────────────────
    const open = FENCE_OPEN.exec(line.trim());
    if (open) {
      const name = open[1]!;
      const payloadLines: string[] = [];
      let closedAt = -1;
      for (let m = n + 1; m < lines.length; m++) {
        if (FENCE_CLOSE.test(lines[m]!.trim())) {
          closedAt = m;
          break;
        }
        payloadLines.push(lines[m]!);
      }
      if (closedAt === -1) {
        throw new DeckError(
          `outline line ${n + 1}: fenced \`${open[0]}\` payload is never closed — end it with a closing fence line`
        );
      }
      if (!current) {
        throw new DeckError(
          `outline line ${lineNo}: a fenced payload needs a slide to fill — start one with \`### Action title\` first`
        );
      }
      if (current.layout !== undefined) {
        throw new DeckError(
          `outline line ${lineNo}: this slide already carries a fenced payload (\`${current.layout}\`) — one per slide`
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(payloadLines.join("\n"));
      } catch (e) {
        throw new DeckError(
          `outline line ${n + 2}: fenced payload for \`${name}\` is not valid JSON — ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new DeckError(`outline line ${n + 2}: fenced payload must be a JSON object of slot values`);
      }
      // Mutate in place, like takeaway/source/bullets: the array holds THIS
      // object, so a reassignment would leave the pre-fence slide stranded
      // (no slots, no layout) while the merged object is never pushed.
      Object.assign(current, payload as Partial<DeckSlide>, { layout: name as DeckSlide["layout"] });
      n = closedAt;
      continue;
    }

    // ── headings ─────────────────────────────────────────────────────────────
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      current = { layout: "title", title: h1[1]!.trim() };
      slides.push(current);
      expectingSubtitle = true;
      continue;
    }
    const h2 = /^##\s+(\d+)\s+(.+)$/.exec(line);
    if (h2) {
      current = { layout: "section", title: h2[2]!.trim(), sectionNumber: h2[1]! };
      slides.push(current);
      expectingSubtitle = false;
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      current = { title: h3[1]!.trim() };
      slides.push(current);
      expectingSubtitle = false;
      continue;
    }

    // ── slide-level markers ─────────────────────────────────────────────────
    if (expectingSubtitle && line.startsWith(">")) {
      current!.subtitle = line.replace(/^>\s?/, "").trim();
      expectingSubtitle = false;
      continue;
    }
    if (line.startsWith(">")) {
      throw new DeckError(
        `outline line ${lineNo}: \`> subtitle\` belongs directly under a \`# Title\` heading`
      );
    }

    const needSlide = (): DeckSlide => {
      if (!current) {
        throw new DeckError(
          `outline line ${lineNo}: this marker needs a slide above it — start one with \`# \`, \`## NN \` or \`### \``
        );
      }
      return current;
    };

    if (/^\^/.test(line)) {
      needSlide().takeaway = line.replace(/^\^\s?/, "").trim();
      continue;
    }
    if (/^~/.test(line)) {
      needSlide().source = line.replace(/^~\s?/, "").trim();
      continue;
    }
    const ir = /^!ir\s+(\S+)\s*$/.exec(line.trim());
    if (ir) {
      needSlide().ir = absolutize(ir[1]!, baseDir);
      continue;
    }
    const bullet = /^(\s*)-\s+(.+)$/.exec(line);
    if (bullet) {
      needSlide().bullets = [
        ...(needSlide().bullets ?? []),
        bullet[1]!.length > 0 ? { text: bullet[2]!.trim(), level: 1 } : bullet[2]!.trim(),
      ];
      continue;
    }
    if (/^!/.test(line.trim())) {
      throw new DeckError(
        `outline line ${lineNo}: unknown \`!\` marker ${JSON.stringify(line.trim().split(/\s/)[0])} — only \`!ir <path>\` exists; templates go through a fenced payload`
      );
    }
    if (/^#{4,}/.test(line)) {
      throw new DeckError(
        `outline line ${lineNo}: headings stop at \`###\` — deeper nesting is bullet levels, not slides`
      );
    }
    throw new DeckError(
      `outline line ${lineNo}: unrecognized outline line ${JSON.stringify(line)} — ` +
        `expected a heading (# / ## NN / ###), ^, ~, -, !ir or a ::: fence`
    );
  }

  // `!ir` picks split vs diagram from the presence of bullets — decided at
  // slide close so marker ORDER within a slide does not matter, matching
  // `resolveLayout`'s inference (`ir` alone ⇒ diagram).
  for (const s of slides) {
    if (s.ir !== undefined && s.layout === undefined && (s.bullets?.length ?? 0) > 0) {
      s.layout = "split";
    }
  }

  const manifest: DeckManifest = {
    slides,
    ...(fields.output !== undefined ? { output: fields.output } : {}),
    ...(fields.theme !== undefined ? { theme: fields.theme } : {}),
    ...(fields.tag !== undefined ? { tag: fields.tag } : {}),
    ...(fields.defaults !== undefined ? { defaults: fields.defaults } : {}),
  };

  // One gate for every structural rule (title present, known layout, theme…),
  // reusing parseManifest so tool and CLI cannot grow different messages. The
  // registry adapter supplies the available-list wording for unknown layouts.
  const names = registry.names();
  return parseManifest(JSON.stringify(manifest), `${baseDir} (outline)`, {
    has: (n) => names.includes(n),
    names: () => names,
  });
}
