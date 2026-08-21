/**
 * Effort-query Phase 1 — read-only cross-effort `list` (+ search in a later task).
 *
 * Lightweight, dependency-free enumeration + summary over `<cwd>/.planning/`.
 * Reuses the existing parsers `readMap` (map.ts) and `readEffortMeta`
 * (lifecycle.ts) — never re-parses tickets (uses `map.tickets`). Everything is
 * cwd-based and throw-free: each public function returns an `{ ok, error? }`-
 * shaped result and never throws.
 *
 *   enumerateEfforts(cwd)        -> string[]          (effort slugs, sorted)
 *   listEfforts(cwd)             -> EffortListResult  (per-effort summary)
 *   adoptMostRecentActiveEffort(cwd) -> { effort, activeCount } | undefined
 *
 * adoptMostRecentActiveEffort is the bare-`/wayfind` disk fallback: when a
 * session has NO in-memory active effort (fresh process / resumed session —
 * activeEffortBySession is per-process and never restored), it picks the
 * `status: active` effort whose map.md was modified most recently.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readEffortMeta } from "./lifecycle.js";
import { readMap } from "./map.js";
import { computeFrontier } from "./model.js";

// ─── adopt most-recent active effort (bare /wayfind fallback) ────────────────

export interface AdoptedEffort {
  /** The adopted effort slug (its map.md has the newest mtime among active efforts). */
  effort: string;
  /** # of adoptable active efforts on disk (>= 1). */
  activeCount: number;
}

/** Pick the `status: active` effort whose map.md was modified most recently.
 *  Reuses {@link listEfforts} for front-matter parsing (never re-parses);
 *  ranks by map.md mtimeMs with a deterministic tie-break (slug ascending, as
 *  listEfforts returns them). Active efforts without a readable map.md are
 *  not adoptable and not counted. Throw-free: undefined when no active effort
 *  on disk is adoptable. */
export function adoptMostRecentActiveEffort(cwd: string): AdoptedEffort | undefined {
  const candidates: { slug: string; mtimeMs: number }[] = [];
  for (const item of listEfforts(cwd).efforts) {
    if (item.status !== "active") continue;
    try {
      const mtimeMs = statSync(join(cwd, ".planning", item.slug, "map.md")).mtimeMs;
      candidates.push({ slug: item.slug, mtimeMs });
    } catch {
      // no readable map.md — not adoptable, not counted
    }
  }
  let best: { slug: string; mtimeMs: number } | undefined;
  for (const c of candidates) if (!best || c.mtimeMs > best.mtimeMs) best = c;
  return best ? { effort: best.slug, activeCount: candidates.length } : undefined;
}

// ─── types (list action) ─────────────────────────────────────────────────────

export interface EffortTicketCounts {
  open: number;
  closed: number;
  /** Open tickets that carry a `claimed:` label. */
  claimed: number;
}

export interface EffortListItem {
  slug: string;
  /** Manifest `status:` (defaults to "active" when there is no manifest). */
  status: string;
  destination: string;
  ticketCounts: EffortTicketCounts;
  /** # of tickets: open && !claimed && no blockers. */
  frontierSize: number;
  /** # of "Not yet specified" (fog) bullets. */
  fog: number;
  /** Manifest `last:` date, when present. */
  lastModified?: string;
  /** 10-impl: # of stale decisions on this effort (deps changed since last
   *  validation). null = explicitly unavailable; UNSET (undefined) = not
   *  enriched / hermes absent (render emits no token); 0 = clean; N = count.
   *  Enriched at the TOOL layer (async) — the SYNC listEfforts leaves it unset. */
  stale?: number | null;
}

export interface EffortListResult {
  ok: boolean;
  efforts: EffortListItem[];
  error?: string;
}

// ─── enumerateEfforts ────────────────────────────────────────────────────────

/**
 * Enumerate effort slugs under `<cwd>/.planning/`. Directories only (dotfile and
 * file entries skipped), sorted ascending. Throw-free: any fs error -> [].
 */
export function enumerateEfforts(cwd: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(cwd, ".planning"));
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue; // skip dotfiles / hidden dirs
    try {
      if (statSync(join(cwd, ".planning", entry)).isDirectory()) slugs.push(entry);
    } catch {
      // unreadable entry — skip, never fatal
    }
  }
  return slugs.sort((a, b) => a.localeCompare(b));
}

// ─── listEfforts ─────────────────────────────────────────────────────────────

/**
 * List every effort under `<cwd>/.planning/` with a compact per-effort summary
 * (status / ticket counts / frontier size / fog / last-modified). Throw-free:
 * a bad effort (missing map / parse error) is skipped, never fatal; returns
 * `{ ok: false, error }` only on a catastrophic failure.
 */
