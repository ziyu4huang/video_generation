/**
 * binary.ts — resolve + auto-build the `ltx-video` Swift CLI.
 *
 * The binary lives at <repoRoot>/swift/ltx-video-director/.build/release/ltx-video.
 * It is a pure-Swift/MLX executable (NOT a python subprocess, except where the
 * CLI itself still bridges to run.py internally for `i2v`/`upscale` — see
 * swift/ltx-video-director/PLAN.md). If it is missing we stream
 * `swift build -c release` to the caller's onUpdate hook (it takes minutes the
 * first time) and cache the result in-memory for the session.
 *
 * Resolution order:
 *   1. $LTX_VIDEO_BIN         (explicit override, e.g. a prebuilt binary)
 *   2. <repoRoot>/swift/ltx-video-director/.build/release/ltx-video
 * where repoRoot =
 *   1. $LTX_VIDEO_REPO_ROOT   (explicit override — needed in bundle mode)
 *   2. walk up from this module to the dir containing swift/ltx-video-director
 */
import { dirname, join, resolve as pResolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { isFile } from "./paths.ts";

export interface ProgressFn {
  (update: { kind: "progress"; text: string }): void;
}

let _cachedBin: string | null = null;

/** Walk up from a starting dir until it contains `swift/ltx-video-director`. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "swift", "ltx-video-director", "Package.swift"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolve the repo root (explicit env wins; bundle mode must set the env). */
export function resolveRepoRoot(): string {
  if (process.env.LTX_VIDEO_REPO_ROOT) return pResolve(process.env.LTX_VIDEO_REPO_ROOT);
  // import.meta.dir is Bun-specific; fall back to cwd.
  const here: string =
    (import.meta as any).dir ?? (typeof __dirname === "string" ? __dirname : process.cwd());
  const found = findRepoRoot(here);
  if (!found) {
    throw new Error(
      "pi-agent-ext-ltx: cannot locate repo root (swift/ltx-video-director not found).\n" +
        "Set LTX_VIDEO_REPO_ROOT to the repo root, or LTX_VIDEO_BIN to the ltx-video binary.",
    );
  }
  return found;
}

/** The expected binary path. */
export function defaultBinaryPath(repoRoot: string): string {
  return join(repoRoot, "swift", "ltx-video-director", ".build", "release", "ltx-video");
}

/** Run `swift build -c release`, streaming progress. Rejects on non-zero exit. */
export async function buildBinary(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const pkgPath = join(repoRoot, "swift", "ltx-video-director");
  onProgress?.({ kind: "progress", text: "ltx-video binary missing — building (swift build -c release, ~minutes)…" });
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
        onProgress?.({ kind: "progress", text: "ltx-video build complete." });
        resolveP();
      } else {
        const tail = (lineBuf.out + lineBuf.err).slice(-2000);
        rejectP(new Error(`swift build exited ${code}\n${tail}`));
      }
    });
  });
  // mlx-swift's SwiftPM target does NOT build the Metal shader library — without
  // it every MLX compute call dies ("Failed to load the default metallib").
  // Compile + colocate mlx.metallib next to the binary via the package's own
  // setup-metallib.sh (mirrors flux2's build-metallib.sh convention, see
  // pi-agent-ext-flux2/src/binary.ts — the script is just named differently
  // here). Only runs if the script exists — older checkouts silently skip.
  await buildMetallib(repoRoot, onProgress);
}

/** Build mlx.metallib and place it next to the ltx-video binary. Idempotent. */
export async function buildMetallib(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const script = join(repoRoot, "swift", "ltx-video-director", "scripts", "setup-metallib.sh");
  if (!existsSync(script)) return; // no such script yet in this package — skip silently
  onProgress?.({ kind: "progress", text: "building mlx.metallib (Metal shaders)…" });
  await new Promise<void>((resolveP) => {
    const proc = spawn("bash", [script, "release"], { stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * Ensure the ltx-video binary exists, building it once if missing. Cached for
 * the process lifetime. Returns the absolute binary path.
 */
export async function ensureBinary(onProgress?: ProgressFn): Promise<string> {
  if (_cachedBin && isFile(_cachedBin)) return _cachedBin;

  const explicit = process.env.LTX_VIDEO_BIN;
  if (explicit && existsSync(explicit)) {
    _cachedBin = pResolve(explicit);
    return _cachedBin;
  }

  const repoRoot = resolveRepoRoot();
  const bin = defaultBinaryPath(repoRoot);
  if (isFile(bin)) {
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
      `ltx-video build reported success but binary not found at ${bin}. ` +
        "Check swift build output; set LTX_VIDEO_BIN to override.",
    );
  }
  _cachedBin = bin;
  return bin;
}
