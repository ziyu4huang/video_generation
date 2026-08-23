/**
 * Output quality gate for file2md page markdown.
 *
 * `explainPage` returns whatever the VLM streamed (after the reactive
 * `normalizeEmbeds` / `normalizeFrontmatter` repair pass). But "non-empty" is
 * not "good": a page is only marked status="done" when `validatePageMarkdown`
 * passes — the model must have produced a closed frontmatter block with the
 * required keys, the source-image embed, and a non-trivial body.
 *
 * Pure and deterministic: no model, no filesystem. Fully unit-testable.
 *
 * Gate failures are treated as RETRYABLE by the pipeline (via `retryableError`
 * from retry.ts): a stochastic VLM deserves another attempt before a page is
 * recorded as errored.
 */
export interface ValidateOpts {
  /** Expected 1-indexed page number (for context; not strictly enforced). */
  page: number;
  /** Expected profile/kind code (for context; not strictly enforced). */
  kind: string;
  /**
   * Minimum body length in characters. "Body" = everything after the
   * frontmatter block, excluding blank lines and the `![[…]]` embed line.
   * Default 20 — deliberately lenient (real pages are hundreds of chars);
   * the goal is to catch near-empty / hallucination-only output.
   */
  minBodyChars?: number;
}

export interface ValidationFailure {
  ok: false;
  /** Short machine-readable reason, surfaced into the manifest error field. */
  reason: string;
}
export interface ValidationSuccess {
  ok: true;
}
export type ValidationResult = ValidationSuccess | ValidationFailure;

/** Frontmatter keys every page note must declare. */
const REQUIRED_KEYS = ["title", "page", "kind"] as const;

/** Construct a failure. */
function fail(reason: string): ValidationFailure {
  return { ok: false, reason };
}

/**
 * Validate the structure + minimum substance of a page-note markdown string.
 *
 * Checks (in order):
 *  1. Non-empty.
 *  2. Opens with a `---` frontmatter delimiter.
 *  3. Has a closing `---` (frontmatter is closed — a recurring model defect
 *     is an unclosed block; normalizeFrontmatter repairs it, but the gate is
 *     the backstop).
 *  4. The frontmatter declares `title`, `page`, and `kind`.
 *  5. A `![[…]]` image embed is present somewhere (the source-page link).
 *  6. The body (minus frontmatter/embed/blanks) meets `minBodyChars`.
 */
export function validatePageMarkdown(md: string, opts: ValidateOpts): ValidationResult {
  const text = md.trim();
  if (!text) return fail("empty output");

  const lines = text.split(/\r?\n/);

  // 1. opening delimiter
  if (lines[0]?.trim() !== "---") return fail("missing opening frontmatter delimiter (---)");

  // 2. closing delimiter (the next `---` on its own line)
  let closer = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closer = i;
      break;
    }
  }
  if (closer === -1) return fail("unclosed frontmatter (no closing ---)");
  if (closer === 1) return fail("empty frontmatter (no fields between delimiters)");

  // 3. required keys present in the frontmatter block
  const fmBlock = lines.slice(1, closer).join("\n");
  for (const key of REQUIRED_KEYS) {
    const re = new RegExp(`^\\s*${key}\\s*:`, "m");
    if (!re.test(fmBlock)) return fail(`frontmatter missing required key: ${key}`);
  }

  // 4. at least one image embed
  if (!/!\[\[[^\]]+\]\]/.test(text)) return fail("missing ![[...]] image embed");

  // 5. non-trivial body
  const body = lines
    .slice(closer + 1)
    .filter((l) => l.trim() !== "" && !/!\[\[[^\]]+\]\]/.test(l))
    .join("\n")
    .trim();
  const min = opts.minBodyChars ?? 20;
  if (body.length < min) return fail(`body too short (${body.length} < ${min} chars)`);

  return { ok: true };
}
