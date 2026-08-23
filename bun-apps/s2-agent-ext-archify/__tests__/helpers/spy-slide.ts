/**
 * spy-slide.ts — a recording `SlideLike`, shared by every mapper/emitter test.
 *
 * Lives in `helpers/` rather than inside a `.test.ts`: importing a test file
 * from another test file silently re-runs its whole suite.
 *
 * `addImage` is present on purpose. The package's central acceptance property is
 * that nothing is ever rasterized, and you cannot assert the ABSENCE of a call
 * on a spy that has no way to record it.
 */
import type { SlideLike, TextRun } from "../../lib/pptx-shapes.ts";

export interface SpyCall {
  fn: "addShape" | "addText" | "addImage" | "addTable" | "addNotes";
  type?: string;
  text?: string | TextRun[];
  /** `addTable` only: the cell rows as passed. */
  rows?: unknown;
  opts: Record<string, unknown>;
}

export interface SpySlide extends SlideLike {
  calls: SpyCall[];
  background?: unknown;
  addImage(opts: Record<string, unknown>): void;
  addTable(rows: unknown, opts: Record<string, unknown>): void;
  addNotes(text: string): void;
}

export function spySlide(): SpySlide {
  const calls: SpyCall[] = [];
  return {
    calls,
    addShape(type, opts) {
      calls.push({ fn: "addShape", type, opts });
    },
    addText(text, opts) {
      calls.push({ fn: "addText", text, opts });
    },
    addImage(opts) {
      calls.push({ fn: "addImage", opts });
    },
    addTable(rows, opts) {
      calls.push({ fn: "addTable", rows, opts });
    },
    addNotes(text) {
      calls.push({ fn: "addNotes", text, opts: {} });
    },
  };
}

/** Every `addText` call whose payload is a plain string. */
export function textCalls(slide: SpySlide): { text: string; opts: Record<string, unknown> }[] {
  return slide.calls
    .filter((c) => c.fn === "addText" && typeof c.text === "string")
    .map((c) => ({ text: c.text as string, opts: c.opts }));
}

/** Every `addTable` call: the cell rows plus the options they were placed with. */
export function tableCalls(slide: SpySlide): { rows: unknown; opts: Record<string, unknown> }[] {
  return slide.calls
    .filter((c) => c.fn === "addTable")
    .map((c) => ({ rows: c.rows, opts: c.opts }));
}

/** Every string that reaches the slide, including the runs of a bullet list. */
export function allText(slide: SpySlide): string[] {
  const out: string[] = [];
  for (const c of slide.calls) {
    if (c.fn !== "addText") continue;
    if (typeof c.text === "string") out.push(c.text);
    else if (Array.isArray(c.text)) for (const run of c.text) out.push(run.text);
  }
  return out;
}
