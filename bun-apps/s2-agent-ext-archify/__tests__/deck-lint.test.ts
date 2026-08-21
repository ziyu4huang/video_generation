import { describe, expect, test } from "bun:test";
import { formatLintNotes, lintDeck, storyline, type DeckLintNote } from "../lib/deck-lint.ts";
import type { Slide } from "../lib/slide-model.ts";

function codes(notes: DeckLintNote[]): string[] {
  return notes.map((n) => n.code);
}

function lint(slide: Slide): string[] {
  return codes(lintDeck({ slides: [slide] }));
}

/** A slide that trips nothing, so each test breaks exactly one rule. */
const CLEAN: Slide = {
  layout: "bullets",
  title: "Cold-path latency is what users actually feel",
  source: "prod traces, 2026-07",
  bullets: ["p99 is 4.2 s", { text: "3.1 s of it is DNS", level: 1 }],
};

test("a well-formed slide produces no notes", () => {
  expect(lint(CLEAN)).toEqual([]);
});

describe("action titles", () => {
  test("a bare topic label is flagged", () => {
    expect(lint({ ...CLEAN, title: "Latency" })).toContain("title-is-a-label");
  });

  test("a short CJK title is measured in characters, not bytes", () => {
    // "延遲" is 2 characters and 6 UTF-8 bytes; a byte-length rule would call
    // this a full sentence and say nothing.
    expect(lint({ ...CLEAN, title: "延遲" })).toContain("title-is-a-label");
  });

  test("a CJK sentence is accepted", () => {
    expect(lint({ ...CLEAN, title: "冷路徑延遲才是使用者真正感受到的問題" })).not.toContain(
      "title-is-a-label"
    );
  });

  test("sentence punctuation is taken at its word", () => {
    // Verb detection across languages is not a regex's job; punctuation is the
    // author saying "this is a claim", so the rule defers to it.
    expect(lint({ ...CLEAN, title: "延遲：冷路徑" })).not.toContain("title-is-a-label");
  });

  test("covers and dividers are exempt — they name a thing on purpose", () => {
    expect(lint({ layout: "title", title: "Q3 Review" })).toEqual([]);
    expect(lint({ layout: "section", title: "Findings" })).toEqual([]);
  });

  test("an over-long title is flagged, because the title band does not autofit", () => {
    expect(lint({ ...CLEAN, title: "x".repeat(120) })).toContain("title-too-long");
  });
});

describe("one idea per slide", () => {
  test("more than six bullets is flagged", () => {
    const many = Array.from({ length: 7 }, (_, i) => `point ${i}`);
    expect(lint({ ...CLEAN, bullets: many })).toContain("too-many-bullets");
  });

  test("exactly six is not", () => {
    const six = Array.from({ length: 6 }, (_, i) => `point ${i}`);
    expect(lint({ ...CLEAN, bullets: six })).not.toContain("too-many-bullets");
  });

  test("a third nesting level is flagged; a second is not", () => {
    expect(lint({ ...CLEAN, bullets: [{ text: "deep", level: 2 }] })).toContain(
      "bullets-too-deep"
    );
    expect(lint({ ...CLEAN, bullets: [{ text: "ok", level: 1 }] })).not.toContain(
      "bullets-too-deep"
    );
  });
});

describe("the Cardinal Rule extends to slide copy", () => {
  test("a literal hex colour anywhere in the copy is flagged once", () => {
    const notes = lintDeck({
      slides: [{ ...CLEAN, takeaway: "paint it #FF0000", bullets: ["also #00FF00"] }],
    });
    expect(codes(notes).filter((c) => c === "inline-color")).toHaveLength(1);
  });

  test("prose that merely contains a # is not", () => {
    expect(lint({ ...CLEAN, takeaway: "see issue #1767" })).not.toContain("inline-color");
  });
});

describe("attribution", () => {
  test("a content slide with neither source nor subtitle gets an info note", () => {
    const notes = lintDeck({ slides: [{ ...CLEAN, source: undefined }] });
    expect(codes(notes)).toContain("missing-source");
    expect(notes.find((n) => n.code === "missing-source")!.severity).toBe("info");
  });

  test("a legacy manifest's `subtitle` counts as attribution", () => {
    expect(lint({ ...CLEAN, source: undefined, subtitle: "prod traces" })).not.toContain(
      "missing-source"
    );
  });
});

describe("storyline", () => {
  test("prints the titles in order — the deck's argument, read alone", () => {
    const deck = {
      slides: [
        { title: "Users feel the cold path" },
        { title: "DNS is 3.1 s of it" },
        { title: "Caching the resolver halves p99" },
      ],
    };
    expect(storyline(deck)).toBe(
      "1. Users feel the cold path\n2. DNS is 3.1 s of it\n3. Caching the resolver halves p99"
    );
  });

  test("numbers align once a deck passes nine slides", () => {
    const deck = { slides: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}` })) };
    const lines = storyline(deck).split("\n");
    expect(lines[0]).toBe(" 1. t0");
    expect(lines[9]).toBe("10. t9");
  });
});

test("lintDeck never throws on a malformed slide", () => {
  // It is advisory. A style checker that can fail a build teaches people to
  // switch it off; one that prints a note gets read.
  expect(() => lintDeck({ slides: [{ title: "" }, { title: "x" }] })).not.toThrow();
});

test("formatLintNotes prints severity, slide and code", () => {
  const notes = lintDeck({ slides: [{ ...CLEAN, title: "Latency" }] });
  expect(formatLintNotes(notes)).toStartWith("warn slide 1: [title-is-a-label]");
});
