export interface FigureDetectOpts {
  /** A page with < this fraction of the median text length is "figure-bearing". */
  densityFraction?: number;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const FIG_TOKEN = /\b(Figure|Fig\.?)\s+\d/i;

/**
 * Heuristic figure-page detector. pdfimages returns nothing for vector figures
 * (common in academic PDFs), so we infer figure-bearing pages from text density:
 * a page far shorter than the median, or one that names a Figure, is routed to
 * the VLM in `hybrid` mode.
 */
export function detectFigurePages(pages: { pageNo: number; text: string }[], opts: FigureDetectOpts = {}): Set<number> {
  const frac = opts.densityFraction ?? 0.5;
  const lens = pages.map((p) => p.text.trim().length);
  const med = median(lens);
  const floor = med * frac;
  const out = new Set<number>();
  for (const p of pages) {
    const len = p.text.trim().length;
    if (len < floor || FIG_TOKEN.test(p.text)) out.add(p.pageNo);
  }
  return out;
}
