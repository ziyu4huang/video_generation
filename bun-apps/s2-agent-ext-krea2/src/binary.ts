/**
 * binary.ts — resolve + auto-build the `krea2` Swift CLI.
 *
 * The binary lives at <repoRoot>/swift/krea2-image-director/.build/release/krea2.
 * It is a pure-Swift/MLX executable (NOT a python subprocess on the default
 * path). If it is missing we stream `swift build -c release` to the caller's
 * onUpdate hook (it takes minutes the first time) and cache the result
 * in-memory for the session.
 *
 * Resolution order:
 *   1. $KREA2_BIN               (explicit override, e.g. a prebuilt binary)
 *   2. <repoRoot>/swift/krea2-image-director/.build/release/krea2
 * where repoRoot =
 *   1. $KREA2_REPO_ROOT         (explicit override — needed in bundle mode)
 *   2. walk up from this module to the dir containing swift/krea2-image-director
 */
import { dirname, join, resolve as pResolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { isFile } from "./paths.ts";

export interface ProgressFn {
  (update: { kind: "progress"; text: string }): void;
}

let _cachedBin: string | null = null;

/** Walk up from a starting dir until it contains swift/krea2-image-director. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "swift", "krea2-image-director", "Package.swift"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolve the repo root (explicit env wins; bundle mode must set the env). */
export function resolveRepoRoot(): string {
  if (process.env.KREA2_REPO_ROOT) return pResolve(process.env.KREA2_REPO_ROOT);
  const here: string =
    (import.meta as any).dir ?? (typeof __dirname === "string" ? __dirname : process.cwd());
  const found = findRepoRoot(here);
  if (!found) {
    throw new Error(
      "s2-agent-ext-krea2: cannot locate repo root (swift/krea2-image-director not found).\n" +
        "Set KREA2_REPO_ROOT to the repo root, or KREA2_BIN to the krea2 binary.",
    );
  }
  return found;
}

/** The expected binary path. */
export function defaultBinaryPath(repoRoot: string): string {
  return join(repoRoot, "swift", "krea2-image-director", ".build", "release", "krea2");
}

/** Resolve the binary path from env or default. Does NOT verify it exists. */
export function resolveBinaryPath(): string {
  if (process.env.KREA2_BIN && existsSync(process.env.KREA2_BIN)) {
    return pResolve(process.env.KREA2_BIN);
  }
  return defaultBinaryPath(resolveRepoRoot());
}

/** Run `swift build -c release`, streaming progress. Rejects on non-zero exit. */
export async function buildBinary(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const pkgPath = join(repoRoot, "swift", "krea2-image-director");
  onProgress?.({ kind: "progress", text: "krea2 binary missing — building (swift build -c release, ~minutes)…" });
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
        onProgress?.({ kind: "progress", text: "krea2 build complete." });
        resolveP();
      } else {
        const tail = (lineBuf.out + lineBuf.err).slice(-2000);
        rejectP(new Error(`swift build exited ${code}\n${tail}`));
      }
    });
  });
  // mlx-swift's SwiftPM target does NOT build the Metal shader library — without
  // it every MLX compute call dies ("Failed to load the default metallib").
  // krea2 ships scripts/setup-metallib.sh which copies the mlx-swift metallib
  // next to the binary (idempotent; takes a `release|debug` config arg).
  await setupMetallib(repoRoot, "release", onProgress);
}

/**
 * Copy mlx.metallib next to the krea2 binary via setup-metallib.sh. Idempotent
 * + best-effort (a missing script in older checkouts is silently skipped; a
 * build failure is non-fatal so a run never aborts on a shader-copy hiccup).
 */
export async function setupMetallib(
  repoRoot: string,
  config: "release" | "debug",
  onProgress?: ProgressFn,
): Promise<void> {
  const script = join(repoRoot, "swift", "krea2-image-director", "scripts", "setup-metallib.sh");
  if (!existsSync(script)) return;
  onProgress?.({ kind: "progress", text: `staging mlx.metallib (${config})…` });
  await new Promise<void>((resolveP) => {
    const proc = spawn("bash", [script, config], { stdio: ["ignore", "pipe", "pipe"] });
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
    proc.on("error", () => resolveP()); // metallib setup is best-effort
    proc.on("close", () => resolveP());
  });
}

/**
 * Ensure the krea2 binary exists, building it once if missing. Cached for the
 * process lifetime. Returns the absolute binary path.
 */
export async function ensureBinary(onProgress?: ProgressFn): Promise<string> {
  if (_cachedBin && isFile(_cachedBin)) return _cachedBin;

  const explicit = process.env.KREA2_BIN;
  if (explicit && existsSync(explicit)) {
    _cachedBin = pResolve(explicit);
    return _cachedBin;
  }

  const repoRoot = resolveRepoRoot();
  const bin = defaultBinaryPath(repoRoot);
  if (isFile(bin)) {
    // Binary present — but ensure the mlx metallib is too. A binary built
    // before this fix (or a `swift build` that didn't run setup-metallib.sh)
    // will crash on every MLX call without it. Best-effort, non-fatal.
    const metallib = join(dirname(bin), "mlx.metallib");
    if (!isFile(metallib)) {
      try {
        await setupMetallib(repoRoot, "release", onProgress);
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
      `krea2 build reported success but binary not found at ${bin}. ` +
        "Check swift build output; set KREA2_BIN to override.",
    );
  }
  _cachedBin = bin;
  return bin;
}
