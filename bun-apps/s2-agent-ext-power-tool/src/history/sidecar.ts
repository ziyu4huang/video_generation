/**
 * Environment sidecar — the ONLY new write path in the history subsystem.
 *
 * Records exactly the facts a transcript cannot reconstruct: which commit was
 * checked out, which s2-agent version ran, and which tools were loaded. NO derived
 * metric is ever written here. Storing a computed rate would freeze it against
 * whatever thresholds were current that day, and the whole point of deriving
 * everything else is that a threshold change re-derives the entire history
 * consistently.
 *
 * Written at session_start, NOT session_shutdown: shutdown does not fire on a crash
 * or `kill -9`, and long sessions that die are among the most diagnostic ones.
 * Everything needed is already known at start.
 *
 * Every write is best-effort and swallows its errors — a diagnostic tool must never
 * break the session it is diagnosing.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { argsSig } from "../pathology/detector.ts";

export interface SidecarRecord {
  sessionId: string;
  /** epoch ms */
  ts: number;
  cwd: string;
  /**
   * HEAD at session start. Deliberately the ONLY version field: the s2-agent and
   * SDK versions are pinned in package.json inside this repo, so the commit
   * already determines them. A separate `piVersion` was tried and removed — it
   * had no runtime source at session_start and would have shipped as a
   * permanently-null column, which reads as a bug rather than as redundancy.
   */
  gitSha: string | null;
  /** Stable, order-independent signature of the loaded tool names. */
  toolFingerprint: string;
  toolCount: number;
}

export interface BuildInput {
  sessionId: string;
  ts: number;
  cwd: string;
  toolNames: string[];
  gitSha?: string | null;
}

/** Default sidecar location. */
export function defaultSidecarPath(home = homedir()): string {
  return join(home, ".pi", "agent", "power-tool", "env.jsonl");
}

/**
 * Build one record. The tool fingerprint reuses argsSig() — the same canonicalize +
 * bounded-truncate + FNV disambiguation the detector already provides — rather than
 * adding a second hash util to the package.
 */
export function buildSidecarRecord(input: BuildInput): SidecarRecord {
  const names = [...input.toolNames].sort();
  return {
    sessionId: input.sessionId,
    ts: input.ts,
    cwd: input.cwd,
    gitSha: input.gitSha ?? null,
    toolFingerprint: argsSig(names),
    toolCount: names.length,
  };
}

/** Resolve HEAD for a working directory. Returns null on any failure. */
export function resolveGitSha(cwd: string): string | null {
  try {
    const out = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (out.exitCode !== 0) return null;
    const sha = out.stdout.toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Append one record. Never throws. */
export function writeSidecar(
  path: string,
  record: SidecarRecord,
  opts: { mkdir?: boolean } = {},
): void {
  try {
    if (opts.mkdir !== false) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort by design — see the header.
  }
}

/** Read the sidecar, indexed by sessionId. Missing file → empty map. */
export function readSidecar(path: string): Map<string, SidecarRecord> {
  const out = new Map<string, SidecarRecord>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as SidecarRecord;
      if (rec?.sessionId) out.set(rec.sessionId, rec);
    } catch {
      // skip malformed lines silently
    }
  }
  return out;
}
