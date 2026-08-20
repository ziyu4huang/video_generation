/**
 * musicgen_binary.ts — resolve + auto-build the `musicgen` Swift CLI.
 *
 * The binary lives at <repoRoot>/swift/musicgen-director/.build/release/musicgen.
 * It is a pure-Swift/MLX executable (NOT a python subprocess). If it is missing
 * we stream `swift build -c release` to the caller's onUpdate hook (it takes
 * minutes the first time) and cache the result in-memory for the session.
 *
 * Resolution order:
 *   1. $MUSICGEN_BIN              (explicit override, e.g. a prebuilt binary)
 *   2. <repoRoot>/swift/musicgen-director/.build/release/musicgen
 * where repoRoot =
 *   1. $MUSICGEN_REPO_ROOT        (explicit override — needed in bundle mode)
 *   2. walk up from this module to the dir containing swift/musicgen-director
 *
 * Mirrors s2-agent-ext-flux2/src/binary.ts (same shape — flux2/ltx/krea2 all
 * follow this pattern for their compiled Swift/MLX binaries). Note: unlike
 * flux2's binary.ts, this package's own ./paths.ts is an UNRELATED module
 * (project/checkpoint path helpers, no `isFile` export) — so `isFile` is a
 * small local helper here instead of an import.
 */