export function listEfforts(cwd: string): EffortListResult {
  let slugs: string[];
  try {
    slugs = enumerateEfforts(cwd);
  } catch (err) {
    return { ok: false, efforts: [], error: errMsg(err) };
  }

  const efforts: EffortListItem[] = [];
  for (const slug of slugs) {
    try {
      const meta = readEffortMeta(cwd, slug);
      const map = readMap(cwd, slug);
      const tickets = map?.tickets ?? [];
      const openTickets = tickets.filter((t) => t.status === "open");
      const ticketCounts: EffortTicketCounts = {
        open: openTickets.length,
        closed: tickets.filter((t) => t.status === "closed").length,
        claimed: openTickets.filter((t) => t.claimed).length,
      };
      // ONE frontier definition everywhere: computeFrontier (open + unclaimed +
      // every blocker closed) — the hand-rolled `blocking.length === 0` filter
      // this replaced disagreed with /wayfind status whenever a blocker had
      // since closed (ticket 07 trim W4).
      const frontierSize = computeFrontier(tickets).length;
      efforts.push({
        slug,
        status: meta?.status ?? "active",
        destination: map?.destination ?? "",
        ticketCounts,
        frontierSize,
        fog: map?.fog?.length ?? 0,
        ...(meta?.last ? { lastModified: meta.last } : {}),
      });
    } catch {
      // one bad effort must not fail the whole list — skip it
    }
  }
  return { ok: true, efforts };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── search action ───────────────────────────────────────────────────────────
//
// In-memory, dependency-free term-frequency search over every effort's tickets
// + map decisions (+ a synthetic per-effort "destination" decision doc). Field
// weights boost title/resolution/what-to-build/question/acceptance/gist over the
// generic body. Throw-free: a catastrophic failure -> { ok:false, error }.

export type SearchDocKind = "ticket" | "decision";

export interface SearchMatch {
  kind: SearchDocKind;
  effort: string;
  /** Ticket id; set iff kind==="ticket". */
  ticketId?: string;
  title: string;
  /** Ticket status; set iff kind==="ticket". */
  status?: string;
  /** Ticket type; set iff kind==="ticket". */
  type?: string;
  snippet: string;
  score: number;
}

export interface SearchOptions {
  effort?: string;
  status?: "open" | "closed";
  type?: "research" | "prototype" | "grilling" | "task";
  /** Top-K cap; default 10. */
  limit?: number;
}

export interface EffortSearchResult {
  ok: boolean;
  query: string;
  filters: { effort?: string; status?: string; type?: string };
  matches: SearchMatch[];
  /** True when total matches (pre-slice) > limit. */
  truncated: boolean;
  error?: string;
}

const STOP = new Set(
  "the a an and or of to in for on is are be with this that it as at by from we i you not but if then so do does has have had will can should would what which how why when where who".split(
    " ",
  ),
);

/** Lowercase, split on non-alphanumerics, drop length<2 and stop-words. */
function tokenize(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Count exact token matches (tokens already lowercased). */
function countTerm(tokens: string[], term: string): number {
  let n = 0;
  for (const t of tokens) if (t === term) n++;
  return n;
}

// Field weights — title/resolution/whatToBuild rank highest, body lowest.
const W = { title: 8, resolution: 4, whatToBuild: 4, question: 2, acceptance: 2, gist: 2, body: 1 } as const;
type FieldKey = keyof typeof W;
const FIELD_KEYS: FieldKey[] = Object.keys(W) as FieldKey[];

/**
 * Build a snippet around the first whole query-term hit in `body`. Window is
 * [max(0,idx-70), idx+90] with leading/trailing "…" when truncated. Returns ""
 * when no query term is present so the renderer can fall back to the title.
 */
function makeSnippet(body: string, terms: string[]): string {
  const low = body.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return "";
  const start = Math.max(0, idx - 70);
  const end = Math.min(body.length, idx + 90);
  return (start > 0 ? "\u2026" : "") + body.slice(start, end) + (end < body.length ? "\u2026" : "");
}

/** Internal scored index document. */
interface SearchDoc {
  kind: SearchDocKind;
  effort: string;
  ticketId?: string;
  title: string;
  status?: string;
  type?: string;
  /** Weighted field texts (title/resolution/whatToBuild/question/acceptance/gist/body). */
  fields: Record<FieldKey, string>;
  /** Prose concatenated for snippet extraction (title excluded — rendered separately). */
  snippetText: string;
}

function emptyFields(): Record<FieldKey, string> {
  return { title: "", resolution: "", whatToBuild: "", question: "", acceptance: "", gist: "", body: "" };
}

/** Build the full scored index across every effort (tickets + decisions + one
 *  synthetic "destination" decision per effort so effort goals are searchable). */
function buildIndex(cwd: string): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const slug of enumerateEfforts(cwd)) {
    const map = readMap(cwd, slug);
    if (!map) continue;

    for (const t of map.tickets) {
      const acceptance = (t.acceptance ?? []).join(" ");
      const body = (t.blocking ?? []).join(" ");
      docs.push({
        kind: "ticket",
        effort: slug,
        ticketId: t.id,
        title: t.title,
        status: t.status,
        type: t.type,
        fields: {
          ...emptyFields(),
          title: t.title,
          resolution: t.resolution ?? "",
          whatToBuild: t.whatToBuild ?? "",
          question: t.question,
          acceptance,
          body,
        },
        snippetText: [t.question, t.whatToBuild ?? "", t.resolution ?? "", acceptance, body].filter(Boolean).join("\n"),
      });
    }

    for (const d of map.decisions) {
      docs.push({
        kind: "decision",
        effort: slug,
        title: d.title,
        fields: { ...emptyFields(), title: d.title, gist: d.gist },
        snippetText: d.gist,
      });
    }

    // Synthetic decision doc so an effort's destination/notes are searchable.
    const destBody = `${map.destination}\n${map.notes}`;
    docs.push({
      kind: "decision",
      effort: slug,
      title: `${slug} destination`,
      fields: { ...emptyFields(), title: `${slug} destination`, body: destBody },
      snippetText: destBody,
    });
  }
  return docs;
}

