/**
 * Cross-page context accumulator (S1).
 *
 * Today `explainPage` runs each page as a fresh session with zero knowledge of
 * earlier pages, so terminology, section awareness, and the doc title are lost
 * across pages — the single biggest coherence lever for multi-page docs.
 *
 * `PageContext` is a pure, deterministic accumulator (no model call): it feeds
 * on each completed page's normalized markdown, extracts a compact snapshot
 * (doc title, running section, key terms from headings + bold), and exposes a
 * snapshot to thread into the NEXT page's user message. Single-image docs never
 * feed it (opt-out), so their path is unchanged.
 *
 * All extraction is structural (frontmatter + markdown tokens) — cheap, pure,
 * and fully unit-testable.
 */

export interface PageContextSnapshot {
  /** Document title (taken from page 1's frontmatter, kept stable). */
  title?: string;
  /** Running section (latest non-empty frontmatter `section`, e.g. for papers). */
  section?: string;
  /** Key term tokens harvested from headings + bold, deduped, capped. */
  terms: string[];
}

/** Max distinct terms retained across the whole document. */
export const TERM_CAP = 10;
/** Minimum token length to count as a "term". */
const MIN_TERM_LEN = 2;

/** Parse the leading YAML-ish frontmatter into a flat string map. */
function parseFrontmatter(md: string): Record<string, string> {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "---") break; // closing delimiter
    const m = /^([\w.-]+)\s*:\s*(.*)$/.exec(t);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Return the body = everything after the frontmatter block (or all if none). */
function bodyAfterFrontmatter(md: string): string {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return md;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return md;
}

/**
 * Harvest significant term tokens from a page body: markdown headings and
 * `**bold**` phrases, split on common delimiters, deduped (case-insensitive),
 * with pure-number and too-short tokens dropped. Capped at `cap`.
 */
export function extractTerms(body: string, cap: number = TERM_CAP): string[] {
  const candidates: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (h) candidates.push(h[1]!);
  }
  for (const m of body.matchAll(/\*\*(.+?)\*\*/g)) candidates.push(m[1]!);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const cand of candidates) {
    for (const raw of cand.split(/[/,;:|()[\]{}—–]+/)) {
      const t = raw.trim().replace(/[*_`]/g, "");
      if (t.length < MIN_TERM_LEN) continue;
      if (/^\d+(\.\d+)?$/.test(t)) continue; // pure numbers
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(t);
      if (terms.length >= cap) return terms;
    }
  }
  return terms;
}

/** Extract a context snapshot from one page's normalized markdown. */
export function extractContext(md: string): PageContextSnapshot {
  const fm = parseFrontmatter(md);
  const body = bodyAfterFrontmatter(md);
  return {
    title: fm.title || undefined,
    section: fm.section || undefined,
    terms: extractTerms(body),
  };
}

/**
 * Stateful accumulator across the pages of ONE document.
 *
 * Usage: create one per doc; after each page succeeds, `feed()` its markdown;
 * before each page, read `snapshot()` for the context derived from all PRIOR
 * pages and thread it into that page's user message.
 */
export class PageContext {
  private title?: string;
  private section?: string;
  private terms: string[] = [];
  private seenTerms = new Set<string>();

  /** Incorporate one page's extracted context. Returns that page's snapshot. */
  feed(md: string): PageContextSnapshot {
    const snap = extractContext(md);
    // Keep the FIRST title seen (the cover page) so it stays stable.
    if (snap.title && !this.title) this.title = snap.title;
    // Running section = the latest non-empty one.
    if (snap.section) this.section = snap.section;
    for (const t of snap.terms) {
      const key = t.toLowerCase();
      if (this.seenTerms.has(key)) continue;
      this.seenTerms.add(key);
      this.terms.push(t);
      if (this.terms.length >= TERM_CAP) break;
    }
    return snap;
  }

  /** Accumulated context from prior pages, to hand to the NEXT page. */
  snapshot(): PageContextSnapshot {
    return { title: this.title, section: this.section, terms: [...this.terms] };
  }

  /** True when nothing has been accumulated yet (page 1, or all-empty pages). */
  get empty(): boolean {
    return !this.title && !this.section && this.terms.length === 0;
  }
}

/**
 * Format a snapshot into a compact 繁中 context preamble for a page's user
 * message. Returns undefined when the snapshot carries nothing (so page 1 and
 * single-image docs are unaffected).
 */
export function formatContext(snap: PageContextSnapshot): string | undefined {
  const parts: string[] = [];
  if (snap.title) parts.push(`標題=${snap.title}`);
  if (snap.section) parts.push(`目前章節=${snap.section}`);
  if (snap.terms.length) parts.push(`已知術語=${snap.terms.join("、")}`);
  if (parts.length === 0) return undefined;
  return `前文脈絡（請保持用詞一致）：${parts.join("  ·  ")}`;
}