import { dirname, join, resolve as pResolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

export interface ProgressFn {
  (update: { kind: "progress"; text: string }): void;
}

/** stat helper, symlink-aware (local — this package's ./paths.ts has no isFile export). */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

let _cachedBin: string | null = null;

/** Walk up from a starting dir until it contains `swift/musicgen-director`. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "swift", "musicgen-director", "Package.swift"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolve the repo root (explicit env wins; bundle mode must set the env). */
export function resolveRepoRoot(): string {
  if (process.env.MUSICGEN_REPO_ROOT) return pResolve(process.env.MUSICGEN_REPO_ROOT);
  // import.meta.dir is Bun-specific; fall back to cwd.
  const here: string =
    (import.meta as any).dir ?? (typeof __dirname === "string" ? __dirname : process.cwd());
  const found = findRepoRoot(here);
  if (!found) {
    throw new Error(
      "s2-agent-ext-movie-director: cannot locate repo root (swift/musicgen-director not found).\n" +
        "Set MUSICGEN_REPO_ROOT to the repo root, or MUSICGEN_BIN to the musicgen binary.",
    );
  }
  return found;
}

/** The expected binary path. */
export function defaultBinaryPath(repoRoot: string): string {
  return join(repoRoot, "swift", "musicgen-director", ".build", "release", "musicgen");
}

/** Resolve the binary path from env or default. Does NOT verify it exists. */
export function resolveBinaryPath(): string {
  if (process.env.MUSICGEN_BIN && existsSync(process.env.MUSICGEN_BIN)) {
    return pResolve(process.env.MUSICGEN_BIN);
  }
  return defaultBinaryPath(resolveRepoRoot());
}

/** Run `swift build -c release`, streaming progress. Rejects on non-zero exit. */
export async function buildBinary(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const pkgPath = join(repoRoot, "swift", "musicgen-director");
  onProgress?.({ kind: "progress", text: "musicgen binary missing — building (swift build -c release, ~minutes)…" });
  await new Promise<void>((resolveP, rejectP) => {
    const proc = spawn("swift", ["build", "-c", "release", "--package-path", pkgPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lineBuf = { out: "", err: "" };
    const handle = (stream: NodeJS.ReadableStream, key: "out" | "err") => {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        lineBuf[key] += text;
        let nl: number;
        while ((nl = lineBuf[key].indexOf("\n")) >= 0) {
          const line = lineBuf[key].slice(0, nl).trim();
          lineBuf[key] = lineBuf[key].slice(nl + 1);
          if (line) onProgress?.({ kind: "progress", text: line });
        }
      });
    };
    handle(proc.stdout!, "out");
    handle(proc.stderr!, "err");
    proc.on("error", (err) => rejectP(new Error(`swift build failed to spawn: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        onProgress?.({ kind: "progress", text: "musicgen build complete." });
        resolveP();
      } else {
        const tail = (lineBuf.out + lineBuf.err).slice(-2000);
        rejectP(new Error(`swift build exited ${code}\n${tail}`));
      }
    });
  });
  // mlx-swift's SwiftPM target does NOT build the Metal shader library — without
  // it every MLX compute call dies ("Failed to load the default metallib").
  // Compile + colocate mlx.metallib next to the binary. See
  // swift/musicgen-director/scripts/build-metallib.sh (idempotent).
  await buildMetallib(repoRoot, onProgress);
}

/** Build mlx.metallib and place it next to the musicgen binary. Idempotent. */
export async function buildMetallib(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const script = join(repoRoot, "swift", "musicgen-director", "scripts", "build-metallib.sh");
  if (!existsSync(script)) return; // older checkouts without the script — skip silently
  onProgress?.({ kind: "progress", text: "building mlx.metallib (Metal shaders)…" });
  await new Promise<void>((resolveP) => {
    const proc = spawn("bash", [script], { stdio: ["ignore", "pipe", "pipe"] });
    const lineBuf = { out: "", err: "" };
    const handle = (stream: NodeJS.ReadableStream, key: "out" | "err") => {
      stream.on("data", (chunk: Buffer) => {
        lineBuf[key] += chunk.toString();
        let nl: number;
        while ((nl = lineBuf[key].indexOf("\n")) >= 0) {
          const line = lineBuf[key].slice(0, nl).trim();
          lineBuf[key] = lineBuf[key].slice(nl + 1);
          if (line) onProgress?.({ kind: "progress", text: line });
        }
      });
    };
    handle(proc.stdout!, "out");
    handle(proc.stderr!, "err");
    proc.on("error", () => resolveP()); // metallib build is best-effort; don't fail the run
    proc.on("close", () => resolveP());
  });
}

/** Newest mtime (ms) of any .swift file under repoRoot/swift/musicgen-director/Sources. */
function newestSourceMtimeMs(repoRoot: string): number {
  const sourcesDir = join(repoRoot, "swift", "musicgen-director", "Sources");
  let newest = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".swift") && stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  };
  walk(sourcesDir);
  return newest;
}

/**
 * True if the built binary predates the newest .swift source file — i.e. it
 * was NOT rebuilt after the most recent source change (`ensureBinary` only
 * builds when the binary is entirely missing, so a stale cached binary from
 * a prior `swift build` silently persists otherwise). Mirrors
 * s2-agent-ext-flux2/src/binary.ts's isBinaryStale (see that file's header
 * comment on why this matters for check:flags-style drift guards).
 */
export function isBinaryStale(repoRoot: string, bin: string): boolean {
  if (!isFile(bin)) return true;
  const binMtime = statSync(bin).mtimeMs;
  return newestSourceMtimeMs(repoRoot) > binMtime;
}

/**
 * Ensure the musicgen binary exists, building it once if missing. Cached for
 * the process lifetime. Returns the absolute binary path.
 */
export async function ensureBinary(onProgress?: ProgressFn): Promise<string> {
  if (_cachedBin && isFile(_cachedBin)) return _cachedBin;

  const explicit = process.env.MUSICGEN_BIN;
  if (explicit && existsSync(explicit)) {
    _cachedBin = pResolve(explicit);
    return _cachedBin;
  }

  const repoRoot = resolveRepoRoot();
  const bin = defaultBinaryPath(repoRoot);
  if (isFile(bin)) {
    // Binary present — but ensure the mlx metallib is too. A binary built
    // before this fix (or a `swift build` that didn't run build-metallib.sh)
    // will crash on every MLX call without it. Best-effort, non-fatal.
    const metallib = join(dirname(bin), "mlx.metallib");
    if (!isFile(metallib)) {
      try {
        await buildMetallib(repoRoot, onProgress);
      } catch {
        /* best-effort */
      }
    }
    _cachedBin = bin;
    return bin;
  }
  // Missing — build it.
  await buildBinary(repoRoot, onProgress);
  if (!isFile(bin)) {
    throw new Error(
      `musicgen build reported success but binary not found at ${bin}. ` +
        "Check swift build output; set MUSICGEN_BIN to override.",
    );
  }
  _cachedBin = bin;
  return bin;
}
