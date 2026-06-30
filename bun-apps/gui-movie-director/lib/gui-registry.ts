/**
 * Shared registry of running GUI servers — one entry per worktree/location.
 *
 * Broadcast + identify: the server registers on start (server.ts) and unregisters
 * on shutdown; `bun run gui:port` reads it to report THIS location's port and list
 * all others (so an agent never confuses one worktree's server with another's).
 *
 * Location is BEST-EFFORT like lib/worktree.ts: the registry prefers
 * `<git-common-dir>/gui-movie-director-servers.json` (shared across all worktrees
 * of a repo, so any worktree sees all servers). When git is absent (dist build,
 * CI), it falls back to `<repoDir>/.gui-servers.json` — per-instance, still lets
 * `gui:port` discover the local server. Nothing here requires git.
 *
 * Stale-safety: a server killed without unregistering (SIGKILL, crash) leaves a
 * dead entry; readers filter by pid liveness and prune the file on read.
 */
import fs from "fs";
import path from "path";
import { REPO_DIR } from "./config";

export interface ServerEntry {
  root: string; // absolute worktree / location root (the registry key)
  port: number;
  pid: number;
  hostname: string;
  url: string;
  startedAt: number; // epoch ms
}

/** On-disk shape: keyed by root, value is the entry minus the key. */
type RegistryRecord = Omit<ServerEntry, "root">;
type Registry = Record<string, RegistryRecord>;

const REGISTRY_FILENAME = "gui-movie-director-servers.json";

/**
 * Registry file path. Prefers the shared git common-dir (one file for all
 * worktrees); falls back to a per-location file when git is unavailable. Resolved
 * relative to repoDir so the server (writer) and gui:port (reader) agree even in
 * a dist/no-git layout.
 */
export function getRegistryPath(repoDir: string = REPO_DIR): string {
  try {
    const res = Bun.spawnSync(["git", "-C", repoDir, "rev-parse", "--git-common-dir"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const common = res.stdout?.toString().trim();
    if (common && res.exitCode === 0) {
      // common may be relative (".git") or absolute — resolve anchors it to repoDir.
      return path.resolve(repoDir, common, REGISTRY_FILENAME);
    }
  } catch {
    // fall through to per-location fallback
  }
  return path.join(repoDir, ".gui-servers.json");
}

/** True if a process with this pid is currently alive. EPERM ⇒ alive (exists but
 *  signal-denied); ESRCH / other ⇒ dead. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// Test hook: redirect reads/writes to an explicit path (tmp dir in unit tests).
let _overridePath: string | null = null;
export function _setRegistryPathForTest(p: string | null): void {
  _overridePath = p;
}

function registryFile(): string {
  return _overridePath ?? getRegistryPath();
}

function readRaw(): Registry {
  try {
    const f = registryFile();
    if (!fs.existsSync(f)) return {};
    const obj = JSON.parse(fs.readFileSync(f, "utf-8"));
    return obj && typeof obj === "object" ? (obj as Registry) : {};
  } catch {
    return {};
  }
}

function writeRaw(reg: Registry): void {
  const f = registryFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, f); // atomic replace
}

export function registerServer(entry: ServerEntry): void {
  const reg = readRaw();
  const { root, ...rest } = entry;
  reg[root] = rest;
  writeRaw(reg);
}

export function unregisterServer(root: string): void {
  const reg = readRaw();
  if (root in reg) {
    delete reg[root];
    writeRaw(reg);
  }
}

/** All entries whose pid is still alive; rewrites the file pruned of dead entries. */
export function listLiveServers(): ServerEntry[] {
  const reg = readRaw();
  const live: ServerEntry[] = [];
  let pruned = false;
  for (const [root, info] of Object.entries(reg)) {
    if (isPidAlive(info.pid)) {
      live.push({ root, ...info });
    } else {
      pruned = true;
    }
  }
  if (pruned) {
    const cleaned: Registry = {};
    for (const e of live) {
      const { root, ...rest } = e;
      cleaned[root] = rest;
    }
    try {
      writeRaw(cleaned);
    } catch {
      // best-effort prune; readers already filtered in-memory
    }
  }
  return live;
}

export function findOwnServer(root: string): ServerEntry | undefined {
  return listLiveServers().find((s) => s.root === root);
}
