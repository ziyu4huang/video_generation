/**
 * deck-lint.ts — advisory checks on a deck's CONTENT, not its file format.
 *
 * These encode the conventions that separate a deck people can follow from a
 * pile of exhibits. They are consulting-desk practice, and each one is here
 * because it is mechanically checkable:
 *
 *   - **Action titles.** A slide title should state the takeaway as a complete
 *     claim ("Latency is dominated by the cold path"), not name a topic
 *     ("Latency"). Stacked, such titles read as the deck's whole argument —
 *     the "horizontal logic" a reviewer checks first. `storyline()` prints
 *     exactly that stack so a human or an agent can read it in one go.
 *   - **One idea per slide.** More than six bullets, or nesting past one level,
 *     is a slide that should have been two.
 *   - **No inline colour.** archify's Cardinal Rule for diagram IR — semantic
 *     type in, theme colour out — extended to slide copy.
 *
 * **Advisory means advisory.** `lintDeck` never throws and a build never fails
 * on its output. A style rule that blocks a deliverable teaches people to
 * disable the linter; one that prints a note gets read.
 */
import { normalizeBullets, resolveLayout, type Slide } from "./slide-model.ts";

export interface DeckLintNote {
  /** 1-based slide number; absent for deck-wide notes. */
  slide?: number;
  code:
    | "title-is-a-label"
    | "title-too-long"
    | "too-many-bullets"
    | "bullets-too-deep"
    | "inline-color"
    | "missing-source";
  severity: "warn" | "info";
  message: string;
}

export interface LintableDeck {
  slides: Slide[];
}

/** Above this a title stops being a claim and becomes a paragraph. */
const TITLE_MAX = 90;

/**
 * Below this a title is almost certainly a topic label. Counted in CJK-aware
 * units — `Array.from` splits by code point, so "延遲" is 2 and not 6.
 */
const TITLE_LABEL_MAX = 8;

/** One idea per slide; past this it is two slides. */
const BULLETS_MAX = 6;

const HEX_COLOR = /#[0-9a-fA-F]{6}\b/;

function len(s: string): number {
  return Array.from(s).length;
}

/**
 * Does this title assert something?
 *
 * Deliberately crude, and only ever a warning: verb detection across English
 * and Chinese is not something a regex settles. Length is the signal that
 * actually separates "Latency" from "Latency is dominated by the cold path",
 * and a title carrying sentence punctuation is taken at its word.
 */
function readsAsLabel(title: string): boolean {
  if (/[.。!！?？:：,，;；—]/.test(title)) return false;
  return len(title) <= TITLE_LABEL_MAX;
}

/** Every authored string on a slide, for the inline-colour sweep. */
function copyOf(slide: Slide): string[] {
  return [
    slide.title,
    slide.subtitle,
    slide.takeaway,
    slide.source,
    slide.statement,
    slide.eyebrow,
    slide.attribution,
    ...normalizeBullets(slide.bullets).map((b) => b.text),
  ].filter((s): s is string => typeof s === "string");
}

/** Check a deck. Never throws; an empty array means nothing to say. */
export function lintDeck(deck: LintableDeck): DeckLintNote[] {
  const notes: DeckLintNote[] = [];
  deck.slides.forEach((slide, i) => {
    const n = i + 1;
    const layout = resolveLayout(slide);

    // A cover or a divider names a thing on purpose; only content slides carry
    // an argument, so only they are held to the action-title rule.
    const carriesAnArgument = layout !== "title" && layout !== "section";

    if (carriesAnArgument && readsAsLabel(slide.title)) {
      notes.push({
        slide: n,
        code: "title-is-a-label",
        severity: "warn",
        message: `title ${JSON.stringify(slide.title)} names a topic rather than stating a takeaway — an action title lets the deck be read from the titles alone`,
      });
    }
    if (len(slide.title) > TITLE_MAX) {
      notes.push({
        slide: n,
        code: "title-too-long",
        severity: "warn",
        message: `title is ${len(slide.title)} characters (over ${TITLE_MAX}); it will overflow the title band, which does not autofit`,
      });
    }

    const bullets = normalizeBullets(slide.bullets);
    if (bullets.length > BULLETS_MAX) {
      notes.push({
        slide: n,
        code: "too-many-bullets",
        severity: "warn",
        message: `${bullets.length} bullets (over ${BULLETS_MAX}) — one idea per slide; consider splitting`,
      });
    }
    const deepest = bullets.reduce((m, b) => Math.max(m, b.level ?? 0), 0);
    if (deepest > 1) {
      notes.push({
        slide: n,
        code: "bullets-too-deep",
        severity: "warn",
        message: `bullets nest ${deepest + 1} levels deep; the layouts style two, and a third reads as noise`,
      });
    }

    for (const s of copyOf(slide)) {
      const m = HEX_COLOR.exec(s);
      if (!m) continue;
      notes.push({
        slide: n,
        code: "inline-color",
        severity: "warn",
        message: `copy contains the literal colour ${m[0]} — set a semantic role and let the theme paint it (archify's Cardinal Rule)`,
      });
      break;
    }

    if (carriesAnArgument && !slide.source && !slide.subtitle) {
      notes.push({
        slide: n,
        code: "missing-source",
        severity: "info",
        message: "no `source` — an exhibit without attribution is hard to defend in the room",
      });
    }
  });
  return notes;
}

/**
 * The titles, in order. Read top to bottom this is the deck's argument; if it
 * does not hold together here it will not hold together in the room.
 */
export function storyline(deck: LintableDeck): string {
  const width = String(deck.slides.length).length;
  return deck.slides
    .map((s, i) => `${String(i + 1).padStart(width, " ")}. ${s.title}`)
    .join("\n");
}

/** One line per note, for a CLI or a tool result. */
export function formatLintNotes(notes: DeckLintNote[]): string {
  return notes
    .map((n) => `${n.severity === "info" ? "info" : "warn"} ${n.slide ? `slide ${n.slide}: ` : ""}[${n.code}] ${n.message}`)
    .join("\n");
}
