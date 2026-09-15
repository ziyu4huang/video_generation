/**
 * Child-session journal (t01, self-arc-27) — the D8 durability layer for
 * NAMED persistent children. After each settled exchange the LiveAgent's
 * `FileEntry[]` transcript is atomically rewritten to
 * `<home>/.pi/subagents/sessions/<name>.jsonl` (raw pi session format: the
 * session header first, then the entries — parseable by pi's own
 * `parseSessionEntries`/`loadEntriesFromFile`, restorable through
 * `SessionManager.inMemory(cwd, undefined, entries)`). On dispatch, a journal
 * whose header matches gives a restarted parent's same-name child its
 * history back (t02).
 *
 * Best-effort by contract: every fs error is caught and degraded
 * (persist → no-op, load → undefined). A journal failure must never reach
 * the exchange result or the dispatch path. Names outside
 * `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` silently disable journaling (D6) —
 * the guard kills path traversal at this boundary instead of tightening the
 * tool schema.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, FileEntry } from "@earendil-works/pi-coding-agent";
import { subagentHomeDir } from "./subagent-run-persistence.js";

/** Sessions subdir under the subagent state home (`~/.pi/subagents/sessions`). */
export const SUBAGENT_SESSIONS_SUBDIR = "sessions";

/** Journal-safe name charset (D6). Outside it: persist/load are no-ops. */
export const JOURNAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Default last-N journal retention (mirrors the runs layer, D7). */
export const DEFAULT_MAX_JOURNALS = 200;

export function subagentSessionsDir(home?: string): string {
  return join(subagentHomeDir(home), SUBAGENT_SESSIONS_SUBDIR);
}

/** Minimal fs layer — injectable for tests (mirrors the runs persistence). */
export interface JournalFsLayer {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  statSync: typeof statSync;
  writeFileSync: typeof writeFileSync;
}

export interface CreateChildSessionJournalOptions {
  /** State home root (defaults to the real user home). */
  home?: string;
  /** Last-N journal retention. Default 200 (D7). */
  maxEntries?: number;
  /** Injectable fs (tests). */
  fsOverride?: Partial<JournalFsLayer>;
  /** Injectable clock for retention determinism (tests). */
  now?: () => number;
}

export interface ChildSessionJournal {
  /** Atomically rewrite `<name>.jsonl` with the session's header + entries. */
  persist(name: string, session: AgentSession): void;
  /** Parsed entries ONLY when a session header AND ≥1 non-header entry
   *  survive; missing/unreadable/empty/headerless → undefined. */
  load(name: string): FileEntry[] | undefined;
  /** Absolute journal file path (no fs access — for tests/receipts). */
  pathFor(name: string): string;
}

export function createChildSessionJournal(options: CreateChildSessionJournalOptions = {}): ChildSessionJournal {
  const fs = {
    existsSync: options.fsOverride?.existsSync ?? existsSync,
    mkdirSync: options.fsOverride?.mkdirSync ?? mkdirSync,
    readFileSync: options.fsOverride?.readFileSync ?? readFileSync,
    readdirSync: options.fsOverride?.readdirSync ?? readdirSync,
    renameSync: options.fsOverride?.renameSync ?? renameSync,
    rmSync: options.fsOverride?.rmSync ?? rmSync,
    statSync: options.fsOverride?.statSync ?? statSync,
    writeFileSync: options.fsOverride?.writeFileSync ?? writeFileSync,
  };
  const maxJournals = options.maxEntries ?? DEFAULT_MAX_JOURNALS;
  const sessionsDir = subagentSessionsDir(options.home);

  const pathFor = (name: string): string => join(sessionsDir, `${name}.jsonl`);

  const sweep = (): void => {
    try {
      if (!fs.existsSync(sessionsDir)) return;
      const files = fs
        .readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(join(sessionsDir, f)).mtimeMs;
          } catch {
            // unreadable entry sorts oldest — eviction candidate
          }
          return { f, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const stale of files.slice(maxJournals)) {
        try {
          fs.rmSync(join(sessionsDir, stale.f));
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
  };

  return {
    pathFor,

    persist(name: string, session: AgentSession): void {
      try {
        if (!JOURNAL_NAME_RE.test(name)) return;
        const lines = [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()];
        const payload = lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        fs.mkdirSync(sessionsDir, { recursive: true });
        // Atomic rewrite: tmp + rename — a crash mid-write never leaves a
        // half journal (D1).
        const tmp = `${pathFor(name)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, pathFor(name));
        sweep();
      } catch {
        // best-effort (contract): a journal failure never fails an exchange
      }
    },

    load(name: string): FileEntry[] | undefined {
      try {
        if (!JOURNAL_NAME_RE.test(name)) return undefined;
        const file = pathFor(name);
        if (!fs.existsSync(file)) return undefined;
        const raw = fs.readFileSync(file, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim() !== "");
        const parsed = lines
          .map((line) => {
            try {
              return JSON.parse(line) as FileEntry;
            } catch {
              return undefined; // malformed line → skipped (pi's parser does the same)
            }
          })
          .filter((e): e is FileEntry => e !== undefined);
        const header = parsed.find((e) => (e as { type?: string }).type === "session");
        const rest = parsed.filter((e) => e !== header);
        // A journal is restorable only with a header AND ≥1 real entry
        // (t02 test-d: headerless-but-nonempty → fresh).
        if (!header || rest.length === 0) return undefined;
        return parsed;
      } catch {
        return undefined;
      }
    },
  };
}
