/**
 * Session-end handoff for an effort with UNFINISHED tickets — the
 * `/wayfind handoff` half of the standing rule (2026-08-23, user-confirmed):
 * a session never just stops with open wayfind tickets and no next-goal
 * handoff. `/wayfind done` already refuses while the frontier is open (the
 * close is earned); this is the OTHER arm — the session is ending anyway, so
 * carry the open tickets into a next-goal file instead of dropping them.
 *
 * FORMAT CONTRACT: this writes the devops `self-reflect-next-goal` STRICT v2
 * shape — dash filename `next-goal-YYYYMMDD-HHMMSS.md`, frontmatter
 * `file/created/supersedes`, and the five exact headings — so the output
 * passes `bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts` AND is
 * executable by its "hands on next goal" flow. The devops script is the
 * source of truth; {@link assertHandoffShape} below mirrors only its core
 * structural checks (this package is deliberately spawn-free, so we cannot
 * shell out to the validator — drift is caught by tests that pin the shape).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { computeFrontier, type Ticket, type WayfindMap } from "./model.js";

export interface SessionHandoffResult {
  /** Repo-relative path written, e.g. "output/next-goal-20260823-141500.md". */
  path: string;
  /** Open ticket ids carried into the handoff (sorted ascending). */
  openTickets: string[];
  /** Ticket ids on the frontier right now (unblocked + unclaimed). */
  frontier: string[];
  /** Predecessor the frontmatter `supersedes:` points at, or undefined (none). */
  supersedes?: string;
}

export interface HandoffRefused {
  refused: string;
}

/** Canonical v2 filename stamp: local time as YYYYMMDD-HHMMSS (DASH separator
 *  — the devops validator's exact pattern; the underscore variant is wayfind's
 *  legacy `/wayfind done` note and must not be produced here). */
function handoffTimestamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

const LATEST_SYMLINK = join("output", "LATEST-next-goal.md");

/** Resolve the repo-root LATEST pointer to an absolute path, or undefined when
 *  missing/dangling (→ frontmatter `supersedes: none`). */
function resolveSupersedes(cwd: string): string | undefined {
  const link = join(cwd, LATEST_SYMLINK);
  if (!existsSync(link) && !lstatSafe(link)) return undefined;
  try {
    const target = readlinkSync(link);
    return resolve(cwd, "output", target);
  } catch {
    // not a symlink (regular file) — point at it directly
    return resolve(cwd, LATEST_SYMLINK);
  }
}

/** Repoint the repo-root LATEST symlink at the freshly written file (relative
 *  target, per the devops WRITE step 5). Best-effort: symlink support is
 *  optional (some CI filesystems lack it) and a stale pointer degrades to the
 *  newest-by-filename fallback, never to data loss. */
function repointLatest(cwd: string, filename: string): void {
  const link = join(cwd, LATEST_SYMLINK);
  try {
    if (existsSync(link) || lstatSafe(link)) unlinkSync(link);
    symlinkSync(filename, link);
  } catch {
    // best-effort by design — see docstring
  }
}

function lstatSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `output/next-goal-<dash-ts>.md` in strict v2 shape carrying the
 * effort's OPEN tickets. Refuses when there is no map (nothing to hand off)
 * or when no tickets are open (that is `/wayfind done`'s job — two writers
 * for one slot is how the formats drifted apart in the first place).
 */
