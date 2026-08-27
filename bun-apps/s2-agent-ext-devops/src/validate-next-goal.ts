/**
 * validate-next-goal — the machine gate under the self-reflect-next-goal
 * skill's STRICT handoff format (skills/self-reflect-next-goal/SKILL.md).
 *
 * Why a validator: the skill's prose template and the files sessions actually
 * wrote had already drifted (template said "Shipped this session"; files said
 * "Why this goal (honest reflection)"), and NOTHING checked either shape — a
 * missing section or a stale LATEST pointer surfaced only as the next session
 * executing the wrong goal. The format is now one fixed shape, and this module
 * is the definition of "conforms": filename, frontmatter (with the
 * self-identifying ABSOLUTE `file:` path — output/ is per-worktree, so a file
 * must name which tree wrote it), exact ordered sections, the Immediate-steps
 * detail bar (every step explains what the next session will do), the
 * checkbox gate, and the 3–5 ranked queue.
 *
 * Pure logic, no deps: `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts`
 * is the runnable entry; tests import these functions directly.
 */

import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

/** Filename pattern — also the sort key for newest-file resolution and pruning. */
export const NEXT_GOAL_FILENAME_RE = /^next-goal-(\d{8})-(\d{6})\.md$/;

/** The exact section headings, in the exact order the format requires. */
export const REQUIRED_SECTIONS = [
  "## Verified this session",
  "## Honest gaps",
  "## Immediate steps",
  "## Done when",
  "## Ranked next goals",
] as const;

/** The exact frontmatter key set — unknown keys are a violation (strict means strict). */
const REQUIRED_KEYS = ["file", "created", "supersedes"] as const;

/** Rolling retention cap (matches the skill: MAX 10, LATEST symlink excluded). */
export const MAX_RETENTION = 10;

export interface NextGoalCheck {
  name: string;
  ok: boolean;
  /** Human-readable failure detail; present only when !ok (or for soft warnings). */
  detail?: string;
}

export interface NextGoalValidation {
  ok: boolean;
  file: string;
  checks: NextGoalCheck[];
}

/** Parse the leading `---` frontmatter block into key→value lines. */
function parseFrontmatter(source: string): { keys: Record<string, string> | undefined; body: string } {
  if (!source.startsWith("---\n")) return { keys: undefined, body: source };
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) return { keys: undefined, body: source };
  const keys: Record<string, string> = {};
  for (const line of source.slice(4, end).split("\n")) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) keys[m[1]] = m[2].trim();
  }
  return { keys, body: source.slice(end + 5) };
}

function sectionBounds(body: string): number[] {
  return REQUIRED_SECTIONS.map((h) => body.indexOf(`\n${h}\n`) !== -1 ? body.indexOf(h) : -1);
}

/** `1. ` … `5. ` numbered entries under the ranked-goals heading. */
function rankedEntryCount(body: string): number {
  const start = body.indexOf("## Ranked next goals");
  if (start === -1) return 0;
  const rest = body.slice(start);
  const nextH2 = rest.indexOf("\n## ", 1);
  const section = nextH2 === -1 ? rest : rest.slice(0, nextH2);
  return (section.match(/^\d+\.\s+\S/gm) ?? []).length;
}

/**
 * Each numbered Immediate step, first line + its wrapped continuation lines,
 * as one string. A step runs until the next `N. ` entry or the next section
 * heading. Only INDENTED lines join as continuations (a wrapped step body) —
 * column-0 prose after a step is its own paragraph and must NOT lend the
 * step its length (the reviewer's false-pass edge: `1. Fix it.` followed by
 * a long context paragraph would otherwise cross the bar).
 */
function immediateStepTexts(body: string): string[] {
  const start = body.indexOf("## Immediate steps");
  if (start === -1) return [];
  const rest = body.slice(start);
  const nextH2 = rest.indexOf("\n## ", 1);
  const lines = (nextH2 === -1 ? rest : rest.slice(0, nextH2)).split("\n");
  const steps: string[] = [];
  for (const line of lines) {
    if (/^\d+\.\s+\S/.test(line)) steps.push(line.trim());
    else if (steps.length > 0 && /^\s+\S/.test(line)) steps[steps.length - 1] += ` ${line.trim()}`;
  }
  return steps.map((s) => s.replace(/^\d+\.\s+/, ""));
}

