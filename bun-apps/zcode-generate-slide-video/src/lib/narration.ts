import type { NarrationFile, NarrationSlide } from "./config.ts";

interface ManifestSlide {
  layout?: string;
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  takeaway?: string;
  source?: string;
  bullets?: string[];
  kpis?: { value: string; label: string; note?: string }[];
  items?: { title: string; note?: string }[];
  sides?: { heading: string; bullets: string[] }[];
  quote?: string;
  attribution?: string;
  milestones?: { date: string; label: string; note?: string }[];
  columns?: string[];
  rows?: string[][];
  statement?: string;
  headline?: string;
}

/** Human polyline for one slide, from its manifest fields (order = reading order). */
export function slideToText(slide: ManifestSlide): string {
  const parts: string[] = [];
  if (slide.title) parts.push(slide.title.endsWith(".") ? slide.title : `${slide.title}.`);
  if (slide.subtitle) parts.push(slide.subtitle);
  if (slide.takeaway) parts.push(slide.takeaway.endsWith(".") ? slide.takeaway : `${slide.takeaway}.`);
  for (const b of slide.bullets ?? []) parts.push(b.replace(/[.;]$/, "") + ".");
  for (const k of slide.kpis ?? []) parts.push([k.value, k.label, k.note].filter(Boolean).join(": ") + ".");
  for (const it of slide.items ?? []) parts.push([it.title, it.note].filter(Boolean).join(", ") + ".");
  for (const side of slide.sides ?? []) parts.push(`${side.heading}: ${side.bullets.join("; ")}.`);
  if (slide.quote) parts.push(`Quote: "${slide.quote}" — ${slide.attribution ?? ""}.`);
  for (const m of slide.milestones ?? []) parts.push([m.date, m.label, m.note].filter(Boolean).join(": ") + ".");
  if (slide.rows?.length) parts.push(`${slide.rows.length} rows including ${slide.rows[0]!.join(", ")}.`);
  if (slide.statement) parts.push(slide.statement);
  if (slide.headline) parts.push(slide.headline);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Derive a NarrationFile from a deck manifest — the fallback when no narration.json exists. */
export function deriveNarration(manifest: unknown): NarrationFile {
  const slides = (manifest as { slides?: ManifestSlide[] }).slides ?? [];
  if (!slides.length) throw new Error("deriveNarration: manifest has no slides");
  return {
    slides: slides.map((s, i) => ({
      // Positional: matchSlides pairs derived entries with discovered files by
      // order; the caller rewrites `file` to the real slide names.
      file: `slide-${i + 1}.html`,
      title: s.title,
      text: slideToText(s) || (s.title ? `${s.title}.` : "Untitled slide."),
    })),
  };
}

/**
 * Match narration entries to discovered slide files.
 * Entries may name files explicitly ("slide-3.html") or rely on order.
 * Throws with both lists when counts mismatch and no files are named.
 */
export function matchSlides(files: string[], narration: NarrationFile): NarrationSlide[] {
  return files.map((file, i) => {
    const byFile = narration.slides.find((s) => s.file === file);
    const entry = byFile ?? narration.slides[i];
    if (!entry) {
      throw new Error(
        `no narration entry for ${file} (narration has ${narration.slides.length} entries, ` +
          `${files.length} slides found) — match counts or name every entry's "file".`,
      );
    }
    return { ...entry, file, text: entry.text };
  });
}