export function writeSessionHandoff(
  cwd: string,
  effort: string,
  map: WayfindMap,
  now: Date = new Date(),
): SessionHandoffResult | HandoffRefused {
  const open = map.tickets.filter((t) => t.status === "open").sort((a, b) => a.id.localeCompare(b.id));
  if (open.length === 0) {
    return {
      refused: `"${effort}" has no open tickets — nothing to hand off; use /wayfind done (closing ceremony) instead`,
    };
  }
  const frontier = computeFrontier(map.tickets);
  const ts = handoffTimestamp(now);
  const filename = `next-goal-${ts}.md`;
  const relPath = join("output", filename);
  const absPath = join(cwd, relPath);
  const created = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`;
  const supersedes = resolveSupersedes(cwd);

  const body = renderHandoff({
    effort,
    destination: map.destination,
    open,
    frontier,
    fog: map.fog,
    ticketTotal: map.tickets.length,
  });
  const frontmatter = `${["---", `file: ${absPath}`, `created: ${created}`, `supersedes: ${supersedes ?? "none"}`, "---", ""].join("\n")}\n`;

  mkdirSync(join(cwd, "output"), { recursive: true });
  writeFileSync(absPath, frontmatter + body, "utf-8");

  const written = readFileSync(absPath, "utf-8");
  assertHandoffShape(written); // never ship a file our own contract rejects

  repointLatest(cwd, filename);

  return {
    path: relPath,
    openTickets: open.map((t) => t.id),
    frontier: frontier.map((t) => t.id),
    ...(supersedes ? { supersedes: relative(cwd, supersedes) } : {}),
  };
}

function renderHandoff(args: {
  effort: string;
  destination: string;
  open: Ticket[];
  frontier: Ticket[];
  fog: string[];
  ticketTotal: number;
}): string {
  const { effort, destination, open, frontier, fog, ticketTotal } = args;
  const title = `Finish ${destination || effort} — ${open.length} open ticket(s) carried over`;
  const gapLines = open.map(
    (t) => `- **${t.id} ${t.title}** (${t.type}${t.claimed ? `, claimed: ${t.claimed}` : ""}) — ${t.question}`,
  );
  const steps = [
    `1. Sync to origin/main first (\`bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts --mode rebase\`).`,
    frontier.length > 0
      ? `2. Resume effort "${effort}": bare \`/wayfind\` claims the next frontier ticket (${frontier.map((t) => t.id).join(", ")}).`
      : `2. Resume effort "${effort}": every open ticket is blocked or claimed — run \`/wayfind status ${effort}\` and unblock first.`,
    ...open.map(
      (t, i) =>
        `${i + 3}. Resolve ticket ${t.id} ("${t.title}") — one decision per session; record the Resolution + append the map's Decisions.`,
    ),
    `${open.length + 3}. When all tickets are closed, run \`/wayfind done ${effort}\` (canonical close → .planning/done/).`,
  ];
  const doneWhen = open.map((t) => `- [ ] ticket ${t.id} "${t.title}" closed with a recorded resolution`);
  // Ranked list needs 3–5 entries: open tickets first, then fog bullets, then
  // the chart-next fallback pads toward 3.
  const rankedSources: string[] = [
    ...open.map(
      (t) =>
        `**Resolve ticket ${t.id} (${t.title})** — the effort cannot close while it stands; first step: bare \`/wayfind\`.`,
    ),
    ...fog
      .filter((f) => !f.startsWith("<!--"))
      .map((f) => `**Graduate fog**: ${f} — first step: decide if it blocks any open ticket above.`),
    "**Chart the next effort** once this one closes — first step: `/wayfind -- <destination>`.",
  ].slice(0, 5);
  while (rankedSources.length < 3)
    rankedSources.push("**Chart the next effort** — first step: `/wayfind -- <destination>`.");

  return [
    `# Next goal — ${title}`,
    "",
    "## Verified this session",
    "",
    `_(fill before handing off: what actually landed, with evidence — PR number, test run, command output. Tickets closed so far: ${ticketTotal - open.length}/${ticketTotal}.)_`,
    "",
    "## Honest gaps",
    "",
    ...gapLines,
    "",
    "## Immediate steps",
    "",
    ...steps,
    "",
    "## Done when",
    "",
    ...doneWhen,
    "",
    "## Ranked next goals",
    "",
    ...rankedSources.map((r, i) => `${i + 1}. ${r}`),
    "",
  ].join("\n");
}

/** Local mirror of the devops validator's CORE structural checks (exact key
 *  set, exact heading order, ≥1 unchecked box, 3–5 ranked entries). Source of
 *  truth: `bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts`; this
 *  mirror exists because wayfind never spawns processes. Throws on violation. */
export function assertHandoffShape(text: string): void {
  const fail = (why: string) => {
    throw new Error(`handoff shape violation: ${why}`);
  };
  if (!text.startsWith("---\n")) fail("frontmatter missing");
  const end = text.indexOf("\n---\n");
  if (end < 0) fail("frontmatter not closed");
  const lines = text.slice(4, end).split("\n");
  const keys = lines.map((l) => l.split(":")[0]);
  if (lines.length !== 3 || keys.join(",") !== "file,created,supersedes") {
    fail("frontmatter must be exactly file/created/supersedes");
  }
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const expected = ["Verified this session", "Honest gaps", "Immediate steps", "Done when", "Ranked next goals"];
  if (headings.length !== expected.length || expected.some((h, i) => headings[i] !== h)) {
    fail(`headings must be exactly ${expected.join(" / ")}`);
  }
  if (!/^# Next goal — .+/m.test(text)) fail("first heading must be '# Next goal — <title>'");
  const unchecked = (text.match(/^- \[ \] /gm) ?? []).length;
  if (unchecked < 1) fail("'Done when' needs at least one unchecked '- [ ]' box");
  const rankedSection = text.split(/^## Ranked next goals$/m)[1] ?? "";
  const ranked = (rankedSection.match(/^\d+\. /gm) ?? []).length;
  if (ranked < 3 || ranked > 5) fail("'Ranked next goals' needs 3-5 entries");
}

/** Newest-first listing helper shared with future tooling: digits-only sort so
 *  dash and underscore stamps interleave chronologically (raw lexicographic
 *  would rank '-' before '_' regardless of time). */
export function newestNextGoalFiles(cwd: string, keep = 10): string[] {
  const dir = join(cwd, "output");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^next-goal-[0-9]{8}[-_][0-9]{6}\.md$/.test(n) && statSync(join(dir, n)).isFile())
    .sort((a, b) => (digits(b) > digits(a) ? 1 : digits(b) < digits(a) ? -1 : 0))
    .slice(0, keep);
}

const digits = (name: string) => name.replace(/\D/g, "");
