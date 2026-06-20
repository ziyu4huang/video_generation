/**
 * Worktree-aware (OPTIONAL / best-effort) port derivation.
 *
 * Concurrent worktrees of this repo each run the Bun GUI (`bun run dev`). To let
 * them coexist without colliding on a single port, the PRIMARY worktree keeps the
 * classic 3099 and each LINKED worktree gets a stable port derived from its
 * absolute path. The running port is broadcast via lib/gui-registry.ts and
 * discovered via `bun run gui:port`.
 *
 * Worktree detection is BEST-EFFORT and never throws: a deployment with NO `.git`
 * (e.g. a `dist/` build, CI, a packaged app) is treated as a primary location and
 * uses 3099 — so the app works identically with or without git. Every git touch is
 * guarded; nothing here requires a worktree to exist.
 *
 * Port priority in server.ts: explicit `--port` / `PORT` env > resolveDefaultPort.
 */
import fs from "fs";
import path from "path";
import { REPO_DIR } from "./config";

export const PRIMARY_PORT = 3099;
const PORT_RANGE = 900; // derived ports ∈ [3099, 3998]

/** Stable 32-bit FNV-1a hash of a string (deterministic — no Math.random). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Should this location use the primary port (3099)?
 *
 * True when `.git` is a real DIRECTORY (the primary worktree) OR when there is no
 * `.git` at all (a `dist/` build, non-git dir) — both use the classic 3099. False
 * only when `.git` is a FILE (a linked git worktree), which derives its own port.
 * Never throws: any stat error ⇒ primary.
 */
export function isMainWorktree(repoDir: string = REPO_DIR): boolean {
  try {
    return fs.statSync(path.join(repoDir, ".git")).isDirectory();
  } catch {
    return true; // no .git / unreadable ⇒ treat as primary (3099)
  }
}

/**
 * Stable per-location port: 3099 + (hash(repoDir) % 900) ∈ [3099, 3998].
 * Same path ⇒ same port every launch. Path is normalized first so trailing
 * slashes / `.` segments don't perturb the hash.
 */
export function derivePort(repoDir: string = REPO_DIR): number {
  return PRIMARY_PORT + (hash32(path.resolve(repoDir)) % PORT_RANGE);
}

/**
 * Default port for a location: primary (main worktree OR no-git/dist) → 3099;
 * linked git worktree → derivePort. This is the fallback used when the caller
 * does not pass an explicit `--port` / `PORT`.
 */
export function resolveDefaultPort(repoDir: string = REPO_DIR): number {
  return isMainWorktree(repoDir) ? PRIMARY_PORT : derivePort(repoDir);
}