/**
 * Minimum substance per Immediate step (chars, wrapped lines joined). The bar
 * the hands-off SOP sets: every step explains WHAT the next session will do —
 * the concrete action, the files/packages it touches, the approach, the gates
 * — so the executor never re-derives context. A bare pointer ("1. Fix it.")
 * cannot cross it.
 */
export const MIN_IMMEDIATE_STEP_CHARS = 80;

/**
 * Validate one next-goal file against the strict format. `absFile` should
 * already be resolved; the frontmatter `file:` value must match it exactly
 * (absolute) — that self-reference is what names the owning worktree.
 */
export function validateNextGoalFile(absFile: string): NextGoalValidation {
  const checks: NextGoalCheck[] = [];
  /** Record a FAILURE (passing checks stay implicit — ok = no entry). */
  const fail = (name: string, detail?: string) => checks.push({ name, ok: false, detail });
  /** Record a non-blocking warning (ok stays true; detail names it). */
  const warn = (name: string, detail: string) => checks.push({ name, ok: true, detail });

  // Exists + filename pattern.
  if (!existsSync(absFile)) {
    return { ok: false, file: absFile, checks: [{ name: "exists", ok: false, detail: "file not found" }] };
  }
  const fm = NEXT_GOAL_FILENAME_RE.exec(basename(absFile));
  if (!fm) {
    fail(
      "filename",
      `basename must match next-goal-YYYYMMDD-HHMMSS.md exactly (got "${basename(absFile)}") — it is the sort key for newest-file resolution and pruning`,
    );
  }

  const source = readFileSync(absFile, "utf8");
  const { keys, body } = parseFrontmatter(source);
  if (keys === undefined) {
    fail("frontmatter", "must open with a --- delimited frontmatter block (file/created/supersedes)");
  }
  if (keys) {
    const missing = REQUIRED_KEYS.filter((k) => !(k in keys));
    if (missing.length) fail("frontmatter-keys", `missing keys: ${missing.join(", ")}`);
    const unknown = Object.keys(keys).filter((k) => !(REQUIRED_KEYS as readonly string[]).includes(k));
    if (unknown.length) fail("frontmatter-unknown-keys", `unknown keys (strict key set): ${unknown.join(", ")}`);
    if ("file" in keys) {
      const selfOk = isAbsolute(keys.file) && resolve(keys.file) === resolve(absFile);
      if (!selfOk) {
        fail(
          "self-abs-path",
          `file: must be the ABSOLUTE path of this file (got "${keys.file}") — it names which worktree's output/ wrote this handoff`,
        );
      }
    }
    if ("created" in keys && fm) {
      // Full timestamp (date AND time) — a date-only `created:` cannot order
      // same-day handoffs; sessions routinely write several files per day.
      const tsStr = `${fm[1].slice(0, 4)}-${fm[1].slice(4, 6)}-${fm[1].slice(6, 8)} ${fm[2].slice(0, 2)}:${fm[2].slice(2, 4)}:${fm[2].slice(4, 6)}`;
      if (keys.created !== tsStr) {
        fail(
          "created-matches-filename",
          `created: must be "${tsStr}" (date AND time, filename-derived — date-only is not enough), got "${keys.created}"`,
        );
      }
    }
    if ("supersedes" in keys) {
      // `none` only for the first file ever; otherwise an ABSOLUTE path.
      const okShape = keys.supersedes === "none" || isAbsolute(keys.supersedes);
      if (!okShape) {
        fail("supersedes-abs-path", `supersedes: must be "none" or an ABSOLUTE predecessor path (got "${keys.supersedes}")`);
      }
      // Soft: the predecessor may legitimately have been pruned at retention.
      else if (keys.supersedes !== "none" && !existsSync(keys.supersedes)) {
        warn("supersedes-exists", `predecessor ${keys.supersedes} no longer exists (pruned at retention?)`);
      }
    }
  }

  // Sections: exact headings, exact order.
  const bounds = sectionBounds(body);
  const missing = REQUIRED_SECTIONS.filter((_, i) => bounds[i] === -1);
  if (missing.length) fail("sections-present", `missing section heading(s): ${missing.join(" | ")}`);
  else {
    const ordered = bounds.every((b, i) => i === 0 || b > bounds[i - 1]);
    if (!ordered) fail("sections-order", "the five section headings must appear in the fixed order");
  }

  // Done when: at least one unchecked box (an all-checked file is a closed
  // record, not an active handoff — write the successor instead).
  const doneWhenIx = body.indexOf("## Done when");
  const doneWhenSection = doneWhenIx === -1 ? "" : body.slice(doneWhenIx);
  const openBoxes = (doneWhenSection.match(/- \[ \]/g) ?? []).length;
  if (openBoxes < 1) {
    fail("done-when-checkboxes", "Done when needs at least one `- [ ]` checkbox the executor can gate on");
  }

  // Immediate steps: ≥1 numbered step, each detailed enough that the executor
  // knows WHAT the next session will do without re-deriving context (the
  // hands-off SOP's "always explain in detail what's next" rule).
  const steps = immediateStepTexts(body);
  if (steps.length < 1) {
    fail("immediate-steps-detail", "Immediate steps needs at least one numbered (`1. `) step — the next session's entry point");
  } else {
    const thin = steps.findIndex((s) => s.length < MIN_IMMEDIATE_STEP_CHARS);
    if (thin !== -1) {
      fail(
        "immediate-steps-detail",
        `Immediate step ${thin + 1} is too thin (${steps[thin].length} < ${MIN_IMMEDIATE_STEP_CHARS} chars) — every step must explain in detail what the next session will do: the concrete action, the files/packages it touches, the approach, and the gates — never a bare pointer`,
      );
    }
  }

  // Ranked next goals: 3–5 numbered entries.
  const ranked = rankedEntryCount(body);
  if (ranked < 3 || ranked > 5) {
    fail("ranked-3-to-5", `Ranked next goals needs 3–5 numbered entries (found ${ranked})`);
  }

  return { ok: checks.every((c) => c.ok), file: absFile, checks };
}

