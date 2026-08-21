/**
 * deck-lint.ts — checks on a deck's CONTENT, not its file format.
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
 * **Style notes are advisory; a clipped title is not.** `lintDeck` never
 * throws — a style rule that blocks a deliverable teaches people to disable the
 * linter, and one that prints a note gets read. But a note of severity `error`
 * says the deck will come out visibly broken, and `buildDeck` refuses to write
 * one. Today exactly one rule can reach that severity: `title-overflows`, where
 * the action title is wider than its band and the accent rule strikes line two
 * through. That is not a matter of taste, so it does not get a taste-shaped
 * remedy.
 */
import { TITLE_BAND, TYPE_SCALE } from "./deck-theme.ts";
import { normalizeBullets, resolveLayout, type Slide } from "./slide-model.ts";
import { lineCapacityEms, textEms } from "./text-extent.ts";

export interface DeckLintNote {
  /** 1-based slide number; absent for deck-wide notes. */
  slide?: number;
  code:
    | "title-is-a-label"
    | "title-overflows"
    | "too-many-bullets"
    | "bullets-too-deep"
    | "inline-color"
    | "missing-source";
  /** `error` means the deck is broken, not merely unidiomatic — see the header. */
  severity: "error" | "warn" | "info";
  message: string;
}

export interface LintableDeck {
  slides: Slide[];
}

/**
 * How much of the title band one line may use before the estimate stops being
 * trustworthy. `text-extent.ts` is accurate to ±1.7 % on the measured sample;
 * inside this margin the honest answer is "may wrap", so the note drops to a
 * warning rather than blocking a deck that probably fits.
 */
const TITLE_MARGIN = 0.95;

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

/**
 * Will this title wrap out of its band?
 *
 * The band is a fixed-height box with no autofit (`emit-pptx.ts` withholds
 * `fit: "shrink"` from the chrome roles so a `diagram` slide stays byte-
 * identical to the pre-composition builder), and the accent rule is at a fixed
 * y below it. So the budget is exactly ONE line, and the question is whether
 * the title sets wider than one line of the narrower of the two band shapes.
 *
 * The narrower shape is used unconditionally rather than the one this slide
 * will actually get: a title that fits only because the slide happens to carry
 * no takeaway breaks the moment someone adds one, and that is a worse bug to
 * ship than a slightly early warning.
 */
function titleOverflow(slide: Slide): Omit<DeckLintNote, "slide"> | undefined {
  const band = TITLE_BAND.withTakeaway.w <= TITLE_BAND.alone.w
    ? TITLE_BAND.withTakeaway
    : TITLE_BAND.alone;
  const sizePt = TYPE_SCALE.title.sizePt;
  const budget = lineCapacityEms(band.w, sizePt);
  const ems = textEms(slide.title);
  if (ems <= budget * TITLE_MARGIN) return undefined;
  const over = ems > budget;
  return {
    code: "title-overflows",
    severity: over ? "error" : "warn",
    message:
      `title sets about ${ems.toFixed(1)} em against a ${budget.toFixed(1)} em band ` +
      `(${band.w} in at ${sizePt} pt) — ` +
      (over
        ? "it will wrap onto a second line, which the accent rule strikes through; shorten it"
        : "close enough to the edge that it may wrap depending on the font; consider shortening it"),
  };
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

/**
 * Check a deck. Never throws; an empty array means nothing to say. A returned
 * note of severity `error` is a build blocker — `buildDeck` enforces that.
 */
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
    // A statement slide's chrome is drawn WITHOUT a title (the statement is
    // the title), so its `title` never occupies the band and cannot overflow it.
    if (carriesAnArgument && layout !== "statement") {
      const note = titleOverflow(slide);
      if (note) notes.push({ slide: n, ...note });
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
    .map((n) => `${n.severity} ${n.slide ? `slide ${n.slide}: ` : ""}[${n.code}] ${n.message}`)
    .join("\n");
}