/** score = Σ over queryTerms of Σ over fields of countTerm(tokenize(field), qt) * W[field]. */
function scoreDoc(doc: SearchDoc, queryTerms: string[]): number {
  let score = 0;
  for (const key of FIELD_KEYS) {
    const toks = tokenize(doc.fields[key]);
    const w = W[key];
    for (const qt of queryTerms) score += countTerm(toks, qt) * w;
  }
  return score;
}

/**
 * Cross-effort keyword search over tickets + decisions. Field-weighted term
 * frequency; optional effort/status/type filters; top-K ranking with deterministic
 * tie-breaks (score desc, effort asc, ticketId/title asc). Throw-free.
 */
export function searchEfforts(cwd: string, query: string, opts?: SearchOptions): EffortSearchResult {
  const filters: EffortSearchResult["filters"] = {
    effort: opts?.effort,
    status: opts?.status,
    type: opts?.type,
  };
  const queryTerms = tokenize(query);
  try {
    let docs = buildIndex(cwd);

    // Filters (apply before ranking).
    if (opts?.effort) docs = docs.filter((d) => d.effort === opts.effort);
    if (opts?.status) docs = docs.filter((d) => d.kind === "ticket" && d.status === opts.status);
    if (opts?.type) docs = docs.filter((d) => d.kind === "ticket" && d.type === opts.type);

    // Score + drop zero-score docs.
    const scored = docs.map((doc) => ({ doc, score: scoreDoc(doc, queryTerms) })).filter((s) => s.score > 0);

    // Rank: score desc, effort asc, then ticketId asc (tickets) / title asc (decisions).
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const e = a.doc.effort.localeCompare(b.doc.effort);
      if (e !== 0) return e;
      if (a.doc.kind === "ticket" && b.doc.kind === "ticket") {
        return (a.doc.ticketId ?? "").localeCompare(b.doc.ticketId ?? "");
      }
      if (a.doc.kind === "decision" && b.doc.kind === "decision") {
        return a.doc.title.localeCompare(b.doc.title);
      }
      // Mixed at equal score+effort: tickets before decisions (deterministic).
      return a.doc.kind === "ticket" ? -1 : 1;
    });

    const total = scored.length;
    const limit = opts?.limit ?? 10;
    const truncated = total > limit;
    const matches: SearchMatch[] = scored.slice(0, limit).map(({ doc, score }) => ({
      kind: doc.kind,
      effort: doc.effort,
      ...(doc.ticketId !== undefined ? { ticketId: doc.ticketId } : {}),
      title: doc.title,
      ...(doc.status ? { status: doc.status } : {}),
      ...(doc.type ? { type: doc.type } : {}),
      snippet: makeSnippet(doc.snippetText, queryTerms),
      score,
    }));

    return { ok: true, query, filters, matches, truncated };
  } catch (err) {
    return { ok: false, query, filters, matches: [], truncated: false, error: errMsg(err) };
  }
}