export interface NextGoalDoctor {
  ok: boolean;
  outputDir: string;
  files: string[];
  latest: { symlink: string; target: string | undefined; dangling: boolean } | undefined;
  retention: { count: number; overBy: number };
  validation: NextGoalValidation | undefined;
  problems: string[];
}

/**
 * One-shot health check of an output/ dir: LATEST symlink resolves, points at
 * the NEWEST file (a stale pointer executes the wrong goal), the target
 * validates, and retention is within MAX_RETENTION. `outputDir` is the
 * absolute path of `output/` at a repo root.
 */
export function doctorNextGoal(outputDir: string): NextGoalDoctor {
  const problems: string[] = [];
  const files = existsSync(outputDir)
    ? readdirSync(outputDir)
        .filter((f) => NEXT_GOAL_FILENAME_RE.test(f) && statSync(join(outputDir, f)).isFile())
        .sort() // filename ts = lexicographic = chronological
    : [];

  const symlinkPath = join(outputDir, "LATEST-next-goal.md");
  let latest: NextGoalDoctor["latest"];
  let validation: NextGoalValidation | undefined;

  // lstat, NOT existsSync: existsSync FOLLOWS the link, so a dangling symlink
  // would read as "missing" and the dangling diagnosis would never fire.
  const rawTarget = readlinkOrNone(symlinkPath);
  if (rawTarget === undefined) {
    problems.push("output/LATEST-next-goal.md is missing — EXECUTE reads this symlink first; re-point it at the newest file");
  } else {
    const target = resolve(outputDir, basename(rawTarget));
    const dangling = !existsSync(target);
    latest = { symlink: symlinkPath, target, dangling };
    if (dangling) {
      problems.push(`LATEST-next-goal.md dangles (→ ${rawTarget})`);
    } else {
      const newest = files[files.length - 1];
      if (newest && basename(target) !== newest) {
        problems.push(`LATEST points at ${basename(target)} but the newest file is ${newest} — re-point (ln -sf ${newest} output/LATEST-next-goal.md)`);
      }
      validation = validateNextGoalFile(target);
      if (!validation.ok) {
        problems.push(`LATEST target fails strict validation: ${validation.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
      }
    }
  }

  const overBy = Math.max(0, files.length - MAX_RETENTION);
  if (overBy > 0) problems.push(`retention over cap: ${files.length} files (max ${MAX_RETENTION}) — delete the oldest ${overBy} by filename timestamp`);

  return {
    ok: problems.length === 0,
    outputDir,
    files,
    latest,
    retention: { count: files.length, overBy },
    validation,
    problems,
  };
}

function readlinkOrNone(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}
